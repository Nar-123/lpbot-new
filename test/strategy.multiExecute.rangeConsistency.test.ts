/**
 * Range-width consistency between the two places multiExecute.ts computes a
 * width for the SAME candidate (FASE 2 follow-up):
 *
 *   1. evaluateAndExecuteCandidate's computeMultiRange() call — the range
 *      used for the risk-gate/dry-run TradeIntent.
 *   2. executeTradeIntent's mintFn() call — the width ACTUALLY used for the
 *      real on-chain mint (mintFn independently recomputes ticks from fresh
 *      pool state — a pre-existing, documented design, see Phase 4.7 F-14 —
 *      but the WIDTH PERCENT handed to it must still match #1 exactly).
 *
 * evaluateAndExecuteCandidate's computeMultiRange call needs a real pool
 * (loadLivePoolState calls the real loadPool/loadV4Pool with no injection
 * seam — same "needs live RPC" limitation this file's own top-of-file
 * comment already documents for the mint happy-path), so it cannot be
 * exercised end-to-end without network access. Consistency between #1 and
 * #2 is instead proven two ways:
 *
 *   (a) Behaviorally, in isolation: executeTradeIntent (point #2) is called
 *       directly with a mocked mintFn, for a high-volume and a low-volume
 *       candidate, asserting the exact widthPercent mintFn receives matches
 *       resolveRangePercentForCandidate(candidate, config) computed
 *       independently — proving point #2 is wired correctly on its own.
 *   (b) Structurally: source inspection proves BOTH call sites pass the
 *       literal expression `resolveRangePercentForCandidate(candidate,
 *       config)` — the identical pure function, the identical `candidate`
 *       and `config` variables, in the same function scope for each site —
 *       so #1 and #2 cannot diverge for the same candidate+config; there is
 *       no code path where they read from different values.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-multiexec-rangeconsistency-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { executeTradeIntent, resolveRangePercentForCandidate } = await import('../src/strategy/multiExecute.js');
const { __resetStoreForTests } = await import('../src/db/index.js');
const { __resetMultiCooldownForTests } = await import('../src/strategy/multiRisk.js');

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

const CHAIN = 4663;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

function config(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    chainId: CHAIN,
    interval: '6h' as const,
    minMarketCapUsd: 1_000_000,
    minTokenAgeHours: 24,
    topN: 10,
    rangePercent: 50,
    rangeMode: 'volume_tiered' as const,
    rangeTierVolumeUsd: 500_000,
    rangeTierLowPercent: 20,
    rangeTierHighPercent: 70,
    positionSizeUsd: 100,
    usdgAddress: USDG,
    poolTvlWeight: 0.3,
    poolVolumeWeight: 0.3,
    poolVolumeTvlWeight: 0.25,
    poolFeeWeight: 0.15,
    maxOpenPositions: 3,
    maxPositionsPerToken: 1,
    maxExposureUsd: 500,
    entryCooldownMs: 300_000,
    tpPercent: 10,
    slPercent: 15,
    ...overrides,
  };
}

function candidate(address: string, volume6hUsd: number) {
  return {
    address,
    symbol: 'TOK',
    name: 'Token',
    chainId: CHAIN,
    marketCapUsd: 2_000_000,
    ageHours: 48,
    volume6hUsd,
    liquidityUsd: 200_000,
    kolCount: 10,
    classification: 'MEME' as const,
    launchpadPlatform: 'pump.fun',
    candidateScore: 1,
    reasons: [],
    source: 'gmgn_trending_6h' as const,
    sourceTimestamp: Date.now(),
  };
}

function intent(token: string, overrides: Record<string, unknown> = {}) {
  return {
    strategy: 'multi' as const,
    chainId: CHAIN,
    token,
    quoteToken: USDG,
    pool: {
      poolAddress: '0xpool',
      protocol: 'v3' as const,
      dex: 'uniswap' as const,
      fee: 50_000,
      tvlUsd: 100_000,
      volumeUsd: 50_000,
      liquidityUsd: 100_000,
      currentPrice: null,
      sourceTimestamp: Date.now(),
      totalScore: 0.5,
      tvlScore: 0.5,
      volumeScore: 0.5,
      volumeTvlScore: 0.5,
      feeScore: 1,
      reasons: [],
      rejectedReasons: [],
    },
    fee: 50_000,
    side: 'above' as const,
    range: { tickLower: 100, tickUpper: 200 },
    positionSize: { sizeMode: 'fixed' as const, fixedAmountHuman: 100 },
    depositToken: USDG,
    reason: 'test',
    candidateScore: 1,
    poolScore: 0.5,
    ...overrides,
  };
}

function freshToken(): string {
  return `0x${Math.random().toString(16).slice(2).padEnd(40, '0')}`;
}

// ── (a) Behavioral: point #2 (mintFn's widthPercent) via executeTradeIntent ──

test('executeTradeIntent: a high-volume candidate (>= tier) sends mintFn the SAME widthPercent resolveRangePercentForCandidate computes (rangeTierHighPercent)', async () => {
  resetDb();
  __resetMultiCooldownForTests();
  const cfg = config();
  const token = freshToken();
  const c = candidate(token, 600_000); // >= rangeTierVolumeUsd (500_000)
  const expected = resolveRangePercentForCandidate(c as never, cfg as never);
  assert.equal(expected, 70, 'sanity: high-volume candidate resolves to rangeTierHighPercent');

  let receivedWidthPercent: number | undefined;
  await executeTradeIntent({
    intent: intent(token) as never,
    candidate: c as never,
    config: cfg as never,
    prefs: { sizeMode: 'fixed', fixedAmountHuman: 10, balancePercent: 0 } as never,
    verifyLiquidityFn: async () => ({ status: 'OK' }),
    mintFn: async (params) => {
      receivedWidthPercent = params.widthPercent;
      throw new Error('stop here — proves mintFn was reached with the right args, not a real mint');
    },
  });

  assert.equal(receivedWidthPercent, expected, 'mintFn must receive exactly resolveRangePercentForCandidate\'s result');
  assert.equal(receivedWidthPercent, 70);
});

test('executeTradeIntent: a low-volume candidate (< tier) sends mintFn the SAME widthPercent resolveRangePercentForCandidate computes (rangeTierLowPercent)', async () => {
  resetDb();
  __resetMultiCooldownForTests();
  const cfg = config();
  const token = freshToken();
  const c = candidate(token, 400_000); // < rangeTierVolumeUsd (500_000)
  const expected = resolveRangePercentForCandidate(c as never, cfg as never);
  assert.equal(expected, 20, 'sanity: low-volume candidate resolves to rangeTierLowPercent');

  let receivedWidthPercent: number | undefined;
  await executeTradeIntent({
    intent: intent(token) as never,
    candidate: c as never,
    config: cfg as never,
    prefs: { sizeMode: 'fixed', fixedAmountHuman: 10, balancePercent: 0 } as never,
    verifyLiquidityFn: async () => ({ status: 'OK' }),
    mintFn: async (params) => {
      receivedWidthPercent = params.widthPercent;
      throw new Error('stop here — proves mintFn was reached with the right args, not a real mint');
    },
  });

  assert.equal(receivedWidthPercent, expected, 'mintFn must receive exactly resolveRangePercentForCandidate\'s result');
  assert.equal(receivedWidthPercent, 20);
});

test('executeTradeIntent: rangeMode="static" always sends mintFn config.rangePercent, regardless of candidate volume (regression guard)', async () => {
  resetDb();
  __resetMultiCooldownForTests();
  const cfg = config({ rangeMode: 'static', rangePercent: 42 });
  const token = freshToken();
  const c = candidate(token, 999_999_999); // would be "high tier" if tiering were mistakenly still active

  let receivedWidthPercent: number | undefined;
  await executeTradeIntent({
    intent: intent(token) as never,
    candidate: c as never,
    config: cfg as never,
    prefs: { sizeMode: 'fixed', fixedAmountHuman: 10, balancePercent: 0 } as never,
    verifyLiquidityFn: async () => ({ status: 'OK' }),
    mintFn: async (params) => {
      receivedWidthPercent = params.widthPercent;
      throw new Error('stop here');
    },
  });

  assert.equal(receivedWidthPercent, 42);
});

// ── (b) Structural: both call sites use the identical expression ───────────

test('structural: both computeMultiRange (point #1) and mintFn (point #2) in multiExecute.ts pass literally resolveRangePercentForCandidate(candidate, config) as widthPercent — they cannot diverge', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'strategy', 'multiExecute.ts'), 'utf8');

  const occurrences = [...src.matchAll(/widthPercent:\s*resolveRangePercentForCandidate\(candidate,\s*config\)/g)];
  assert.equal(
    occurrences.length,
    2,
    `expected exactly 2 call sites (computeMultiRange in evaluateAndExecuteCandidate, mintFn in executeTradeIntent) to pass widthPercent: resolveRangePercentForCandidate(candidate, config) — found ${occurrences.length}. ` +
      'If this count ever drops, one of the two sites regressed back to a hardcoded config.rangePercent.',
  );

  // Sanity: no remaining bare `widthPercent: config.rangePercent` anywhere in the file.
  assert.doesNotMatch(
    src,
    /widthPercent:\s*config\.rangePercent/,
    'no call site should hardcode config.rangePercent directly anymore — both must go through resolveRangePercentForCandidate',
  );
});
