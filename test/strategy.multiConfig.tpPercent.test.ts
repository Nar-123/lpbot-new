/**
 * MULTI_TP_PERCENT config wiring — the level MULTI auto-enrolls new
 * positions at (distinct from manual /tp per-user overrides). Default
 * raised from 10 to 50 per operator request; env override still honored.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';

const { loadMultiConfig } = await import('../src/strategy/multiConfig.js');

const CHAIN = 4663;

function clearEnv(): void {
  delete process.env.MULTI_TP_PERCENT;
}

test('MULTI_TP_PERCENT defaults to 50 when unset', () => {
  clearEnv();
  const cfg = loadMultiConfig(CHAIN);
  assert.equal(cfg.tpPercent, 50);
});

test('a valid MULTI_TP_PERCENT override is honored', () => {
  process.env.MULTI_TP_PERCENT = '25';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.tpPercent, 25);
  } finally {
    clearEnv();
  }
});
