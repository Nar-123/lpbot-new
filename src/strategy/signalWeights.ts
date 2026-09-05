/**
 * Self-tuning signal weights — ported from meridian-rs
 * (backend/src/signal_weights.rs). Pure statistics, no LLM: for each
 * candidate/pool signal (market cap, volume, age, pool TVL, pool volume,
 * pool volume/TVL ratio, pool fee), compute its "lift" — how much higher
 * its average normalized value was in WINS versus LOSSES, using real closed
 * -position history. Signals in the top lift quartile get their scoring
 * weight nudged up; the bottom quartile gets nudged down — both bounded by
 * a floor/ceiling so no signal can ever be driven to zero or dominate
 * outright. Requires minSamplesPerClass wins AND losses to touch anything;
 * with too little history yet, weights are left exactly as configured.
 *
 * This tunes THIS codebase's existing candidate/pool scoring weights
 * (MULTI_POOL_*_WEIGHT in multiConfig.ts) — it never invents a new scoring
 * formula, and a signal this module doesn't recognize is left untouched.
 */

export type SignalName =
  | 'marketCapUsd'
  | 'volume6hUsd'
  | 'ageHours'
  | 'poolTvlUsd'
  | 'poolVolumeUsd'
  | 'poolVolumeTvlRatio'
  | 'poolFee';

export const ALL_SIGNAL_NAMES: readonly SignalName[] = [
  'marketCapUsd',
  'volume6hUsd',
  'ageHours',
  'poolTvlUsd',
  'poolVolumeUsd',
  'poolVolumeTvlRatio',
  'poolFee',
];

/** One closed position's entry-time signal snapshot + realized outcome. */
export type PerformanceRecord = {
  signals: Partial<Record<SignalName, number>>;
  /** Realized net USD (withdrawal + fees minus deposit). Sign decides win/loss. */
  realizedUsd: number;
  closedAt: number;
};

export type SignalWeights = Partial<Record<SignalName, number>>;

export type WeightTuningConfig = {
  /** Minimum wins AND losses required in the window before touching anything. */
  minSamplesPerClass: number;
  /** Only records within this many days of "now" are considered. */
  windowDays: number;
  /** Multiplier applied to a top-quartile-lift signal's weight per recalculation. */
  boostFactor: number;
  /** Multiplier applied to a bottom-quartile-lift signal's weight per recalculation. */
  decayFactor: number;
  /** No weight may ever be nudged below this floor. */
  floor: number;
  /** No weight may ever be nudged above this ceiling. */
  ceiling: number;
};

export function defaultWeightTuningConfig(): WeightTuningConfig {
  return {
    minSamplesPerClass: 5,
    windowDays: 30,
    boostFactor: 1.1,
    decayFactor: 0.9,
    floor: 0.05,
    ceiling: 1.0,
  };
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Min-max normalizes one signal's values across ALL records (wins + losses
 * together) to [0, 1] before comparing win/loss means — otherwise a signal
 * with a naturally huge numeric range (market cap in the millions) would
 * dominate lift purely from scale, not from actually separating wins from
 * losses. A signal with zero variance across the whole set has no
 * discriminating information and is skipped — never divided by zero, never
 * fabricated as "no lift".
 */
function normalizeSignal(records: PerformanceRecord[], signal: SignalName): (number | null)[] {
  const raw = records.map((r) => r.signals[signal] ?? null);
  const known = raw.filter((v): v is number => v != null);
  if (known.length === 0) return raw.map(() => null);
  const min = Math.min(...known);
  const max = Math.max(...known);
  if (max === min) return raw.map(() => null);
  return raw.map((v) => (v == null ? null : (v - min) / (max - min)));
}

/**
 * Lift for one signal: mean(normalized value | win) minus mean(normalized
 * value | loss). Positive lift means higher values of this signal tend to
 * coincide with wins. Returns null (never 0) when either class has zero
 * known values for this signal — "no data" must never be conflated with
 * "no relationship found".
 */
export function computeLift(records: PerformanceRecord[], signal: SignalName): number | null {
  const normalized = normalizeSignal(records, signal);
  const wins: number[] = [];
  const losses: number[] = [];
  records.forEach((r, i) => {
    const v = normalized[i];
    if (v == null) return;
    if (r.realizedUsd > 0) wins.push(v);
    else losses.push(v);
  });
  if (wins.length === 0 || losses.length === 0) return null;
  return mean(wins) - mean(losses);
}

/**
 * Recalculates weights from real closed-position history. Requires
 * minSamplesPerClass wins AND losses in the window — with too little
 * history, returns the input weights completely unchanged (never guesses
 * with insufficient data). Ranks signals with a known (non-null) lift into
 * quartiles; top quartile is boosted, bottom quartile is decayed, the
 * middle is left alone — all results clamped to [floor, ceiling]. A signal
 * absent from currentWeights is left absent (never invents a weight for a
 * signal the caller doesn't already score on).
 */
export function recalculateWeights(
  currentWeights: SignalWeights,
  allRecords: PerformanceRecord[],
  config: WeightTuningConfig = defaultWeightTuningConfig(),
): SignalWeights {
  const cutoff = Date.now() - config.windowDays * 24 * 60 * 60 * 1000;
  const records = allRecords.filter((r) => r.closedAt >= cutoff);

  const wins = records.filter((r) => r.realizedUsd > 0).length;
  const losses = records.filter((r) => r.realizedUsd <= 0).length;
  if (wins < config.minSamplesPerClass || losses < config.minSamplesPerClass) {
    return { ...currentWeights };
  }

  const scored = ALL_SIGNAL_NAMES.filter((s) => currentWeights[s] != null)
    .map((signal) => ({ signal, lift: computeLift(records, signal) }))
    .filter((s): s is { signal: SignalName; lift: number } => s.lift != null)
    .sort((a, b) => b.lift - a.lift);

  if (scored.length < 4) {
    // Too few scoreable signals for a meaningful quartile split — leave
    // weights untouched rather than boosting/decaying everything.
    return { ...currentWeights };
  }

  const quartileSize = Math.max(1, Math.floor(scored.length / 4));
  const topSignals = new Set(scored.slice(0, quartileSize).map((s) => s.signal));
  const bottomSignals = new Set(scored.slice(-quartileSize).map((s) => s.signal));

  const next: SignalWeights = { ...currentWeights };
  for (const signal of ALL_SIGNAL_NAMES) {
    const current = currentWeights[signal];
    if (current == null) continue;
    let updated = current;
    if (topSignals.has(signal)) updated = current * config.boostFactor;
    else if (bottomSignals.has(signal)) updated = current * config.decayFactor;
    next[signal] = Math.min(config.ceiling, Math.max(config.floor, updated));
  }
  return next;
}

/**
 * Orchestration wrapper: reads real closed-position history + the last
 * persisted weights (or the operator's configured defaults if this is the
 * first run ever), recalculates, and persists the result. Best-effort and
 * side-effect-only — wrapped in try/catch by every caller (see
 * tpslWatcher.ts/bot.ts's close paths) so a recalculation failure can never
 * block or fail an actual position close; this is telemetry-driven tuning,
 * never on the critical path of moving funds.
 */
export async function recalculateAndPersistWeights(chainId: import('../config.js').SupportedChainId): Promise<void> {
  const { getSignalPerformanceHistory, getTunedSignalWeights, setTunedSignalWeights } = await import(
    '../db/index.js'
  );
  const { loadMultiConfig } = await import('./multiConfig.js');
  const config = loadMultiConfig(chainId);
  const baseline: SignalWeights = {
    poolTvlUsd: config.poolTvlWeight,
    poolVolumeUsd: config.poolVolumeWeight,
    poolVolumeTvlRatio: config.poolVolumeTvlWeight,
    poolFee: config.poolFeeWeight,
  };
  const current = getTunedSignalWeights() ?? baseline;
  const records = getSignalPerformanceHistory(chainId).map((r) => ({
    signals: r.signals as SignalWeights,
    realizedUsd: r.realizedUsd,
    closedAt: r.closedAt,
  }));
  const next = recalculateWeights(current, records);
  setTunedSignalWeights(next);
}
