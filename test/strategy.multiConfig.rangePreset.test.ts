/**
 * Range preset ("tiru semua cara meridian... termasuk beda-beda range") —
 * meridian-rs's target_downside_pct is functionally identical to this
 * codebase's pre-existing MULTI_RANGE_PERCENT; the new value-add is (a)
 * named presets (tight/normal/wide) as an alternative to a raw percentage,
 * and (b) explicit min/max safety bounds on whatever width is resolved,
 * mirroring meridian's own min_bins_below/max_bins_below sanity clamp — but
 * as fail-closed validation (this codebase's existing convention), not a
 * silent clamp.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';

const { loadMultiConfig, validateMultiConfig } = await import('../src/strategy/multiConfig.js');

const CHAIN = 4663;

function clearEnv(): void {
  delete process.env.MULTI_RANGE_PERCENT;
  delete process.env.MULTI_RANGE_PRESET;
  delete process.env.MULTI_MIN_RANGE_PERCENT;
  delete process.env.MULTI_MAX_RANGE_PERCENT;
}

test('default (nothing set) resolves to the "normal" preset at 50% — unchanged from the pre-preset default', () => {
  clearEnv();
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.rangePercent, 50);
    assert.equal(cfg.rangePreset, 'normal');
    assert.equal(cfg.enabled, true);
  } finally {
    clearEnv();
  }
});

test('MULTI_RANGE_PRESET=tight resolves to 15%', () => {
  process.env.MULTI_RANGE_PRESET = 'tight';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.rangePercent, 15);
    assert.equal(cfg.rangePreset, 'tight');
  } finally {
    clearEnv();
  }
});

test('MULTI_RANGE_PRESET=wide resolves to 80%', () => {
  process.env.MULTI_RANGE_PRESET = 'wide';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.rangePercent, 80);
    assert.equal(cfg.rangePreset, 'wide');
  } finally {
    clearEnv();
  }
});

test('an unrecognized MULTI_RANGE_PRESET falls back to "normal", never NaN or undefined', () => {
  process.env.MULTI_RANGE_PRESET = 'ultra-mega-wide';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.rangePercent, 50);
    assert.equal(cfg.rangePreset, 'normal');
  } finally {
    clearEnv();
  }
});

test('an explicit MULTI_RANGE_PERCENT always wins over MULTI_RANGE_PRESET — existing operators see zero behavior change', () => {
  process.env.MULTI_RANGE_PERCENT = '33';
  process.env.MULTI_RANGE_PRESET = 'wide'; // must be ignored
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.rangePercent, 33);
    assert.equal(cfg.rangePreset, 'custom');
  } finally {
    clearEnv();
  }
});

test('default min/max safety bounds are [10, 90] and do not reject any built-in preset', () => {
  clearEnv();
  try {
    for (const preset of ['tight', 'normal', 'wide']) {
      process.env.MULTI_RANGE_PRESET = preset;
      const cfg = loadMultiConfig(CHAIN);
      assert.equal(cfg.enabled, true, `preset ${preset} should be enabled under default bounds`);
      assert.equal(cfg.minRangePercent, 10);
      assert.equal(cfg.maxRangePercent, 90);
    }
  } finally {
    clearEnv();
  }
});

test('a resolved width above the configured max fails MULTI closed (fail-closed, never silently clamped)', () => {
  process.env.MULTI_RANGE_PERCENT = '95';
  process.env.MULTI_MAX_RANGE_PERCENT = '90';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.enabled, false);
    assert.match(cfg.disabledReason ?? '', /outside the configured safety bounds/);
    // Never silently coerced to the bound — the operator must fix it explicitly.
    assert.equal(cfg.rangePercent, 95);
  } finally {
    clearEnv();
  }
});

test('a resolved width below the configured min fails MULTI closed', () => {
  process.env.MULTI_RANGE_PERCENT = '5';
  process.env.MULTI_MIN_RANGE_PERCENT = '10';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.enabled, false);
    assert.match(cfg.disabledReason ?? '', /outside the configured safety bounds/);
  } finally {
    clearEnv();
  }
});

test('MULTI_MAX_RANGE_PERCENT <= MULTI_MIN_RANGE_PERCENT is rejected outright', () => {
  process.env.MULTI_MIN_RANGE_PERCENT = '50';
  process.env.MULTI_MAX_RANGE_PERCENT = '50';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.enabled, false);
    assert.match(cfg.disabledReason ?? '', /MULTI_MAX_RANGE_PERCENT must be greater than/);
  } finally {
    clearEnv();
  }
});

test('widening the bounds explicitly allows a previously-out-of-bounds width', () => {
  process.env.MULTI_RANGE_PERCENT = '95';
  process.env.MULTI_MAX_RANGE_PERCENT = '99';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.rangePercent, 95);
  } finally {
    clearEnv();
  }
});

test('validateMultiConfig directly rejects a config object with an out-of-bounds rangePercent', () => {
  const base = loadMultiConfig(CHAIN);
  const result = validateMultiConfig({ ...base, rangePercent: 5, minRangePercent: 10, maxRangePercent: 90 });
  assert.equal(result.valid, false);
});
