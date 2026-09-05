import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'grammy';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-tpsl-weights-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const {
  recordOpenPosition,
  setPositionTpSl,
  setUserPrefs,
  getTunedSignalWeights,
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

function fakeCloseResult(tokenId: string) {
  return {
    hash: '0xabc' as `0x${string}`,
    tokenId: BigInt(tokenId),
    amount0: 0n,
    amount1: 0n,
    amount0Human: 1,
    amount1Human: 0,
    expected0: 0n,
    expected1: 0n,
    withdrawalUsd: 100,
    feesPortionUsd: 0,
    feeSplitIsEstimated: true,
    txLink: 'https://example/tx/0xabc',
    token0: '0xusdg' as `0x${string}`,
    token1: '0xtok' as `0x${string}`,
    symbol0: 'USDG',
    symbol1: 'TOK',
  };
}

let tokenCounter = 9000;
function freshTokenId(): string {
  tokenCounter++;
  return String(tokenCounter);
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

test('a real close (tick -> 5s confirm -> executeClose) persists a tuned-weights record', async () => {
  const tokenId = freshTokenId();
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
    strategy: 'multi',
    entrySignals: {
      marketCapUsd: 5_000_000,
      volumeUsd: 100_000,
      ageHours: 48,
      poolTvlUsd: 50_000,
      poolVolumeUsd: 25_000,
      poolVolumeTvlRatio: 0.5,
      poolFee: 3000,
    },
  });
  setPositionTpSl(CHAIN, tokenId, { enabled: true });

  assert.equal(getTunedSignalWeights(), null, 'no tuned weights should exist before any close');

  __setTpslDepsForTests({
    measurePnl: async () => ({ status: 'active', pnlPct: 15, pnlUsd: 150, label: 'TOK' }),
    closePosition: async () => fakeCloseResult(tokenId),
  });

  startTpslWatcher(fakeBot);
  await __tickForTests();
  assert.equal(__getPendingCountForTests(), 1, 'take-profit should have armed');

  // Let the real 5s confirm timer fire — same real-wall-clock pattern
  // tpslWatcher.shutdown.test.ts already uses for confirm-path tests.
  await new Promise((resolve) => setTimeout(resolve, 5_500));

  const tuned = getTunedSignalWeights();
  assert.notEqual(tuned, null, 'a tuned-weights record should exist — recalculation ran after the close');
});
