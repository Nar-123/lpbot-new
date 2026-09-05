/**
 * runMultiStrategy's per-candidate loop — does the risk gate see a
 * position opened by an EARLIER candidate in the SAME run, or does it
 * check against a stale snapshot taken before the loop started?
 *
 * Investigation requested before SUB-FASE 3B: with an autonomous scheduler
 * now calling runMultiStrategy(dryRun:false) every 15 minutes
 * unsupervised, a stale-snapshot bug here would let it silently blow past
 * MULTI_MAX_OPEN_POSITIONS/MULTI_MAX_EXPOSURE_USD within a single run,
 * with no human in the loop to notice.
 *
 * === A note on what this suite can and cannot exercise directly ===
 *
 * runMultiStrategy's loop is:
 *   for (const candidate of candidates) {
 *     const result = await evaluateAndExecuteCandidate(candidate, config, {...});
 *     ...
 *   }
 * — sequential (awaited, not Promise.all). evaluateAndExecuteCandidate's
 * FIRST step is pool discovery + evaluateAndExecuteCandidate's own
 * loadLivePoolState(), which calls the REAL loadPool/loadV4Pool with no
 * injection seam in `opts` — the same "needs live RPC, not unit-tested"
 * limitation test/strategy.multiExecute.test.ts's own top-of-file comment
 * already documents for the mint happy-path. So a literal end-to-end
 * runMultiStrategy(dryRun:false) call with 3 candidates cannot be driven
 * to a real `executed` outcome in a unit test without live RPC, and this
 * suite does not attempt to fake one.
 *
 * What CAN be exercised, fully network-free, is the exact mechanism the
 * question is actually about: whether the risk gate
 * (runRiskGate -> checkPositionLimitsAsync -> checkPositionLimits ->
 * listOpenPositions) reflects a position recorded by an earlier,
 * synchronously-awaited call within the same test. That DB read has
 * nothing to do with pool discovery — it is the same call
 * evaluateAndExecuteCandidate's own executeTradeIntent makes, at the same
 * point in the sequence (risk-gate check, then mint, then
 * recordOpenPosition) that runMultiStrategy's loop would produce for real
 * candidates. This suite drives that exact sequence via three consecutive,
 * awaited calls to executeTradeIntent (the same function
 * evaluateAndExecuteCandidate calls internally once pool discovery/range
 * calc succeed) — proving the DB-backed risk gate has no per-run caching
 * or stale-snapshot behavior, independent of whatever pool state a real
 * candidate would have.
 *
 * getTokenMeta's real ERC-20 decimals/symbol/name lookup (the other
 * network dependency inside executeTradeIntent, for the post-mint
 * accounting step) is avoided by pre-seeding its bounded in-process cache
 * (tokens.ts's __setMetaCacheEntryForTests) for the real chain-default
 * USDG address — a legitimate, existing test seam, not a new one added
 * for this suite. getTokenPriceUsd needs no seam at all: the real
 * chain-default USDG short-circuits to a synchronous stable-peg 1.0 (see
 * price/dexscreener.ts), already relied on by every other MULTI test in
 * this codebase that reaches accounting.
 *
 * No multiExecute.ts/multiScheduler.ts logic was changed to make this
 * suite possible — everything above is composed from already-existing
 * exports and test seams.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-multiexec-riskgatefreshness-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { executeTradeIntent } = await import('../src/strategy/multiExecute.js');
const { __resetStoreForTests, listOpenPositions } = await import('../src/db/index.js');
const { __resetMultiCooldownForTests } = await import('../src/strategy/multiRisk.js');
const { __setMetaCacheEntryForTests, __resetMetaCacheForTests } = await import('../src/chain/tokens.js');

const CHAIN = 4663;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as `0x${string}`;

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

function freshToken(): string {
  return `0x${Math.random().toString(16).slice(2).padEnd(40, '0')}`;
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    chainId: CHAIN,
    interval: '6h' as const,
    minMarketCapUsd: 1_000_000,
    minTokenAgeHours: 24,
    minKolCount: 0,
    topN: 10,
    rangePercent: 50,
    rangeMode: 'static' as const,
    rangeTierVolumeUsd: 500_000,
    rangeTierLowPercent: 50,
    rangeTierHighPercent: 30,
    positionSizeUsd: 100, // fixed-USD sizing: no percent-mode price/balance lookup needed
    usdgAddress: USDG,
    poolTvlWeight: 0.3,
    poolVolumeWeight: 0.3,
    poolVolumeTvlWeight: 0.25,
    poolFeeWeight: 0.15,
    maxOpenPositions: 3,
    maxPositionsPerToken: 1,
    maxExposureUsd: 100_000, // generous — this test targets maxOpenPositions, not exposure
    entryCooldownMs: 0, // no cooldown interference between the 3 sequential entries below
    tpPercent: 10,
    slPercent: 15,
    ...overrides,
  };
}

function baseCandidate(address: string) {
  return {
    address,
    symbol: 'TOK',
    name: 'Token',
    chainId: CHAIN,
    marketCapUsd: 2_000_000,
    ageHours: 48,
    volumeUsd: 500_000,
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

function baseIntent(token: string) {
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
  };
}

let mintCallCount = 0;
function fakeMintFn() {
  mintCallCount++;
  const n = mintCallCount;
  return Promise.resolve({
    hash: `0x${'0'.repeat(63)}${n}` as `0x${string}`,
    tokenId: BigInt(n),
    amount0: 0n,
    amount1: 1_000_000n,
    tickLower: 100,
    tickUpper: 200,
    currentTick: 150,
    depositToken: USDG,
    depositAmount: 1_000_000n,
    txLink: `https://example/tx/${n}`,
    poolAddress: '0xpool',
    fee: 50_000,
    token0: USDG,
    token1: `0x${n.toString().padStart(40, '0')}` as `0x${string}`,
    protocol: 'v3' as const,
    dex: 'uniswap' as const,
  });
}

test.beforeEach(() => {
  resetDb();
  __resetMultiCooldownForTests();
  __resetMetaCacheForTests();
  __setMetaCacheEntryForTests(`${CHAIN}:${USDG.toLowerCase()}`, {
    address: USDG,
    symbol: 'USDG',
    name: 'USD Global',
    decimals: 18,
  });
  mintCallCount = 0;
});

test('risk gate reads freshly-updated DB state across sequential executions in the same run: candidates #1 and #2 execute, #3 is rejected POSITION_LIMIT because #1+#2 (opened earlier in THIS run) already filled maxOpenPositions', async () => {
  const cfg = baseConfig({ maxOpenPositions: 2 });
  const tokens = [freshToken(), freshToken(), freshToken()];
  const outcomes: Array<{ tokenId: string; txHash: string } | { skipped: true; reason: string }> = [];

  for (const token of tokens) {
    const outcome = await executeTradeIntent({
      intent: baseIntent(token) as never,
      candidate: baseCandidate(token) as never,
      config: cfg as never,
      prefs: { sizeMode: 'fixed', fixedAmountHuman: 10, balancePercent: 0 } as never,
      verifyLiquidityFn: async () => ({ status: 'OK' }),
      mintFn: fakeMintFn as never,
    });
    outcomes.push(outcome);
  }

  assert.ok(!('skipped' in outcomes[0]!), `candidate #1 must execute, got: ${JSON.stringify(outcomes[0])}`);
  assert.ok(!('skipped' in outcomes[1]!), `candidate #2 must execute, got: ${JSON.stringify(outcomes[1])}`);
  assert.ok('skipped' in outcomes[2]!, `candidate #3 must be rejected, got: ${JSON.stringify(outcomes[2])}`);
  if ('skipped' in outcomes[2]!) {
    assert.equal(
      outcomes[2].reason,
      'POSITION_LIMIT',
      'candidate #3 must be rejected specifically because #1+#2 (opened earlier in THIS SAME run) already reached maxOpenPositions=2 — proves the risk gate re-reads updated DB state per iteration, not a stale snapshot from before the sequence started',
    );
  }

  const openPositions = listOpenPositions(CHAIN).filter((p) => p.strategy === 'multi');
  assert.equal(openPositions.length, 2, 'exactly 2 positions (from #1 and #2) must actually be recorded — #3 never minted');
  assert.equal(mintCallCount, 2, 'mintFn must have been called exactly twice — #3 must never reach the mint step');
});

test('sanity: with maxOpenPositions=3 (enough for all), all three candidates execute — proves the rejection above is a real limit, not an unrelated bug', async () => {
  const cfg = baseConfig({ maxOpenPositions: 3 });
  const tokens = [freshToken(), freshToken(), freshToken()];
  const outcomes: Array<{ tokenId: string; txHash: string } | { skipped: true; reason: string }> = [];

  for (const token of tokens) {
    const outcome = await executeTradeIntent({
      intent: baseIntent(token) as never,
      candidate: baseCandidate(token) as never,
      config: cfg as never,
      prefs: { sizeMode: 'fixed', fixedAmountHuman: 10, balancePercent: 0 } as never,
      verifyLiquidityFn: async () => ({ status: 'OK' }),
      mintFn: fakeMintFn as never,
    });
    outcomes.push(outcome);
  }

  for (const [i, outcome] of outcomes.entries()) {
    assert.ok(!('skipped' in outcome), `candidate #${i + 1} must execute when the limit is high enough, got: ${JSON.stringify(outcome)}`);
  }
  assert.equal(mintCallCount, 3);
});
