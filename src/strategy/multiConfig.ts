import { type Address, isAddress } from 'viem';
import { CHAINS, isSupportedChainId, type SupportedChainId } from '../config.js';
import { getTunedSignalWeights } from '../db/index.js';
import type { GmgnTrendingInterval } from '../gmgn/cli.js';
import type { StrategyName } from './types.js';

/**
 * Named range-width presets — inspired by meridian-rs's `target_downside_pct`
 * concept (a target price-coverage percentage for the single-sided range),
 * adapted for operators who'd rather pick "tight/normal/wide" than reason
 * about a raw percentage. Unlike meridian-rs's DLMM liquidity SHAPES
 * (spot/curve/bid-ask — a Meteora-bin-specific concept with no Uniswap v3
 * equivalent in a single position, since v3 liquidity within one tick range
 * is always uniform), this is purely a WIDTH choice — the one part of
 * meridian's range strategy that has a direct, faithful analogue here.
 */
export type MultiRangePreset = 'tight' | 'normal' | 'wide' | 'custom';

const RANGE_PRESETS: Record<Exclude<MultiRangePreset, 'custom'>, number> = {
  tight: 15,
  normal: 50,
  wide: 80,
};

/**
 * MULTI_RANGE_PERCENT (explicit) always wins when set — zero behavior change
 * for any existing operator who already configured a raw percentage before
 * presets existed. Only when it's unset does MULTI_RANGE_PRESET (default
 * 'normal', i.e. today's 50% default) pick the width instead.
 */
function resolveRangePercent(): { percent: number; preset: MultiRangePreset } {
  const explicit = process.env.MULTI_RANGE_PERCENT?.trim();
  if (explicit) {
    return { percent: envNum('MULTI_RANGE_PERCENT', 50), preset: 'custom' };
  }
  const raw = (process.env.MULTI_RANGE_PRESET ?? 'normal').trim().toLowerCase();
  const preset: MultiRangePreset = raw === 'tight' || raw === 'wide' ? raw : 'normal';
  return { percent: RANGE_PRESETS[preset], preset };
}

export type MultiConfig = {
  enabled: boolean;
  disabledReason?: string;
  chainId: SupportedChainId;
  /**
   * Which GMGN trending window candidates are screened from —
   * MULTI_CANDIDATE_INTERVAL, one of GmgnTrendingInterval's values
   * ('1m'|'5m'|'1h'|'6h'|'24h'). SUB-FASE 3C: default '5m' on this branch
   * (deliberately a faster/higher-risk profile than master, which keeps
   * '6h' — no attempt is made to reconcile the two). Flows straight
   * through to fetchAndFilterCandidates' fetcher call
   * (multiCandidates.ts) and into MultiPositionMeta.candidateInterval
   * (multiExecute.ts) — never hardcoded at either of those points.
   */
  interval: GmgnTrendingInterval;
  minMarketCapUsd: number;
  minTokenAgeHours: number;
  /**
   * Operator-chosen floor (USD) on candidate.volumeUsd, ON TOP OF the
   * always-on, non-configurable requirement that volume be strictly
   * positive (see multiCandidates.ts's VOLUME_NON_POSITIVE check — a
   * "trending" token reporting $0 or negative 6h volume is a data-integrity
   * failure, not a risk-tolerance choice, so that check is not gated by this
   * config value). Default $200,000 (operator-set, not env-unset) — set
   * MULTI_MIN_CANDIDATE_VOLUME_USD=0 explicitly to disable this floor
   * entirely and fall back to "genuinely nonzero positive volume occurred"
   * as the only requirement.
   */
  minCandidateVolumeUsd: number;
  /**
   * Operator-chosen floor on candidate.kolCount (GMGN's renowned_count —
   * see multiCandidates.ts). Default 10, and the comparison is GREATER
   * THAN OR EQUAL TO this floor (inclusive — kolCount == minKolCount
   * PASSES, matching the field's own name) — see multiCandidates.ts's
   * KOL_COUNT_TOO_LOW check. Set MULTI_MIN_KOL_COUNT=0 explicitly to
   * disable this floor entirely (no candidate is ever rejected on KOL
   * grounds while it is 0, including a null/unknown kolCount).
   */
  minKolCount: number;
  topN: number;
  rangePercent: number;
  rangePreset: MultiRangePreset;
  /**
   * Safety envelope on the RESOLVED rangePercent (whichever of
   * preset/custom produced it) — mirrors meridian-rs's
   * min_bins_below/max_bins_below sanity bounds on its own range sizing.
   * A resolved width outside [min, max] fails MULTI closed at config-load
   * (this codebase's existing fail-closed convention — see
   * validateMultiConfig), rather than being silently clamped into range.
   */
  minRangePercent: number;
  maxRangePercent: number;
  /**
   * 'static' (default, unset MULTI_RANGE_MODE): every candidate uses
   * rangePercent above, unchanged from before this option existed.
   * 'volume_tiered': the width is chosen per-candidate based on its
   * volumeUsd instead — see multiExecute.ts's
   * resolveRangePercentForCandidate.
   */
  rangeMode: 'static' | 'volume_tiered';
  /**
   * volume_tiered mode only (ignored, and NOT validated, in 'static' mode
   * — see validateMultiConfig): a candidate's volumeUsd at or above this
   * USD threshold uses rangeTierHighPercent; below it uses
   * rangeTierLowPercent. Comparison is >=, so a candidate with volume
   * exactly equal to this threshold is HIGH-tier.
   */
  rangeTierVolumeUsd: number;
  /** volume_tiered mode only: width for below-threshold ("low volume") candidates. Must be within [minRangePercent, maxRangePercent] when rangeMode='volume_tiered'. */
  rangeTierLowPercent: number;
  /** volume_tiered mode only: width for at-or-above-threshold ("high volume") candidates. Must be within [minRangePercent, maxRangePercent] when rangeMode='volume_tiered'. */
  rangeTierHighPercent: number;
  /** null = fall back to the user's existing size prefs (UserPrefs) */
  positionSizeUsd: number | null;
  /** null = no known USDG address for this chain/config — MULTI entry disabled */
  usdgAddress: Address | null;
  poolTvlWeight: number;
  poolVolumeWeight: number;
  poolVolumeTvlWeight: number;
  poolFeeWeight: number;
  maxOpenPositions: number;
  maxPositionsPerToken: number;
  maxExposureUsd: number;
  entryCooldownMs: number;
  tpPercent: number;
  slPercent: number;
  /**
   * Whether the deterministic MULTI strategy (runMultiStrategy) runs on its
   * OWN schedule (src/strategy/multiScheduler.ts) rather than only ever
   * being triggered on demand via /multi. Default OFF even when
   * STRATEGY=multi — mirrors agent/config.ts's AgentConfig.autonomousSchedule
   * split from AGENT_MODE exactly: STRATEGY=multi alone only makes the
   * manual /multi command available; nothing runs on its own until this is
   * ALSO explicitly turned on. A periodic, fully automatic capital-moving
   * loop is a materially bigger step up in autonomy than an operator
   * manually choosing to run it once, and deserves its own explicit opt-in.
   */
  autonomousSchedule: boolean;
  /** MULTI_SCREENING_INTERVAL_MIN, default 15 — only used when autonomousSchedule is on. */
  screeningIntervalMs: number;
};

/** Reads STRATEGY env var — 'multi' opts in explicitly, anything else (incl. unset) is 'default'. */
export function getActiveStrategyName(): StrategyName {
  const raw = (process.env.STRATEGY ?? 'default').trim().toLowerCase();
  return raw === 'multi' ? 'multi' : 'default';
}

/**
 * Phase 4.6.10: the complete, authoritative list of STRATEGY values this
 * codebase recognizes — kept in sync with the `StrategyName` union itself
 * (not invented independently), so a new strategy added to that type must
 * also be added here to become acceptable.
 */
const VALID_STRATEGY_NAMES: readonly StrategyName[] = ['default', 'multi'];

/**
 * Phase 4.6.10: authoritative startup-time STRATEGY validation — the one
 * place a present-but-unrecognized value (typo, empty string, garbage) is
 * rejected outright rather than silently absorbed into the default
 * strategy. Call once, early at process startup, before any
 * transaction-capable service starts; a thrown error here is expected to
 * propagate all the way to the top-level startup failure handler.
 *
 * Deliberately separate from `getActiveStrategyName()` above, which stays
 * unchanged and must keep never throwing — it is called live, on every
 * `/multi`-family Telegram command (see bot.ts), not just once at startup,
 * so making it throw would turn an invalid STRATEGY into a per-command
 * runtime error instead of a single, controlled startup failure. By the
 * time `getActiveStrategyName()` is ever invoked, this function has
 * already guaranteed `process.env.STRATEGY` is either unset or a name in
 * `VALID_STRATEGY_NAMES` — env vars do not change during a process's life.
 *
 * MISSING (unset) STRATEGY is intentionally NOT an error — it is the
 * existing, documented default, matching `getActiveStrategyName()`'s own
 * `?? 'default'` contract. A PRESENT value is normalized the exact same
 * way `getActiveStrategyName()` already does (trim + lowercase — existing
 * behavior, not new normalization) before being checked for membership;
 * only a value that still doesn't match any known name after that fails.
 */
export function assertValidStrategyEnv(): void {
  const raw = process.env.STRATEGY;
  if (raw == null) return; // unset — existing default applies, not an error
  const normalized = raw.trim().toLowerCase();
  if ((VALID_STRATEGY_NAMES as readonly string[]).includes(normalized)) return;
  throw new Error(
    `Invalid STRATEGY "${raw}": expected one of ${VALID_STRATEGY_NAMES.join(', ')} (or unset, which defaults to 'default')`,
  );
}

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.trim().toLowerCase();
  if (raw == null || raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'on';
}

function envPositiveOrNull(key: string): number | null {
  const raw = process.env[key];
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function resolveChainId(chainId?: SupportedChainId): SupportedChainId {
  if (chainId != null) return chainId;
  const raw = envNum('MULTI_CHAIN_ID', 4663);
  return isSupportedChainId(raw) ? raw : 4663;
}

/**
 * Resolve the USDG quote-asset address for MULTI. MULTI_USDG_ADDRESS (if a
 * valid address) always wins; otherwise falls back to the chain's known
 * USDG contract (CHAINS[chainId].usdg). Never resolved by symbol — a chain
 * with no known USDG address returns null (MULTI entry disabled for it),
 * per the spec's "no fallback to USDC/USDT/WETH/native" rule.
 *
 * Phase 4.7 fix: a MULTI_USDG_ADDRESS that is present but malformed (typo,
 * truncated, ENS name, trailing punctuation) must fail closed to null —
 * exactly like "unset" — rather than silently substituting the chain
 * default. Silently trading against a different quote asset than the one
 * the operator explicitly configured is a worse outcome than disabling
 * MULTI entirely; validateMultiConfig()'s existing `!usdgAddress` check
 * already disables MULTI with a clear reason for null, so returning null
 * here (instead of the chain default) routes a malformed override through
 * that same safe, already-tested path.
 */
function resolveUsdgAddress(chainId: SupportedChainId): Address | null {
  const raw = process.env.MULTI_USDG_ADDRESS?.trim();
  if (raw) {
    return isAddress(raw) ? (raw as Address) : null;
  }
  return CHAINS[chainId].usdg ?? null;
}

/**
 * SUB-FASE 3C: the complete, authoritative list of GMGN trending intervals
 * this codebase accepts for MULTI_CANDIDATE_INTERVAL — kept in sync with
 * gmgn/cli.ts's own GmgnTrendingInterval union (not invented independently).
 */
const VALID_CANDIDATE_INTERVALS: readonly GmgnTrendingInterval[] = ['1m', '5m', '1h', '6h', '24h'];

/**
 * Resolve MULTI_CANDIDATE_INTERVAL. Unset -> '5m' (this branch's default —
 * a deliberately faster/higher-risk profile than master's '6h'; the two are
 * not reconciled). A PRESENT value is passed through as-is, even if
 * invalid — mirrors resolveUsdgAddress's own fail-closed convention just
 * above: this function never silently substitutes the default for a
 * present-but-wrong value, so validateMultiConfig (the single place that
 * rejects it) can report exactly what was received.
 */
function resolveCandidateInterval(): GmgnTrendingInterval {
  const raw = process.env.MULTI_CANDIDATE_INTERVAL?.trim();
  if (!raw) return '5m';
  return raw as GmgnTrendingInterval;
}

export function loadMultiConfig(chainId?: SupportedChainId): MultiConfig {
  const resolvedChainId = resolveChainId(chainId);
  const { percent: rangePercent, preset: rangePreset } = resolveRangePercent();

  let poolTvlWeight = envNum('MULTI_POOL_TVL_WEIGHT', 0.3);
  let poolVolumeWeight = envNum('MULTI_POOL_VOLUME_WEIGHT', 0.3);
  let poolVolumeTvlWeight = envNum('MULTI_POOL_VOLUME_TVL_WEIGHT', 0.25);
  let poolFeeWeight = envNum('MULTI_POOL_FEE_WEIGHT', 0.15);

  // Self-tuning weights (src/strategy/signalWeights.ts) — opt-in, default
  // OFF: existing operators see zero behavior change unless they explicitly
  // enable this. When on, the LAST persisted tuned weight set (updated
  // after each closed MULTI position — see tpslWatcher.ts/bot.ts's close
  // paths) overrides the static env/default weights above. No tuned data
  // yet (never recalculated) falls through to the static values unchanged.
  if (envBool('MULTI_SELF_TUNE_WEIGHTS', false)) {
    try {
      const tuned = getTunedSignalWeights();
      if (tuned) {
        if (tuned.poolTvlUsd != null) poolTvlWeight = tuned.poolTvlUsd;
        if (tuned.poolVolumeUsd != null) poolVolumeWeight = tuned.poolVolumeUsd;
        if (tuned.poolVolumeTvlRatio != null) poolVolumeTvlWeight = tuned.poolVolumeTvlRatio;
        if (tuned.poolFee != null) poolFeeWeight = tuned.poolFee;
      }
    } catch {
      // DB unavailable (e.g. very early startup) — fall through to static weights, never throw.
    }
  }

  const base: MultiConfig = {
    enabled: true,
    chainId: resolvedChainId,
    interval: resolveCandidateInterval(),
    minMarketCapUsd: envNum('MULTI_MIN_MARKET_CAP_USD', 1_000_000),
    minTokenAgeHours: envNum('MULTI_MIN_TOKEN_AGE_HOURS', 4),
    minCandidateVolumeUsd: envNum('MULTI_MIN_CANDIDATE_VOLUME_USD', 200_000),
    minKolCount: envNum('MULTI_MIN_KOL_COUNT', 10),
    topN: Math.round(envNum('MULTI_TOP_N', 10)),
    rangePercent,
    rangePreset,
    minRangePercent: envNum('MULTI_MIN_RANGE_PERCENT', 10),
    maxRangePercent: envNum('MULTI_MAX_RANGE_PERCENT', 90),
    rangeMode: (process.env.MULTI_RANGE_MODE ?? 'static').trim().toLowerCase() === 'volume_tiered'
      ? 'volume_tiered'
      : 'static',
    rangeTierVolumeUsd: envNum('MULTI_RANGE_TIER_VOLUME_USD', 500_000),
    rangeTierLowPercent: envNum('MULTI_RANGE_TIER_LOW_PERCENT', 50),
    rangeTierHighPercent: envNum('MULTI_RANGE_TIER_HIGH_PERCENT', 30),
    positionSizeUsd: envPositiveOrNull('MULTI_POSITION_SIZE_USD'),
    usdgAddress: resolveUsdgAddress(resolvedChainId),
    poolTvlWeight,
    poolVolumeWeight,
    poolVolumeTvlWeight,
    poolFeeWeight,
    maxOpenPositions: Math.round(envNum('MULTI_MAX_OPEN_POSITIONS', 3)),
    maxPositionsPerToken: Math.round(envNum('MULTI_MAX_POSITIONS_PER_TOKEN', 1)),
    maxExposureUsd: envNum('MULTI_MAX_EXPOSURE_USD', 500),
    entryCooldownMs: Math.round(envNum('MULTI_ENTRY_COOLDOWN_MS', 300_000)),
    tpPercent: envNum('MULTI_TP_PERCENT', 10),
    slPercent: envNum('MULTI_SL_PERCENT', 15),
    autonomousSchedule: (process.env.MULTI_AUTONOMOUS_SCHEDULE ?? 'off').trim().toLowerCase() === 'on',
    screeningIntervalMs: Math.round(envNum('MULTI_SCREENING_INTERVAL_MIN', 15) * 60_000),
  };

  const validation = validateMultiConfig(base);
  if (!validation.valid) {
    return { ...base, enabled: false, disabledReason: validation.reason };
  }
  return base;
}

/**
 * Fail-closed config validation (spec §36): any invalid value disables MULTI
 * entirely rather than starting with malformed/partial config.
 */
export function validateMultiConfig(c: MultiConfig): { valid: boolean; reason?: string } {
  if (!(VALID_CANDIDATE_INTERVALS as readonly string[]).includes(c.interval)) {
    return {
      valid: false,
      reason: `MULTI_CANDIDATE_INTERVAL "${c.interval}" is not valid — expected one of ${VALID_CANDIDATE_INTERVALS.join(', ')}`,
    };
  }
  if (!(c.minMarketCapUsd > 0)) {
    return { valid: false, reason: 'MULTI_MIN_MARKET_CAP_USD must be > 0' };
  }
  if (!(c.minTokenAgeHours >= 0)) {
    return { valid: false, reason: 'MULTI_MIN_TOKEN_AGE_HOURS must be >= 0' };
  }
  if (!(c.minCandidateVolumeUsd >= 0)) {
    return { valid: false, reason: 'MULTI_MIN_CANDIDATE_VOLUME_USD must be >= 0' };
  }
  if (!(c.minKolCount >= 0)) {
    return { valid: false, reason: 'MULTI_MIN_KOL_COUNT must be >= 0' };
  }
  if (!(c.topN > 0)) {
    return { valid: false, reason: 'MULTI_TOP_N must be > 0' };
  }
  if (!(c.rangePercent > 0 && c.rangePercent < 100)) {
    return { valid: false, reason: 'MULTI_RANGE_PERCENT must be between 0 and 100 exclusive' };
  }
  if (!(c.minRangePercent > 0)) {
    return { valid: false, reason: 'MULTI_MIN_RANGE_PERCENT must be > 0' };
  }
  if (!(c.maxRangePercent > c.minRangePercent)) {
    return {
      valid: false,
      reason: 'MULTI_MAX_RANGE_PERCENT must be greater than MULTI_MIN_RANGE_PERCENT',
    };
  }
  if (c.rangePercent < c.minRangePercent || c.rangePercent > c.maxRangePercent) {
    return {
      valid: false,
      reason: `Resolved range width ${c.rangePercent}% (preset=${c.rangePreset}) is outside the configured safety bounds [${c.minRangePercent}%, ${c.maxRangePercent}%] — widen MULTI_MIN_RANGE_PERCENT/MULTI_MAX_RANGE_PERCENT or pick a different MULTI_RANGE_PRESET/MULTI_RANGE_PERCENT`,
    };
  }
  // Tier percents are only meaningful (and only validated) in
  // volume_tiered mode — in 'static' mode they are never read by
  // resolveRangePercentForCandidate, so an out-of-bounds value sitting
  // unused in config must not disable MULTI.
  if (c.rangeMode === 'volume_tiered') {
    if (c.rangeTierLowPercent < c.minRangePercent || c.rangeTierLowPercent > c.maxRangePercent) {
      return {
        valid: false,
        reason: `MULTI_RANGE_TIER_LOW_PERCENT (${c.rangeTierLowPercent}%) is outside the configured safety bounds [${c.minRangePercent}%, ${c.maxRangePercent}%]`,
      };
    }
    if (c.rangeTierHighPercent < c.minRangePercent || c.rangeTierHighPercent > c.maxRangePercent) {
      return {
        valid: false,
        reason: `MULTI_RANGE_TIER_HIGH_PERCENT (${c.rangeTierHighPercent}%) is outside the configured safety bounds [${c.minRangePercent}%, ${c.maxRangePercent}%]`,
      };
    }
  }
  if (c.positionSizeUsd != null && !(c.positionSizeUsd > 0)) {
    return { valid: false, reason: 'MULTI_POSITION_SIZE_USD must be > 0 when set' };
  }
  if (!c.usdgAddress) {
    return {
      valid: false,
      reason: 'No valid USDG address for this chain (MULTI_USDG_ADDRESS or chain default) — MULTI entry disabled',
    };
  }
  if (
    c.poolTvlWeight < 0 ||
    c.poolVolumeWeight < 0 ||
    c.poolVolumeTvlWeight < 0 ||
    c.poolFeeWeight < 0
  ) {
    return { valid: false, reason: 'Pool scoring weights must be >= 0' };
  }
  if (!(c.maxOpenPositions > 0)) {
    return { valid: false, reason: 'MULTI_MAX_OPEN_POSITIONS must be > 0' };
  }
  if (!(c.maxPositionsPerToken > 0)) {
    return { valid: false, reason: 'MULTI_MAX_POSITIONS_PER_TOKEN must be > 0' };
  }
  if (!(c.maxExposureUsd > 0)) {
    return { valid: false, reason: 'MULTI_MAX_EXPOSURE_USD must be > 0' };
  }
  if (!(c.entryCooldownMs >= 0)) {
    return { valid: false, reason: 'MULTI_ENTRY_COOLDOWN_MS must be >= 0' };
  }
  return { valid: true };
}
