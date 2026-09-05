/**
 * SUB-FASE 3C — MULTI_CANDIDATE_INTERVAL config wiring.
 *
 * On THIS branch, default is '5m' (deliberately faster/higher-risk than
 * master's '6h' — the two are not reconciled). A present value is always
 * honored as-is if valid (including explicitly opting back into '6h');
 * a present-but-invalid value fails MULTI closed with a clear reason,
 * mirroring this file's other MULTI_* enum-like validators
 * (assertValidStrategyEnv, MULTI_RANGE_MODE).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';

const { loadMultiConfig, validateMultiConfig } = await import('../src/strategy/multiConfig.js');

const CHAIN = 4663;

function clearEnv(): void {
  delete process.env.MULTI_CANDIDATE_INTERVAL;
}

test.afterEach(clearEnv);

test('MULTI_CANDIDATE_INTERVAL defaults to "5m" when unset (this branch\'s deliberately faster/higher-risk default)', () => {
  const cfg = loadMultiConfig(CHAIN);
  assert.equal(cfg.interval, '5m');
  assert.equal(cfg.enabled, true);
});

test('MULTI_CANDIDATE_INTERVAL=6h explicitly opts back into the old interval — MULTI stays enabled', () => {
  process.env.MULTI_CANDIDATE_INTERVAL = '6h';
  const cfg = loadMultiConfig(CHAIN);
  assert.equal(cfg.interval, '6h');
  assert.equal(cfg.enabled, true);
});

test('every documented valid interval (1m/5m/1h/6h/24h) is honored and keeps MULTI enabled', () => {
  for (const iv of ['1m', '5m', '1h', '6h', '24h'] as const) {
    process.env.MULTI_CANDIDATE_INTERVAL = iv;
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.interval, iv);
    assert.equal(cfg.enabled, true, `interval ${iv} must keep MULTI enabled`);
  }
});

test('MULTI_CANDIDATE_INTERVAL=garbage disables MULTI with a reason naming the received value and the valid list', () => {
  process.env.MULTI_CANDIDATE_INTERVAL = 'garbage';
  const cfg = loadMultiConfig(CHAIN);
  assert.equal(cfg.enabled, false);
  assert.match(cfg.disabledReason ?? '', /MULTI_CANDIDATE_INTERVAL/);
  assert.match(cfg.disabledReason ?? '', /garbage/);
  assert.match(cfg.disabledReason ?? '', /1m/);
  assert.match(cfg.disabledReason ?? '', /24h/);
  const v = validateMultiConfig(cfg);
  assert.equal(v.valid, false);
});

test('MULTI_CANDIDATE_INTERVAL="7h" (a plausible-looking but unsupported value) also fails closed, not silently coerced to the nearest valid one', () => {
  process.env.MULTI_CANDIDATE_INTERVAL = '7h';
  const cfg = loadMultiConfig(CHAIN);
  assert.equal(cfg.enabled, false);
  assert.match(cfg.disabledReason ?? '', /MULTI_CANDIDATE_INTERVAL "7h"/);
});
