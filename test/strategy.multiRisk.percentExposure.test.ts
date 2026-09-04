/**
 * Phase 4.8 — capital-safety finding (Priority 1, item 2).
 *
 * Root cause (src/strategy/multiRisk.ts, before this fix): Phase 4.7's F-03
 * fix made the exposure cap pre-emptive (existing + incoming vs the cap)
 * ONLY for fixed-USD sizing (MULTI_POSITION_SIZE_USD set), because that is
 * the only mode with a USD figure available before mint. Percent-of-balance
 * sizing (MULTI_POSITION_SIZE_USD unset, UserPrefs.sizeMode === 'percent')
 * has no such figure — `checkPositionLimits`'s `incomingUsd` fell back to
 * `config.positionSizeUsd ?? 0`, i.e. exactly 0, for every percent-mode
 * entry. The cap only ever fired once the position was already open and its
 * real size showed up in the NEXT check — one position late, every time.
 *
 * Fix: `checkPositionLimitsAsync` (called by `runRiskGate`) now estimates
 * the incoming position's USD size pre-mint for BOTH sizing modes, using an
 * injectable `IncomingExposureEstimator` (the same DI pattern this codebase
 * already uses for mintFn/poolFetcher/verifyLiquidityFn) — the real
 * (`defaultEstimateIncomingExposureUsd`) implementation reads the wallet's
 * current quote-asset balance and its live price, the same inputs
 * mintSingleSided itself uses moments later for the real deposit.
 *
 * This suite proves the gate is genuinely pre-emptive in percent mode via
 * `runRiskGate` itself (the actual call path multiExecute.ts uses), with an
 * injected estimator so the test needs no live RPC/price-API access —
 * exactly the tradeoff this codebase's own test suite documents for
 * multiExecute.ts's network-touching branches.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-multirisk-pctexposure-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { recordOpenPosition, recordMultiPositionMeta, __resetStoreForTests } = await import(
  '../src/db/index.js'
);
const { runRiskGate, checkPositionLimitsAsync, defaultEstimateIncomingExposureUsd } =
  await import('../src/strategy/multiRisk.js');

const CHAIN = 4663;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'; // real chain-default USDG (stable-peg, price=1, no network)

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
    minCandidateVolumeUsd: 0,
    topN: 10,
    rangePercent: 50,
    positionSizeUsd: null, // percent-of-balance mode: no fixed-USD figure configured
    usdgAddress: USDG,
    poolTvlWeight: 0.3,
    poolVolumeWeight: 0.3,
    poolVolumeTvlWeight: 0.25,
    poolFeeWeight: 0.15,
    maxOpenPositions: 10,
    maxPositionsPerToken: 1,
    maxExposureUsd: 500,
    entryCooldownMs: 300_000,
    tpPercent: 10,
    slPercent: 15,
    ...overrides,
  };
}

function percentIntent(token: string, balancePercent: number) {
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
    positionSize: { sizeMode: 'percent' as const, balancePercent },
    depositToken: USDG,
    reason: 'test',
    candidateScore: 1,
    poolScore: 0.5,
  };
}

function openMultiPositionWithMeta(tokenId: string, positionSizeUsd: number): void {
  recordOpenPosition({
    chainId: CHAIN,
    tokenId,
    poolAddress: '0xpool',
    token0: USDG,
    token1: tokenId,
    fee: 3000,
    tickLower: 0,
    tickUpper: 100,
    strategy: 'multi',
  });
  recordMultiPositionMeta({
    chainId: CHAIN,
    tokenId,
    candidateSource: 'gmgn_trending_6h',
    candidateInterval: '6h',
    candidateMarketCapUsd: null,
    candidateAgeHours: null,
    candidateVolume6hUsd: null,
    candidateClassification: 'MEME',
    candidateScore: 1,
    poolAddress: '0xpool',
    poolFee: 3000,
    poolTvlUsd: null,
    poolVolumeUsd: null,
    poolScore: 1,
    entryPrice: null,
    tickLower: 0,
    tickUpper: 100,
    positionSizeUsd,
    timestamp: Date.now(),
  });
}

test('runRiskGate: percent-of-balance sizing is now pre-emptive — blocks once existing + a real incoming estimate would reach the cap', async () => {
  resetDb();
  const cfg = baseConfig({ maxExposureUsd: 500 });

  // $400 already open (fixed-USD position from an earlier entry, or another
  // percent-mode entry whose actual deposit was recorded as $400).
  openMultiPositionWithMeta(freshToken(), 400);

  // A wallet holding $1000 of USDG, sizing this entry at 30% of balance ->
  // a real incoming estimate of $300. Existing $400 + incoming $300 = $700,
  // over the $500 cap — this must be rejected BEFORE mint, not one position
  // later. Pre-fix, percent mode always contributed incomingUsd=0 here, so
  // this would have passed.
  const fakeEstimator = async () => 1000 * 0.3;
  const intent = percentIntent(freshToken(), 30);

  const results = await runRiskGate(intent as never, cfg as never, {
    exposureEstimator: fakeEstimator,
  });
  const exposureResult = results.find((r) => r.reason === 'POSITION_LIMIT' || r.pass === false);
  assert.ok(
    results.some((r) => !r.pass),
    'percent-mode entry must be blocked once a real pre-mint estimate shows existing + incoming over the cap',
  );
  assert.equal(exposureResult?.reason, 'POSITION_LIMIT');
});

test('runRiskGate: percent-of-balance sizing still passes when the real incoming estimate keeps total exposure under the cap', async () => {
  resetDb();
  const cfg = baseConfig({ maxExposureUsd: 500 });
  openMultiPositionWithMeta(freshToken(), 100);

  // 10% of a $500 wallet -> incoming $50. Existing $100 + incoming $50 = $150, under $500.
  const fakeEstimator = async () => 500 * 0.1;
  const intent = percentIntent(freshToken(), 10);

  const results = await runRiskGate(intent as never, cfg as never, {
    exposureEstimator: fakeEstimator,
  });
  assert.ok(
    results.every((r) => r.pass),
    'a percent-mode entry that genuinely stays under the cap must still be allowed',
  );
});

test('checkPositionLimitsAsync: a null estimate (price/balance lookup failed) fails the gate closed, never treated as $0', async () => {
  resetDb();
  const cfg = baseConfig({ maxExposureUsd: 500 });
  const failingEstimator = async () => null;

  const result = await checkPositionLimitsAsync(
    cfg as never,
    CHAIN,
    freshToken(),
    { sizeMode: 'percent', balancePercent: 10 },
    failingEstimator,
  );
  assert.equal(result.pass, false, 'an unavailable exposure estimate must never be silently treated as $0 exposure');
  assert.equal(result.reason, 'EXPOSURE_ESTIMATE_UNAVAILABLE');
});

test('defaultEstimateIncomingExposureUsd: fixed-USD sizing (MULTI_POSITION_SIZE_USD set) returns it directly, no price/balance lookup needed', async () => {
  const cfg = baseConfig({ positionSizeUsd: 250 });
  const estimate = await defaultEstimateIncomingExposureUsd(cfg as never, {
    sizeMode: 'percent',
    balancePercent: 99, // must be ignored — fixed-USD config always wins
  });
  assert.equal(estimate, 250);
});

test('defaultEstimateIncomingExposureUsd: a prefs-driven fixed token amount is converted to USD via the live quote price', async () => {
  const cfg = baseConfig({ positionSizeUsd: null });
  // Real chain-default USDG is a synchronous stable-peg (price=1) — no network call.
  const estimate = await defaultEstimateIncomingExposureUsd(cfg as never, {
    sizeMode: 'fixed',
    fixedAmountHuman: 42,
  });
  assert.equal(estimate, 42);
});
