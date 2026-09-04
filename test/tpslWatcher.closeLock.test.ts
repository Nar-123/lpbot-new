/**
 * Phase 4.8 — capital-safety finding (Priority 1, item 1).
 *
 * Root cause: tpslWatcher.ts tracked in-flight closes in its own
 * module-private `closing` Set, invisible to bot.ts's manual /close
 * handler (executeClosePosition). If a TP/SL auto-close and a manual
 * /close both ran on the same position at the same time, neither side
 * knew about the other — each would proceed straight to closePosition(),
 * relying on the chain call itself to fail one of them silently instead
 * of being rejected up front with a clear reason.
 *
 * Fix: both sides now acquire the same lock, in src/bot/positionCloseLock.ts,
 * keyed by `${chainId}:${tokenId}`, before calling closePosition(). Whichever
 * side loses the race is rejected immediately (no closePosition() call, no
 * silent chain-level race) — proven here from the TP/SL watcher's side (this
 * suite; bot.ts has no unit-test harness in this codebase) and from the
 * lock module's own perspective (the reverse direction: TP/SL holds it,
 * a simulated manual close attempt is rejected).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'grammy';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-tpsl-closelock-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { recordOpenPosition, setPositionTpSl, setUserPrefs, __resetStoreForTests } =
  await import('../src/db/index.js');
const {
  startTpslWatcher,
  stopTpslWatcher,
  __tickForTests,
  __setTpslDepsForTests,
  __resetTpslWatcherForTests,
  __isClosingForTests,
} = await import('../src/bot/tpslWatcher.js');
const { closeLockKey, tryAcquireCloseLock, releaseCloseLock } = await import(
  '../src/bot/positionCloseLock.js'
);

const CHAIN = 4663;
const CONFIRM_MS = 5_000;

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

let tokenCounter = 9000;
function freshTokenId(): string {
  tokenCounter++;
  return String(tokenCounter);
}

function enrollPosition(tokenId: string): void {
  setUserPrefs(1, { tpSlEnabled: true });
  recordOpenPosition({
    chainId: CHAIN,
    tokenId,
    poolAddress: '0xpool',
    token0: '0xusdg',
    token1: '0xtok',
    fee: 3000,
    tickLower: 0,
    tickUpper: 100,
  });
  setPositionTpSl(CHAIN, tokenId, { enabled: true, tpPercent: 10, slPercent: 15 });
}

function fakeCloseResult(tokenId: string) {
  return {
    hash: '0xClOsElOcKtEsThAsH00000000000000000000000000000000000001' as `0x${string}`,
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

function resetAll(): void {
  __resetTpslWatcherForTests();
  resetDb();
  // Note: tokenCounter is intentionally NOT reset here (unlike sibling
  // suites) so every test in this file gets a distinct tokenId — this
  // suite asserts on shared cross-module lock state (positionCloseLock.ts),
  // and reusing a tokenId across tests could let one test's leftover lock
  // mask a real bug in another.
}

test('a manual close already holding the shared lock blocks the TP/SL watcher from also closing the same position', async () => {
  resetAll();
  const tokenId = freshTokenId();
  enrollPosition(tokenId);

  // Simulate bot.ts's manual /close having already acquired the shared
  // lock for this exact position, before the TP/SL trigger fires.
  const lockKey = closeLockKey(CHAIN, tokenId);
  assert.equal(tryAcquireCloseLock(lockKey), true, 'sanity: lock starts free');

  let closeCalls = 0;
  __setTpslDepsForTests({
    measurePnl: async () => ({ status: 'active', pnlPct: 15, pnlUsd: 100, label: 'TOK' }), // TP hit (10%)
    closePosition: async () => {
      closeCalls++;
      return fakeCloseResult(tokenId);
    },
  });

  try {
    startTpslWatcher(fakeBot);
    await __tickForTests(fakeBot); // arms the real 5s confirmation timer
    await new Promise((r) => setTimeout(r, CONFIRM_MS + 300)); // let it fire -> recheckAndMaybeClose

    assert.equal(
      closeCalls,
      0,
      'closePosition must never be called for a position whose lock is already held by the manual close path',
    );
    assert.equal(
      __isClosingForTests(CHAIN, tokenId),
      true,
      'the lock must remain held by whoever acquired it first (the simulated manual close) — TP/SL must not have touched it',
    );
  } finally {
    releaseCloseLock(lockKey); // simulate the manual close finishing
    await stopTpslWatcher();
  }
}, { timeout: CONFIRM_MS + 5_000 });

test('an in-flight TP/SL close holding the shared lock rejects a concurrent manual-close attempt for the same position', async () => {
  resetAll();
  const tokenId = freshTokenId();
  enrollPosition(tokenId);

  let releaseClose!: () => void;
  const gate = new Promise<void>((r) => {
    releaseClose = r;
  });
  let closeCalls = 0;
  __setTpslDepsForTests({
    measurePnl: async () => ({ status: 'active', pnlPct: 15, pnlUsd: 100, label: 'TOK' }),
    closePosition: async () => {
      closeCalls++;
      await gate; // simulates the close being in flight (already broadcasting)
      return fakeCloseResult(tokenId);
    },
  });

  try {
    startTpslWatcher(fakeBot);
    await __tickForTests(fakeBot); // arms the real 5s confirmation timer
    await new Promise((r) => setTimeout(r, CONFIRM_MS + 300)); // let it fire -> executeClose starts, now gated

    assert.equal(closeCalls, 1, 'sanity: the TP/SL close has genuinely started and holds the lock');
    assert.equal(__isClosingForTests(CHAIN, tokenId), true);

    // Simulate bot.ts's manual /close handler attempting the same position
    // while the TP/SL close is in flight — it must be rejected, exactly the
    // same mechanism bot.ts's executeClosePosition uses in production.
    const lockKey = closeLockKey(CHAIN, tokenId);
    assert.equal(
      tryAcquireCloseLock(lockKey),
      false,
      'a concurrent manual close attempt must be rejected while the TP/SL close is in flight, not allowed to race it',
    );
  } finally {
    releaseClose();
    await stopTpslWatcher();
  }

  // Once the TP/SL close has actually finished, the lock is free again —
  // proving this is a real race-prevention gate, not a permanent leak.
  assert.equal(__isClosingForTests(CHAIN, tokenId), false);
}, { timeout: CONFIRM_MS + 5_000 });
