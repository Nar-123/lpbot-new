import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultExitConfig,
  defaultExitState,
  getDeterministicCloseRule,
  updateTrailingState,
  type CloseRuleSnapshot,
  type ExitConfig,
} from '../src/strategy/exitRules.js';

function snap(overrides: Partial<CloseRuleSnapshot> = {}): CloseRuleSnapshot {
  return {
    pnlPct: 0,
    ageMinutes: 60,
    inRange: true,
    ticksAboveUpper: 0,
    feeValueRatio: null,
    minutesOutOfRange: 0,
    state: defaultExitState(),
    config: defaultExitConfig(),
    ...overrides,
  };
}

// ── Guard: suspect PnL ────────────────────────────────────────

test('pnlPct <= -90 never triggers any rule (suspect/stale data guard)', () => {
  const s = snap({ pnlPct: -95, config: { ...defaultExitConfig(), stopLossPct: -10 } });
  assert.equal(getDeterministicCloseRule(s), null);
});

// ── Rule 1: Stop Loss ─────────────────────────────────────────

test('stop loss fires when pnl crosses the configured threshold', () => {
  const s = snap({ pnlPct: -16, ageMinutes: 2, config: { ...defaultExitConfig(), stopLossPct: -15 } });
  assert.equal(getDeterministicCloseRule(s), 'stop_loss');
});

test('stop loss is exempt from the min-duration gate (fires even on a 1-minute-old position)', () => {
  const s = snap({ pnlPct: -20, ageMinutes: 1, config: { ...defaultExitConfig(), stopLossPct: -15 } });
  assert.equal(getDeterministicCloseRule(s), 'stop_loss');
});

test('stop loss does NOT fire on a genuinely brand-new position (<1 minute) — avoids a valuation-glitch false trigger', () => {
  const s = snap({ pnlPct: -20, ageMinutes: 0, config: { ...defaultExitConfig(), stopLossPct: -15 } });
  assert.equal(getDeterministicCloseRule(s), null);
});

test('stop loss disabled (null) never fires regardless of pnl', () => {
  const s = snap({ pnlPct: -99, ageMinutes: 10, config: { ...defaultExitConfig(), stopLossPct: null } });
  assert.notEqual(getDeterministicCloseRule(s), 'stop_loss');
});

// ── Min-duration gate ─────────────────────────────────────────

test('min-duration gate suppresses take-profit (and every softer rule) on a too-young position', () => {
  const s = snap({
    pnlPct: 50,
    ageMinutes: 2,
    config: { ...defaultExitConfig(), takeProfitPct: 10, minPositionDurationMin: 5 },
  });
  assert.equal(getDeterministicCloseRule(s), null);
});

// ── Rule 2: Take Profit ───────────────────────────────────────

test('take profit fires once pnl reaches the target, past the min-duration gate', () => {
  const s = snap({ pnlPct: 12, ageMinutes: 10, config: { ...defaultExitConfig(), takeProfitPct: 10 } });
  assert.equal(getDeterministicCloseRule(s), 'take_profit');
});

// ── Rule 3: Safety Exit ───────────────────────────────────────

test('safety exit fires after a deep drawdown once pnl recovers to the (lower) safety level', () => {
  const state = { ...defaultExitState(), maxDrawdownPct: -12 };
  const s = snap({
    pnlPct: 0.5,
    ageMinutes: 30,
    state,
    config: { ...defaultExitConfig(), safetyExitEnabled: true, safetyExitTriggerPct: -8, safetyExitTpPct: 0 },
  });
  assert.equal(getDeterministicCloseRule(s), 'safety_exit');
});

test('safety exit does NOT fire without a deep-enough drawdown, even if currently profitable', () => {
  const state = { ...defaultExitState(), maxDrawdownPct: -3 };
  const s = snap({
    pnlPct: 5,
    ageMinutes: 30,
    state,
    config: { ...defaultExitConfig(), safetyExitEnabled: true, safetyExitTriggerPct: -8, safetyExitTpPct: 0 },
  });
  assert.notEqual(getDeterministicCloseRule(s), 'safety_exit');
});

test('safety exit disabled never fires even with a deep drawdown', () => {
  const state = { ...defaultExitState(), maxDrawdownPct: -50 };
  const s = snap({
    pnlPct: 10,
    ageMinutes: 30,
    state,
    config: { ...defaultExitConfig(), safetyExitEnabled: false },
  });
  assert.notEqual(getDeterministicCloseRule(s), 'safety_exit');
});

// ── Rule 4: Pumped Above Range ────────────────────────────────

test('pumped above range fires once price is far enough past tickUpper', () => {
  const s = snap({
    pnlPct: 5,
    ageMinutes: 30,
    ticksAboveUpper: 6000,
    config: { ...defaultExitConfig(), pumpedAboveRangeTicks: 5000 },
  });
  assert.equal(getDeterministicCloseRule(s), 'pumped_above_range');
});

test('pumped above range does not fire for a small overshoot within tolerance', () => {
  const s = snap({
    pnlPct: 5,
    ageMinutes: 30,
    ticksAboveUpper: 100,
    config: { ...defaultExitConfig(), pumpedAboveRangeTicks: 5000 },
  });
  assert.notEqual(getDeterministicCloseRule(s), 'pumped_above_range');
});

// ── Rule 5: Out Of Range ──────────────────────────────────────

test('OOR + meaningful loss closes even before the dead-hold multiplier is reached', () => {
  const s = snap({
    pnlPct: -5,
    ageMinutes: 60,
    minutesOutOfRange: 31,
    config: { ...defaultExitConfig(), outOfRangeWaitMinutes: 30, outOfRangeCloseLossPct: -3 },
  });
  assert.equal(getDeterministicCloseRule(s), 'out_of_range');
});

test('OOR + meaningful profit banks the gain immediately rather than waiting out the full dead-hold', () => {
  const s = snap({
    pnlPct: 8,
    ageMinutes: 60,
    minutesOutOfRange: 31,
    config: { ...defaultExitConfig(), outOfRangeWaitMinutes: 30, exitMinProfitPct: 2 },
  });
  assert.equal(getDeterministicCloseRule(s), 'out_of_range');
});

test('OOR near breakeven holds — does not close mid-wait, waiting for a possible bounce', () => {
  const s = snap({
    pnlPct: 0.2,
    ageMinutes: 60,
    minutesOutOfRange: 31,
    config: {
      ...defaultExitConfig(),
      outOfRangeWaitMinutes: 30,
      outOfRangeMaxHoldMultiplier: 4,
      outOfRangeCloseLossPct: -3,
      exitMinProfitPct: 2,
    },
  });
  assert.equal(getDeterministicCloseRule(s), null);
});

test('OOR near-breakeven eventually force-closes once the dead-hold multiplier is reached (free the capital)', () => {
  const s = snap({
    pnlPct: 0.2,
    ageMinutes: 200,
    minutesOutOfRange: 121, // 30 * 4 = 120
    config: {
      ...defaultExitConfig(),
      outOfRangeWaitMinutes: 30,
      outOfRangeMaxHoldMultiplier: 4,
      outOfRangeCloseLossPct: -3,
      exitMinProfitPct: 2,
    },
  });
  assert.equal(getDeterministicCloseRule(s), 'out_of_range');
});

test('not yet OOR long enough — no exit', () => {
  const s = snap({
    pnlPct: -5,
    ageMinutes: 60,
    minutesOutOfRange: 10,
    config: { ...defaultExitConfig(), outOfRangeWaitMinutes: 30 },
  });
  assert.equal(getDeterministicCloseRule(s), null);
});

// ── Rule 6: Low Yield ─────────────────────────────────────────

test('low yield fires once old enough and fee/value ratio is below the floor', () => {
  const s = snap({
    pnlPct: 1,
    ageMinutes: 90,
    feeValueRatio: 0.0001,
    config: {
      ...defaultExitConfig(),
      lowYieldEnabled: true,
      lowYieldMinAgeMinutes: 60,
      lowYieldMinFeeValueRatio: 0.0005,
    },
  });
  assert.equal(getDeterministicCloseRule(s), 'low_yield');
});

test('low yield does not fire before the minimum age, even with zero fees', () => {
  const s = snap({
    pnlPct: 1,
    ageMinutes: 30,
    feeValueRatio: 0,
    config: {
      ...defaultExitConfig(),
      lowYieldEnabled: true,
      lowYieldMinAgeMinutes: 60,
      lowYieldMinFeeValueRatio: 0.0005,
    },
  });
  assert.equal(getDeterministicCloseRule(s), null);
});

test('low yield with UNKNOWN feeValueRatio (null) never fires — unknown is never coerced to "bad"', () => {
  const s = snap({
    pnlPct: 1,
    ageMinutes: 90,
    feeValueRatio: null,
    config: { ...defaultExitConfig(), lowYieldEnabled: true, lowYieldMinAgeMinutes: 60 },
  });
  assert.notEqual(getDeterministicCloseRule(s), 'low_yield');
});

test('low yield disabled by default (opt-in) never fires', () => {
  const s = snap({
    pnlPct: 1,
    ageMinutes: 500,
    feeValueRatio: 0,
    config: defaultExitConfig(),
  });
  assert.notEqual(getDeterministicCloseRule(s), 'low_yield');
});

// ── Rule 7 + trailing state machine ───────────────────────────

test('trailing TP: arms once peak reaches the trigger, then fires once it drops enough from that peak', () => {
  const config: ExitConfig = {
    ...defaultExitConfig(),
    trailingEnabled: true,
    trailingTriggerPct: 15,
    trailingDropPct: 5,
  };
  let state = defaultExitState();

  // Climb to +20% — arms trailing (peak 20 >= trigger 15), does not exit (no drop yet).
  state = updateTrailingState(state, 20, config);
  assert.equal(state.trailingActive, true);
  assert.equal(getDeterministicCloseRule(snap({ pnlPct: 20, ageMinutes: 30, state, config })), null);

  // Drop to +16% — only 4% off peak, still under the 5% drop trigger.
  state = updateTrailingState(state, 16, config);
  assert.equal(getDeterministicCloseRule(snap({ pnlPct: 16, ageMinutes: 30, state, config })), null);

  // Drop to +14% — 6% off the 20% peak, crosses the 5% drop trigger.
  state = updateTrailingState(state, 14, config);
  assert.equal(getDeterministicCloseRule(snap({ pnlPct: 14, ageMinutes: 30, state, config })), 'trailing_tp');
});

test('trailing TP never arms if peak never reaches the trigger', () => {
  const config: ExitConfig = {
    ...defaultExitConfig(),
    trailingEnabled: true,
    trailingTriggerPct: 15,
    trailingDropPct: 5,
  };
  let state = defaultExitState();
  state = updateTrailingState(state, 8, config);
  state = updateTrailingState(state, 2, config); // big relative drop, but never armed
  assert.equal(state.trailingActive, false);
  assert.equal(getDeterministicCloseRule(snap({ pnlPct: 2, ageMinutes: 30, state, config })), null);
});

test('trailing TP stays armed even if pnl dips below the trigger without yet dropping the full amount — arming is monotonic', () => {
  const config: ExitConfig = {
    ...defaultExitConfig(),
    trailingEnabled: true,
    trailingTriggerPct: 15,
    trailingDropPct: 5,
  };
  let state = defaultExitState();
  state = updateTrailingState(state, 16, config); // arms
  state = updateTrailingState(state, 13, config); // dips below trigger(15) but only 3% off 16 peak — should NOT fire yet
  assert.equal(state.trailingActive, true);
  assert.equal(getDeterministicCloseRule(snap({ pnlPct: 13, ageMinutes: 30, state, config })), null);
});

test('trailing disabled never fires regardless of state', () => {
  const config: ExitConfig = { ...defaultExitConfig(), trailingEnabled: false };
  let state = defaultExitState();
  state = updateTrailingState(state, 30, config);
  assert.equal(state.trailingActive, false);
  assert.equal(getDeterministicCloseRule(snap({ pnlPct: 5, ageMinutes: 30, state, config })), null);
});

// ── Priority ordering ─────────────────────────────────────────

test('stop loss takes priority over every other rule when multiple would otherwise match', () => {
  const s = snap({
    pnlPct: -20,
    ageMinutes: 100,
    ticksAboveUpper: 999999, // would also match pumped-above-range
    config: { ...defaultExitConfig(), stopLossPct: -15, pumpedAboveRangeTicks: 100 },
  });
  assert.equal(getDeterministicCloseRule(s), 'stop_loss');
});

test('take profit takes priority over safety exit when both would match', () => {
  const s = snap({
    pnlPct: 12,
    ageMinutes: 100,
    state: { ...defaultExitState(), maxDrawdownPct: -20 },
    config: {
      ...defaultExitConfig(),
      takeProfitPct: 10,
      safetyExitEnabled: true,
      safetyExitTriggerPct: -8,
      safetyExitTpPct: 0,
    },
  });
  assert.equal(getDeterministicCloseRule(s), 'take_profit');
});

// ── updateTrailingState: max drawdown tracking (feeds safety exit) ─

test('updateTrailingState tracks the worst PnL ever seen, monotonically, independent of trailing config', () => {
  const config = { trailingEnabled: false, trailingTriggerPct: 15 };
  let state = defaultExitState();
  state = updateTrailingState(state, -5, config);
  state = updateTrailingState(state, -12, config);
  state = updateTrailingState(state, 3, config); // recovers, but drawdown memory does not un-set
  assert.equal(state.maxDrawdownPct, -12);
});

// ── resolveExitConfig: env wiring + sign-convention boundary ──

test('resolveExitConfig converts the existing positive-magnitude slPercent into a signed threshold', async () => {
  const { resolveExitConfig } = await import('../src/strategy/exitRules.js');
  const cfg = resolveExitConfig(10, 15);
  assert.equal(cfg.stopLossPct, -15);
  assert.equal(cfg.takeProfitPct, 10);
});

test('resolveExitConfig: safety exit defaults ON, low yield and trailing default OFF (opt-in only)', async () => {
  const { resolveExitConfig } = await import('../src/strategy/exitRules.js');
  const cfg = resolveExitConfig(10, 15);
  assert.equal(cfg.safetyExitEnabled, true);
  assert.equal(cfg.lowYieldEnabled, false);
  assert.equal(cfg.trailingEnabled, false);
});

test('resolveExitConfig: EXIT_TRAILING_ENABLED=on picked up from env', async () => {
  process.env.EXIT_TRAILING_ENABLED = 'on';
  process.env.EXIT_TRAILING_TRIGGER_PCT = '20';
  process.env.EXIT_TRAILING_DROP_PCT = '7';
  const { resolveExitConfig } = await import('../src/strategy/exitRules.js');
  const cfg = resolveExitConfig(10, 15);
  assert.equal(cfg.trailingEnabled, true);
  assert.equal(cfg.trailingTriggerPct, 20);
  assert.equal(cfg.trailingDropPct, 7);
  delete process.env.EXIT_TRAILING_ENABLED;
  delete process.env.EXIT_TRAILING_TRIGGER_PCT;
  delete process.env.EXIT_TRAILING_DROP_PCT;
});

test('resolveExitConfig: EXIT_TRAILING_TRIGGER_PCT/EXIT_TRAILING_DROP_PCT default to 5/3 when unset', async () => {
  delete process.env.EXIT_TRAILING_TRIGGER_PCT;
  delete process.env.EXIT_TRAILING_DROP_PCT;
  const { resolveExitConfig } = await import('../src/strategy/exitRules.js');
  const cfg = resolveExitConfig(10, 15);
  assert.equal(cfg.trailingTriggerPct, 5);
  assert.equal(cfg.trailingDropPct, 3);
});
