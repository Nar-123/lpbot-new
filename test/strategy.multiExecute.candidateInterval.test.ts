/**
 * SUB-FASE 3C — MultiPositionMeta.candidateInterval must record whatever
 * config.interval was actually in effect for that execution, never a
 * hardcoded '6h'. Uses the same network-free executeTradeIntent pattern as
 * strategy.multiExecute.riskGateFreshness.test.ts (metaCache pre-seed for
 * the real chain-default USDG address) — see that file's own top-of-file
 * comment for why this is possible without live RPC and why it's the
 * closest achievable proxy for a real MULTI execution in a unit test.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-multiexec-candidateinterval-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { executeTradeIntent } = await import('../src/strategy/multiExecute.js');
const { __resetStoreForTests, getMultiPositionMeta } = await import('../src/db/index.js');
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
    positionSizeUsd: 100,
    usdgAddress: USDG,
    poolTvlWeight: 0.3,
    poolVolumeWeight: 0.3,
    poolVolumeTvlWeight: 0.25,
    poolFeeWeight: 0.15,
    maxOpenPositions: 3,
    maxPositionsPerToken: 1,
    maxExposureUsd: 100_000,
    entryCooldownMs: 0,
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

test('recordMultiPositionMeta records candidateInterval matching config.interval actually used ("1h"), never a hardcoded "6h"', async () => {
  const token = freshToken();
  const cfg = baseConfig({ interval: '1h' });

  const outcome = await executeTradeIntent({
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: cfg as never,
    prefs: { sizeMode: 'fixed', fixedAmountHuman: 10, balancePercent: 0 } as never,
    verifyLiquidityFn: async () => ({ status: 'OK' }),
    mintFn: fakeMintFn as never,
  });

  assert.ok(!('skipped' in outcome), `execution must succeed for this test to be meaningful: ${JSON.stringify(outcome)}`);
  const tokenId = (outcome as { tokenId: string }).tokenId;
  const meta = getMultiPositionMeta(CHAIN, tokenId);
  assert.ok(meta, 'MultiPositionMeta must have been recorded');
  assert.equal(meta!.candidateInterval, '1h', 'candidateInterval must match config.interval used for this execution');
});

test('recordMultiPositionMeta records candidateInterval matching a DIFFERENT config.interval ("5m") — proves it is not hardcoded to any single value', async () => {
  const token = freshToken();
  const cfg = baseConfig({ interval: '5m' });

  const outcome = await executeTradeIntent({
    intent: baseIntent(token) as never,
    candidate: baseCandidate(token) as never,
    config: cfg as never,
    prefs: { sizeMode: 'fixed', fixedAmountHuman: 10, balancePercent: 0 } as never,
    verifyLiquidityFn: async () => ({ status: 'OK' }),
    mintFn: fakeMintFn as never,
  });

  assert.ok(!('skipped' in outcome));
  const tokenId = (outcome as { tokenId: string }).tokenId;
  const meta = getMultiPositionMeta(CHAIN, tokenId);
  assert.equal(meta!.candidateInterval, '5m');
});
