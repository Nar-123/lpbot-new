/**
 * MULTI_MIN_KOL_COUNT config wiring — mirrors
 * strategy.multiConfig.minVolume.test.ts's coverage style, but the
 * semantics differ from minCandidateVolumeUsd: default is 3 (not 0/off),
 * and the comparison is GREATER THAN OR EQUAL TO the floor (inclusive) —
 * a candidate whose kolCount equals minKolCount PASSES, matching the
 * field's own name ("minimum"). Set MULTI_MIN_KOL_COUNT=0 explicitly to
 * disable this floor entirely.
 *
 * The filter's actual pipeline behavior (KOL_COUNT_UNKNOWN/
 * KOL_COUNT_TOO_LOW, boundary inclusivity) lives in
 * strategy.multiCandidates.test.ts — this suite only covers env
 * parsing/validation/the documented default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';

const { loadMultiConfig, validateMultiConfig } = await import('../src/strategy/multiConfig.js');

const CHAIN = 4663;

function clearEnv(): void {
  delete process.env.MULTI_MIN_KOL_COUNT;
}

test('MULTI_MIN_KOL_COUNT defaults to 3 when unset', () => {
  clearEnv();
  const cfg = loadMultiConfig(CHAIN);
  assert.equal(cfg.minKolCount, 3);
  assert.equal(cfg.enabled, true);
});

test('a valid positive MULTI_MIN_KOL_COUNT is honored', () => {
  // Deliberately distinct from the 3 default, so a broken env-parse that
  // silently fell through to the fallback would NOT coincidentally match.
  process.env.MULTI_MIN_KOL_COUNT = '15';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.minKolCount, 15);
  } finally {
    clearEnv();
  }
});

test('a malformed (non-numeric) MULTI_MIN_KOL_COUNT falls back to the 3 default, never NaN', () => {
  process.env.MULTI_MIN_KOL_COUNT = 'not-a-number';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.minKolCount, 3);
    assert.equal(Number.isFinite(cfg.minKolCount), true);
  } finally {
    clearEnv();
  }
});

test('a negative MULTI_MIN_KOL_COUNT fails validateMultiConfig — MULTI disabled rather than silently trading with an invalid floor', () => {
  process.env.MULTI_MIN_KOL_COUNT = '-5';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.enabled, false);
    assert.match(cfg.disabledReason ?? '', /MULTI_MIN_KOL_COUNT/);
    const v = validateMultiConfig(cfg);
    assert.equal(v.valid, false);
  } finally {
    clearEnv();
  }
});

test('MULTI_MIN_KOL_COUNT=0 explicitly disables the floor (distinct from the 3 default — an explicit opt-out, not "same as unset")', () => {
  process.env.MULTI_MIN_KOL_COUNT = '0';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.minKolCount, 0);
    assert.equal(cfg.enabled, true);
  } finally {
    clearEnv();
  }
});
