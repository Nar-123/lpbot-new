/**
 * MULTI_RANGE_MODE / volume-tiered range config wiring (FASE 2).
 *
 * rangeMode defaults to 'static' (unset MULTI_RANGE_MODE) — byte-for-byte
 * the pre-existing behavior. The tier percent fields (rangeTierLowPercent/
 * rangeTierHighPercent) are only validated against the existing
 * minRangePercent/maxRangePercent safety bounds when rangeMode is
 * explicitly 'volume_tiered' — in 'static' mode they are never read by
 * resolveRangePercentForCandidate, so an out-of-bounds value sitting
 * unused must never disable MULTI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';

const { loadMultiConfig, validateMultiConfig } = await import('../src/strategy/multiConfig.js');

const CHAIN = 4663;

function clearEnv(): void {
  delete process.env.MULTI_RANGE_MODE;
  delete process.env.MULTI_RANGE_TIER_VOLUME_USD;
  delete process.env.MULTI_RANGE_TIER_LOW_PERCENT;
  delete process.env.MULTI_RANGE_TIER_HIGH_PERCENT;
  delete process.env.MULTI_MIN_RANGE_PERCENT;
  delete process.env.MULTI_MAX_RANGE_PERCENT;
}

test.afterEach(clearEnv);

test('MULTI_RANGE_MODE defaults to "static" when unset, with the documented tier defaults still loaded (unused in static mode)', () => {
  const cfg = loadMultiConfig(CHAIN);
  assert.equal(cfg.rangeMode, 'static');
  assert.equal(cfg.rangeTierVolumeUsd, 500_000);
  assert.equal(cfg.rangeTierLowPercent, 50);
  assert.equal(cfg.rangeTierHighPercent, 30);
  assert.equal(cfg.enabled, true);
});

test('MULTI_RANGE_MODE=volume_tiered is honored', () => {
  process.env.MULTI_RANGE_MODE = 'volume_tiered';
  const cfg = loadMultiConfig(CHAIN);
  assert.equal(cfg.rangeMode, 'volume_tiered');
});

test('an unrecognized MULTI_RANGE_MODE value falls back to "static" (live getter is permissive; consistent with this codebase\'s other enum-like env vars)', () => {
  process.env.MULTI_RANGE_MODE = 'something-else';
  const cfg = loadMultiConfig(CHAIN);
  assert.equal(cfg.rangeMode, 'static');
});

test('MULTI_RANGE_TIER_VOLUME_USD/LOW_PERCENT/HIGH_PERCENT overrides are honored', () => {
  process.env.MULTI_RANGE_TIER_VOLUME_USD = '1000000';
  process.env.MULTI_RANGE_TIER_LOW_PERCENT = '20';
  process.env.MULTI_RANGE_TIER_HIGH_PERCENT = '70';
  const cfg = loadMultiConfig(CHAIN);
  assert.equal(cfg.rangeTierVolumeUsd, 1_000_000);
  assert.equal(cfg.rangeTierLowPercent, 20);
  assert.equal(cfg.rangeTierHighPercent, 70);
});

test('volume_tiered mode: rangeTierLowPercent outside [minRangePercent, maxRangePercent] disables MULTI, disabledReason names the specific field', () => {
  process.env.MULTI_RANGE_MODE = 'volume_tiered';
  process.env.MULTI_MIN_RANGE_PERCENT = '10';
  process.env.MULTI_MAX_RANGE_PERCENT = '90';
  process.env.MULTI_RANGE_TIER_LOW_PERCENT = '5'; // below the 10% floor
  const cfg = loadMultiConfig(CHAIN);
  assert.equal(cfg.enabled, false);
  assert.match(cfg.disabledReason ?? '', /MULTI_RANGE_TIER_LOW_PERCENT/);
  const v = validateMultiConfig(cfg);
  assert.equal(v.valid, false);
});

test('volume_tiered mode: rangeTierHighPercent outside [minRangePercent, maxRangePercent] disables MULTI, disabledReason names the specific field', () => {
  process.env.MULTI_RANGE_MODE = 'volume_tiered';
  process.env.MULTI_MIN_RANGE_PERCENT = '10';
  process.env.MULTI_MAX_RANGE_PERCENT = '90';
  process.env.MULTI_RANGE_TIER_HIGH_PERCENT = '95'; // above the 90% ceiling
  const cfg = loadMultiConfig(CHAIN);
  assert.equal(cfg.enabled, false);
  assert.match(cfg.disabledReason ?? '', /MULTI_RANGE_TIER_HIGH_PERCENT/);
});

test('static mode: rangeTierLowPercent/rangeTierHighPercent outside [minRangePercent, maxRangePercent] does NOT disable MULTI — the fields are unused and must not be validated', () => {
  process.env.MULTI_MIN_RANGE_PERCENT = '10';
  process.env.MULTI_MAX_RANGE_PERCENT = '90';
  process.env.MULTI_RANGE_TIER_LOW_PERCENT = '5'; // would fail if validated, but rangeMode is unset (static)
  process.env.MULTI_RANGE_TIER_HIGH_PERCENT = '95'; // same
  const cfg = loadMultiConfig(CHAIN);
  assert.equal(cfg.rangeMode, 'static');
  assert.equal(cfg.enabled, true, 'static mode must never validate the unused tier fields');
});

test('volume_tiered mode: tier percents within bounds pass validation normally', () => {
  process.env.MULTI_RANGE_MODE = 'volume_tiered';
  process.env.MULTI_MIN_RANGE_PERCENT = '10';
  process.env.MULTI_MAX_RANGE_PERCENT = '90';
  process.env.MULTI_RANGE_TIER_LOW_PERCENT = '50';
  process.env.MULTI_RANGE_TIER_HIGH_PERCENT = '30';
  const cfg = loadMultiConfig(CHAIN);
  assert.equal(cfg.enabled, true);
});
