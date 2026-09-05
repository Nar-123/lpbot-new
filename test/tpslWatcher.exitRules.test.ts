import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'grammy';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-tpsl-exitrules-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');
process.env.TRADING_MODE = 'staging';

const {
  recordOpenPosition,
  setPositionTpSl,
  setUserPrefs,
  getPositionExitState,
  __resetStoreForTests,
} = await import('../src/db/index.js');
const {
  startTpslWatcher,
  stopTpslWatcher,
  __tickForTests,
  __setTpslDepsForTests,
  __resetTpslDepsForTests,
  __resetTpslWatcherForTests,
  __getPendingCountForTests,
} = await import('../src/bot/tpslWatcher.js');

const CHAIN = 4663;
const fakeBot = { api: { sendMessage: async () => {} } } as unknown as Bot;

function resetDb(): void {
  __resetStoreForTests();
  for (const suffix of ['', '.bak', '.tmp']) {
    try {
      fs.rmSync(`${process.env.DB_PATH!}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
}

let tokenCounter = 5000;
function freshTokenId(): string {
  tokenCounter++;
  return String(tokenCounter);
}

function enrollPosition(tokenId: string): void {
  setUserPrefs(1, { tpSlEnabled: true, tpPercent: 10, slPercent: 15 });
  recordOpenPosition({
    chainId: CHAIN,
    tokenId,
    poolAddress: '0xpool',
    token0: '0xusdg',
    token1: '0xtok',
    fee: 3000,
    tickLower: 0,
    tickUpper: 100,
    protocol: 'v3',
    dex: 'uniswap',
    strategy: 'default',
  });
  setPositionTpSl(CHAIN, tokenId, { enabled: true });
}

test.beforeEach(() => {
  resetDb();
  __resetTpslWatcherForTests();
  __resetTpslDepsForTests();
});

test.after(async () => {
  await stopTpslWatcher();
  resetDb();
});

test('a new rule (pumped_above_range) arms through the real tick() flow, not just in exitRules.ts isolation', async () => {
  const tokenId = freshTokenId();
  enrollPosition(tokenId);
  __setTpslDepsForTests({
    measurePnl: async () => ({
      status: 'active',
      pnlPct: 5,
      pnlUsd: 50,
      label: 'TOK',
      inRange: false,
      ticksAboveUpper: 999_999,
      ageMinutes: 60,
    }),
  });
  startTpslWatcher(fakeBot);
  await __tickForTests();
  assert.equal(__getPendingCountForTests(), 1, 'pumped-above-range should have armed a pending exit');
});

test('trailing-TP state (peak/drawdown) persists to the DB across ticks, keyed to the actual position', async () => {
  const tokenId = freshTokenId();
  enrollPosition(tokenId);
  process.env.EXIT_TRAILING_ENABLED = 'on';
  process.env.EXIT_TRAILING_TRIGGER_PCT = '15';
  process.env.EXIT_TRAILING_DROP_PCT = '5';
  try {
    let pnl = 20;
    __setTpslDepsForTests({
      measurePnl: async () => ({
        status: 'active',
        pnlPct: pnl,
        pnlUsd: 200,
        label: 'TOK',
        inRange: true,
        ticksAboveUpper: 0,
        ageMinutes: 60,
      }),
    });
    startTpslWatcher(fakeBot);
    await __tickForTests();

    const stateAfterArm = getPositionExitState(CHAIN, tokenId);
    assert.equal(stateAfterArm.trailingActive, true, 'peak of 20% should have armed trailing (trigger 15%)');
    assert.equal(stateAfterArm.peakPnlPct, 20);

    pnl = 14;
    await __tickForTests();
    assert.equal(
      __getPendingCountForTests(),
      1,
      'trailing_tp should have armed after the drop from the persisted peak',
    );
  } finally {
    delete process.env.EXIT_TRAILING_ENABLED;
    delete process.env.EXIT_TRAILING_TRIGGER_PCT;
    delete process.env.EXIT_TRAILING_DROP_PCT;
  }
});

test('out-of-range timing is tracked from the FIRST tick a position is seen out of range, not from position open', async () => {
  const tokenId = freshTokenId();
  enrollPosition(tokenId);
  __setTpslDepsForTests({
    measurePnl: async () => ({
      status: 'active',
      pnlPct: 0,
      pnlUsd: 0,
      label: 'TOK',
      inRange: false,
      ticksAboveUpper: 0,
      ageMinutes: 500,
    }),
  });
  startTpslWatcher(fakeBot);
  const before = Date.now();
  await __tickForTests();
  const state = getPositionExitState(CHAIN, tokenId);
  assert.ok(
    state.outOfRangeSinceMs != null && state.outOfRangeSinceMs >= before,
    'OOR timer should start now, not be backdated',
  );
});

test('going back in range clears the out-of-range timer', async () => {
  const tokenId = freshTokenId();
  enrollPosition(tokenId);
  let inRange = false;
  __setTpslDepsForTests({
    measurePnl: async () => ({
      status: 'active',
      pnlPct: 0,
      pnlUsd: 0,
      label: 'TOK',
      inRange,
      ticksAboveUpper: 0,
      ageMinutes: 500,
    }),
  });
  startTpslWatcher(fakeBot);
  await __tickForTests();
  assert.notEqual(getPositionExitState(CHAIN, tokenId).outOfRangeSinceMs, null);

  inRange = true;
  await __tickForTests();
  assert.equal(getPositionExitState(CHAIN, tokenId).outOfRangeSinceMs, null);
});

test('existing flat take-profit/stop-loss behavior is unchanged by the new engine (backward compatibility)', async () => {
  const tokenId = freshTokenId();
  enrollPosition(tokenId);
  __setTpslDepsForTests({
    measurePnl: async () => ({ status: 'active', pnlPct: 12, pnlUsd: 120, label: 'TOK' }),
  });
  startTpslWatcher(fakeBot);
  await __tickForTests();
  assert.equal(
    __getPendingCountForTests(),
    1,
    'take-profit should still arm with zero new fields supplied, exactly like before this feature',
  );
});
