/**
 * Per-rule confirmation delay (getConfirmMsForRule, src/bot/tpslWatcher.ts).
 *
 * trailing_tp gets its own, longer confirmation window (default 10s,
 * EXIT_TRAILING_CONFIRM_MS) — trailing exits are more noise-prone than a
 * flat TP/SL level, so a longer confirm filters out a brief wobble off a
 * fresh peak. The other 6 rules keep the pre-existing 5s window (now also
 * configurable via TPSL_CONFIRM_MS, but unchanged by default) so
 * stop-loss/take-profit/etc. stay exactly as responsive as before this
 * rule existed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'grammy';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-tpsl-confirmms-test-'));
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
  __getConfirmMsForRuleForTests,
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

let tokenCounter = 20_000;
function freshTokenId(): string {
  tokenCounter++;
  return String(tokenCounter);
}

function enrollPosition(tokenId: string, tpPercent: number, slPercent: number): void {
  setUserPrefs(1, { tpSlEnabled: true, tpPercent, slPercent });
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
  setPositionTpSl(CHAIN, tokenId, { enabled: true, tpPercent, slPercent });
}

function fakeCloseResult(tokenId: string) {
  return {
    hash: '0xCoNfIrMmStEsThAsH000000000000000000000000000000000001' as `0x${string}`,
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

test.beforeEach(() => {
  __resetTpslWatcherForTests();
  resetDb();
});

test.after(async () => {
  await stopTpslWatcher();
  resetDb();
});

// ── getConfirmMsForRule: pure env resolution ────────────────────────────

test('getConfirmMsForRule: trailing_tp defaults to 10000ms', () => {
  delete process.env.EXIT_TRAILING_CONFIRM_MS;
  assert.equal(__getConfirmMsForRuleForTests('trailing_tp'), 10_000);
});

test('getConfirmMsForRule: every other rule defaults to 5000ms, unchanged from before this feature', () => {
  delete process.env.TPSL_CONFIRM_MS;
  for (const rule of [
    'stop_loss',
    'take_profit',
    'safety_exit',
    'pumped_above_range',
    'out_of_range',
    'low_yield',
  ] as const) {
    assert.equal(__getConfirmMsForRuleForTests(rule), 5_000, `${rule} must default to 5000ms`);
  }
});

test('getConfirmMsForRule: EXIT_TRAILING_CONFIRM_MS overrides trailing_tp only', () => {
  process.env.EXIT_TRAILING_CONFIRM_MS = '15000';
  try {
    assert.equal(__getConfirmMsForRuleForTests('trailing_tp'), 15_000);
    assert.equal(
      __getConfirmMsForRuleForTests('take_profit'),
      5_000,
      'non-trailing rules must be unaffected by EXIT_TRAILING_CONFIRM_MS',
    );
  } finally {
    delete process.env.EXIT_TRAILING_CONFIRM_MS;
  }
});

test('getConfirmMsForRule: TPSL_CONFIRM_MS overrides the 6 non-trailing rules, never trailing_tp', () => {
  process.env.TPSL_CONFIRM_MS = '8000';
  try {
    assert.equal(__getConfirmMsForRuleForTests('take_profit'), 8_000);
    assert.equal(__getConfirmMsForRuleForTests('stop_loss'), 8_000);
    assert.equal(
      __getConfirmMsForRuleForTests('trailing_tp'),
      10_000,
      'trailing_tp must stay on its own default unless EXIT_TRAILING_CONFIRM_MS is set',
    );
  } finally {
    delete process.env.TPSL_CONFIRM_MS;
  }
});

// ── End-to-end (real timers, mirrors tpslWatcher.closeLock.test.ts) ─────

test(
  'end-to-end: an armed trailing_tp does not close before 10s (even though the condition still holds at 6s), and closes once the 10s confirm elapses',
  async () => {
    const tokenId = freshTokenId();
    // tp/sl set far out of reach (400 is the highest value parseTpSlPercent
    // in db/index.ts accepts before falling back to the 10/15 default) so
    // only the trailing rule can ever match for the pnl values used below
    // (20% then 14%) — isolates rule 7 from rules 1/2's higher priority.
    enrollPosition(tokenId, 400, 400);
    process.env.EXIT_TRAILING_ENABLED = 'on';
    process.env.EXIT_TRAILING_TRIGGER_PCT = '15';
    process.env.EXIT_TRAILING_DROP_PCT = '5';

    let pnl = 20;
    let closeCalls = 0;
    __setTpslDepsForTests({
      measurePnl: async () => ({ status: 'active', pnlPct: pnl, pnlUsd: 100, label: 'TOK' }),
      closePosition: async () => {
        closeCalls++;
        return fakeCloseResult(tokenId);
      },
    });

    try {
      startTpslWatcher(fakeBot);
      await __tickForTests(fakeBot); // pnl=20 -> arms trailing state (peak=20), no rule hit yet
      pnl = 14; // 6% off the 20% peak — crosses the 5% drop trigger
      await __tickForTests(fakeBot); // hits trailing_tp -> arms pending with the 10s confirm timer

      await new Promise((r) => setTimeout(r, 6_000));
      assert.equal(
        closeCalls,
        0,
        'trailing_tp must NOT close at 6s — its confirm window is 10s, not the old 5s',
      );

      await new Promise((r) => setTimeout(r, 4_800)); // ~10.8s since arm
      assert.equal(
        closeCalls,
        1,
        'trailing_tp must close once the 10s confirm window elapses with the condition still met',
      );
    } finally {
      delete process.env.EXIT_TRAILING_ENABLED;
      delete process.env.EXIT_TRAILING_TRIGGER_PCT;
      delete process.env.EXIT_TRAILING_DROP_PCT;
      await stopTpslWatcher();
    }
  },
  { timeout: 15_000 },
);

test(
  'end-to-end comparison: stop_loss still closes at ~5s — it is NOT delayed to trailing_tp\'s 10s window',
  async () => {
    const tokenId = freshTokenId();
    enrollPosition(tokenId, 10, 15);
    let closeCalls = 0;
    __setTpslDepsForTests({
      measurePnl: async () => ({ status: 'active', pnlPct: -20, pnlUsd: -200, label: 'TOK', ageMinutes: 60 }),
      closePosition: async () => {
        closeCalls++;
        return fakeCloseResult(tokenId);
      },
    });

    try {
      startTpslWatcher(fakeBot);
      await __tickForTests(fakeBot); // arms stop_loss with the unchanged 5s confirm timer

      await new Promise((r) => setTimeout(r, 5_300));
      assert.equal(
        closeCalls,
        1,
        'stop_loss must still close at ~5s, proving only trailing_tp got the longer 10s window',
      );
    } finally {
      await stopTpslWatcher();
    }
  },
  { timeout: 10_000 },
);
