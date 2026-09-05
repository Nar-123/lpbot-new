/**
 * Deterministic close-rule engine — ported from meridian-rs
 * (backend/src/state/positions.rs's get_deterministic_close_rule +
 * update_trailing_state), adapted from Meteora DLMM bins to Uniswap-family
 * v3/v4 ticks. Pure and dependency-free (no RPC/DB) so every rule and every
 * edge case is unit-testable without network access — mirrors this
 * codebase's own safety.ts/tpslLogic.ts convention.
 *
 * Seven rules, evaluated in a fixed priority order (first match wins, same
 * order as the source):
 *   1. Stop Loss        — downside cap, runs BEFORE the min-duration gate
 *   2. (min-duration gate — suppresses every rule below for brand-new positions)
 *   3. Take Profit       — flat upside target
 *   4. Safety Exit        — after a deep drawdown, lock in breakeven+ instead
 *                          of waiting for the full TP that usually never comes
 *   5. Pumped Above Range — price ran far past the top of the range
 *   6. Out Of Range       — timed exit, with profit-bank / dead-hold nuance
 *   7. Low Yield          — fees earned relative to position value too thin
 *   8. Trailing TP        — handled separately (see updateTrailingState) since
 *                          it needs state carried between ticks, not just the
 *                          current snapshot; wired into the same priority
 *                          order by the caller (tpslWatcher.ts).
 */

export type CloseRule =
  | 'stop_loss'
  | 'take_profit'
  | 'safety_exit'
  | 'pumped_above_range'
  | 'out_of_range'
  | 'low_yield'
  | 'trailing_tp';

export type ExitConfig = {
  /** null = disabled. Percent, negative (e.g. -15 = stop out at -15%). */
  stopLossPct: number | null;
  /** null = disabled. Percent (e.g. 10 = take profit at +10%). */
  takeProfitPct: number | null;
  /** Suppresses every rule except Stop Loss for positions younger than this. */
  minPositionDurationMin: number;

  safetyExitEnabled: boolean;
  /** Drawdown trigger, negative percent (e.g. -8 = once max drawdown hits -8%). */
  safetyExitTriggerPct: number;
  /** TP level once the safety trigger has fired (e.g. 0 = breakeven). */
  safetyExitTpPct: number;

  /** Ticks beyond tickUpper before "pumped above range" fires. */
  pumpedAboveRangeTicks: number;

  outOfRangeWaitMinutes: number;
  /** Multiplier on outOfRangeWaitMinutes for the "dead too long, free the capital" hard exit. */
  outOfRangeMaxHoldMultiplier: number;
  /** OOR + PnL at or below this (percent, e.g. -3) closes even mid-wait. */
  outOfRangeCloseLossPct: number;
  /** OOR + PnL at or above this (percent) banks the gain instead of waiting out the full hold. */
  exitMinProfitPct: number;

  lowYieldEnabled: boolean;
  /** Minimum age before a position is even eligible for the low-yield check. */
  lowYieldMinAgeMinutes: number;
  /** Minimum acceptable "fees earned / position value" ratio. */
  lowYieldMinFeeValueRatio: number;

  trailingEnabled: boolean;
  /** Peak PnL percent that arms trailing (e.g. 15 = arms once profit has reached +15%). */
  trailingTriggerPct: number;
  /** Percent drop from peak that triggers the trailing exit once armed. */
  trailingDropPct: number;
};

export function defaultExitConfig(): ExitConfig {
  return {
    stopLossPct: null,
    takeProfitPct: null,
    minPositionDurationMin: 5,
    safetyExitEnabled: true,
    safetyExitTriggerPct: -8,
    safetyExitTpPct: 0,
    pumpedAboveRangeTicks: 5000,
    outOfRangeWaitMinutes: 30,
    outOfRangeMaxHoldMultiplier: 4,
    outOfRangeCloseLossPct: -3,
    exitMinProfitPct: 2,
    lowYieldEnabled: false,
    lowYieldMinAgeMinutes: 60,
    lowYieldMinFeeValueRatio: 0.0005,
    trailingEnabled: false,
    trailingTriggerPct: 15,
    trailingDropPct: 5,
  };
}

/** Per-position state carried between ticks — persisted (see db/index.ts's exit_state fields). */
export type ExitState = {
  peakPnlPct: number | null;
  maxDrawdownPct: number | null;
  trailingActive: boolean;
  outOfRangeSinceMs: number | null;
};

export function defaultExitState(): ExitState {
  return { peakPnlPct: null, maxDrawdownPct: null, trailingActive: false, outOfRangeSinceMs: null };
}

export type CloseRuleSnapshot = {
  pnlPct: number;
  ageMinutes: number;
  inRange: boolean;
  /** Ticks the current price is beyond the position's tickUpper — 0 or negative when not pumped above. */
  ticksAboveUpper: number;
  /** Fees earned so far, as a fraction of current position value (0.001 = 0.1%). Null = unknown, never coerced to 0. */
  feeValueRatio: number | null;
  minutesOutOfRange: number;
  state: ExitState;
  config: ExitConfig;
};

/**
 * Update trailing-TP state for the current tick. Mirrors
 * meridian-rs's update_trailing_state: tracks the worst PnL ever seen
 * (max drawdown, used by the safety-exit gate) and the peak PnL (used to
 * arm/measure the trailing drop) — both monotonic, both persisted, neither
 * ever un-set by a single-tick blip (no confirmation-window here; unlike
 * the source, this codebase's tpslWatcher.ts already has its own separate
 * 5s recheck-before-close mechanism, which trailing exits reuse).
 */
/**
 * Update trailing-TP state for the current tick. Mirrors meridian-rs's
 * update_trailing_state: tracks the worst PnL ever seen (max drawdown, used
 * by the safety-exit gate) and the peak PnL (used to arm/measure the
 * trailing drop), and arms trailing once the confirmed peak has ever
 * reached the trigger — monotonic, never un-arms once set, even if PnL
 * later drops back below the trigger level. No confirmation-window here
 * (unlike the source): this codebase's tpslWatcher.ts already has its own
 * separate 5s recheck-before-close mechanism, which trailing exits reuse.
 */
export function updateTrailingState(
  state: ExitState,
  currentPnlPct: number,
  config: Pick<ExitConfig, 'trailingEnabled' | 'trailingTriggerPct'>,
): ExitState {
  const maxDrawdownPct =
    state.maxDrawdownPct == null ? currentPnlPct : Math.min(state.maxDrawdownPct, currentPnlPct);
  const peakPnlPct =
    state.peakPnlPct == null ? currentPnlPct : Math.max(state.peakPnlPct, currentPnlPct);
  const trailingActive =
    state.trailingActive || (config.trailingEnabled && peakPnlPct >= config.trailingTriggerPct);
  return { ...state, maxDrawdownPct, peakPnlPct, trailingActive };
}

/**
 * The 7-rule deterministic engine. UNKNOWN inputs (null pnlPct handled by
 * the caller before this is ever invoked, null feeValueRatio here) never
 * silently pass a rule — a rule that needs unknown data simply doesn't
 * fire, exactly like this codebase's safety.ts convention elsewhere.
 */
export function getDeterministicCloseRule(snap: CloseRuleSnapshot): CloseRule | null {
  const { pnlPct, ageMinutes, ticksAboveUpper, feeValueRatio, minutesOutOfRange, state, config } = snap;

  // Suspect-PnL guard: an extreme negative reading is more likely stale/bad
  // data than a real result on a position that still has real value —
  // caller is expected to have already excluded genuinely-zero positions
  // before this point (see tpslWatcher's measurePnl 'gone' status).
  if (pnlPct <= -90) return null;

  // Rule 1: Stop Loss — exempt from the min-duration gate. A fast dump must
  // be cut even on a brand-new position; only require ~1 minute of age so a
  // transient just-opened valuation glitch can't false-trigger.
  if (config.stopLossPct != null && pnlPct <= config.stopLossPct && ageMinutes >= 1) {
    return 'stop_loss';
  }

  // Min-duration gate: suppress every softer/noise-sensitive rule below for
  // brand-new positions.
  if (ageMinutes < config.minPositionDurationMin) return null;

  // Rule 2: Take Profit
  if (config.takeProfitPct != null && pnlPct >= config.takeProfitPct) {
    return 'take_profit';
  }

  // Rule 3: Safety Exit — once max drawdown has hit the danger zone, lower
  // the bar to the safety level and bank the bounce instead of waiting for
  // a full recovery that usually doesn't come.
  if (config.safetyExitEnabled) {
    const maxDd = state.maxDrawdownPct ?? 0;
    if (maxDd <= config.safetyExitTriggerPct && pnlPct >= config.safetyExitTpPct) {
      return 'safety_exit';
    }
  }

  // Rule 4: Pumped Above Range
  if (ticksAboveUpper > config.pumpedAboveRangeTicks) {
    return 'pumped_above_range';
  }

  // Rule 5: Out Of Range Too Long
  if (minutesOutOfRange >= config.outOfRangeWaitMinutes) {
    const deadTooLong = minutesOutOfRange >= config.outOfRangeWaitMinutes * config.outOfRangeMaxHoldMultiplier;
    const bankedAboveRange = pnlPct >= config.exitMinProfitPct;
    if (pnlPct <= config.outOfRangeCloseLossPct || bankedAboveRange || deadTooLong) {
      return 'out_of_range';
    }
    // else: OOR near breakeven — hold for the bounce rather than crystallising nothing.
  }

  // Rule 6: Low Yield
  if (config.lowYieldEnabled && ageMinutes >= config.lowYieldMinAgeMinutes) {
    if (feeValueRatio != null && feeValueRatio < config.lowYieldMinFeeValueRatio) {
      return 'low_yield';
    }
  }

  // Rule 7: Trailing TP — arming already resolved by updateTrailingState;
  // this only checks the drop-from-peak once armed.
  if (config.trailingEnabled && state.trailingActive) {
    const peak = state.peakPnlPct ?? pnlPct;
    if (peak - pnlPct >= config.trailingDropPct) {
      return 'trailing_tp';
    }
  }

  return null;
}

export const CLOSE_RULE_LABELS: Record<CloseRule, string> = {
  stop_loss: 'stop loss',
  take_profit: 'take profit',
  safety_exit: 'safety exit (breakeven after drawdown)',
  pumped_above_range: 'pumped far above range',
  out_of_range: 'out of range too long',
  low_yield: 'low yield',
  trailing_tp: 'trailing take profit',
};

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

/**
 * Builds the full ExitConfig for one position: takeProfitPct/stopLossPct
 * come from the EXISTING per-position/prefs TP/SL values (never a new,
 * second source of truth for the two rules that already existed before
 * this engine) — everything else (safety exit, OOR, low yield, trailing)
 * is a genuinely new, opt-in-by-default-off (except safety exit, which
 * mirrors meridian-rs's own default-on) global config, read once per tick
 * rather than per-position, matching this codebase's existing env-config
 * pattern (multiConfig.ts).
 *
 * `slPercent`/`tpPercent` here use this codebase's EXISTING sign
 * convention (positive magnitude, e.g. 15 meaning "close at -15%") — see
 * tpslLogic.ts's classify(). Converted to the engine's signed-threshold
 * convention (stopLossPct = -15) at the boundary, once, here.
 */
export function resolveExitConfig(tpPercent: number, slPercent: number): ExitConfig {
  return {
    stopLossPct: -Math.abs(slPercent),
    takeProfitPct: tpPercent,
    minPositionDurationMin: Math.max(0, envNum('EXIT_MIN_POSITION_DURATION_MIN', 5)),
    safetyExitEnabled: envBool('EXIT_SAFETY_ENABLED', true),
    safetyExitTriggerPct: envNum('EXIT_SAFETY_TRIGGER_PCT', -8),
    safetyExitTpPct: envNum('EXIT_SAFETY_TP_PCT', 0),
    pumpedAboveRangeTicks: Math.max(1, envNum('EXIT_PUMPED_ABOVE_RANGE_TICKS', 5000)),
    outOfRangeWaitMinutes: Math.max(1, envNum('EXIT_OOR_WAIT_MINUTES', 30)),
    outOfRangeMaxHoldMultiplier: Math.max(1, envNum('EXIT_OOR_MAX_HOLD_MULTIPLIER', 4)),
    outOfRangeCloseLossPct: envNum('EXIT_OOR_CLOSE_LOSS_PCT', -3),
    exitMinProfitPct: envNum('EXIT_MIN_PROFIT_PCT', 2),
    lowYieldEnabled: envBool('EXIT_LOW_YIELD_ENABLED', false),
    lowYieldMinAgeMinutes: Math.max(0, envNum('EXIT_LOW_YIELD_MIN_AGE_MIN', 60)),
    lowYieldMinFeeValueRatio: Math.max(0, envNum('EXIT_LOW_YIELD_MIN_FEE_VALUE_RATIO', 0.0005)),
    trailingEnabled: envBool('EXIT_TRAILING_ENABLED', false),
    trailingTriggerPct: envNum('EXIT_TRAILING_TRIGGER_PCT', 15),
    trailingDropPct: Math.max(0.01, envNum('EXIT_TRAILING_DROP_PCT', 5)),
  };
}
