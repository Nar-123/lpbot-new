import type { Address, Hex } from 'viem';
import type { SupportedChainId } from '../config.js';
import { loadPool, verifyOnChainPoolReserves } from '../chain/pools.js';
import { loadV4Pool, verifyV4PoolHasLiquidity } from '../chain/v4.js';
import { mintSingleSided, type MintParamsWithProtocol, type MintResult } from '../chain/mint.js';
import { getTokenMeta, humanToFloat } from '../chain/tokens.js';
import { getTokenPriceUsd } from '../price/dexscreener.js';
import {
  DEFAULT_PREFS,
  recordLedger,
  recordMultiPositionMeta,
  recordOpenPosition,
  setJournalAccountingMeta,
  setPositionTpSl,
  type UserPrefs,
} from '../db/index.js';
import { fetchAndFilterCandidates, type CandidateFetcher, type TokenInfoFetcher } from './multiCandidates.js';
import { discoverAndScorePoolsForCandidate, type PoolFetcher } from './multiPool.js';
import { computeMultiRange } from './multiRange.js';
import {
  checkPendingTransaction,
  recordEntryCooldown,
  runRiskGate,
  type IncomingExposureEstimator,
} from './multiRisk.js';
import type { MultiConfig } from './multiConfig.js';
import type {
  MultiCandidate,
  MultiPoolCandidate,
  MultiStrategyRun,
  RejectedCandidate,
  TradeIntent,
} from './types.js';

export type MintFn = (params: MintParamsWithProtocol) => Promise<MintResult>;

/**
 * Injectable, matching the existing mintFn/poolFetcher/fetcher pattern —
 * keeps executeTradeIntent's real-RPC dependencies mockable in tests
 * without any network access, same as every other external call in this
 * pipeline. Defaults to the real on-chain check dispatched by protocol.
 */
export type LiquidityCheckFn = (
  intent: TradeIntent,
) => Promise<{ status: 'OK' | 'ONCHAIN_VALIDATION_ERROR' | 'TVL_MISMATCH' }>;

const defaultVerifyLiquidity: LiquidityCheckFn = (intent) =>
  intent.pool.protocol === 'v4'
    ? verifyV4PoolHasLiquidity(intent.chainId, intent.pool.poolAddress as Hex)
    : verifyOnChainPoolReserves(
        intent.chainId,
        intent.pool.poolAddress as Address,
        intent.token as Address,
        intent.quoteToken as Address,
        intent.pool.tvlUsd ?? 0,
      );

type LivePoolState = {
  currentTick: number;
  tickSpacing: number;
  token0: Address;
  token1: Address;
};

/** Unifies v3 (contract address) and v4 (poolId) live-state loading — MULTI never re-implements tick fetching. */
async function loadLivePoolState(
  chainId: SupportedChainId,
  pool: MultiPoolCandidate,
): Promise<LivePoolState | null> {
  try {
    if (pool.protocol === 'v4') {
      const info = await loadV4Pool(chainId, pool.poolAddress as Hex);
      return {
        currentTick: info.tick,
        tickSpacing: info.tickSpacing,
        token0: info.token0.address,
        token1: info.token1.address,
      };
    }
    const info = await loadPool(chainId, pool.poolAddress as Address);
    return {
      currentTick: info.tick,
      tickSpacing: info.tickSpacing,
      token0: info.token0.address,
      token1: info.token1.address,
    };
  } catch {
    return null;
  }
}

function rejectCandidate(candidate: MultiCandidate, reason: string): RejectedCandidate {
  return { ...candidate, rejectedReason: reason };
}

/**
 * The single per-candidate pipeline: pool discovery → range calc → risk gate
 * → (optional) execute. Extracted from runMultiStrategy's loop body so any
 * OTHER caller (currently: the agent's `deploy_position` tool, src/agent/
 * tools.ts) evaluates a candidate through the exact same validation path —
 * never a second, hand-rolled copy that could silently drift from this one
 * and skip a check. Behavior-identical to the inline loop this replaced;
 * runMultiStrategy's own tests are unchanged and still pass, which is the
 * regression guard for that claim.
 */
export async function evaluateAndExecuteCandidate(
  candidate: MultiCandidate,
  config: MultiConfig,
  opts: {
    dryRun: boolean;
    prefs: UserPrefs;
    poolFetcher?: PoolFetcher;
    mintFn?: MintFn;
    verifyLiquidityFn?: LiquidityCheckFn;
    exposureEstimator?: IncomingExposureEstimator;
  },
): Promise<
  | { outcome: 'rejected'; rejected: RejectedCandidate }
  | { outcome: 'dry_run_intent'; intent: TradeIntent }
  | { outcome: 'executed'; intent: TradeIntent; tokenId: string; txHash: string }
> {
  const { selected, poolFetchError } = await discoverAndScorePoolsForCandidate(config, candidate, {
    poolFetcher: opts.poolFetcher,
  });

  if (!selected) {
    if (poolFetchError) {
      console.warn(
        `[multi] pool discovery failed for ${candidate.address} on chain ${config.chainId}: ${poolFetchError.message}`,
      );
      return { outcome: 'rejected', rejected: rejectCandidate(candidate, 'POOL_FETCH_ERROR') };
    }
    return { outcome: 'rejected', rejected: rejectCandidate(candidate, 'NO_VALID_POOL') };
  }

  const live = await loadLivePoolState(config.chainId, selected);
  if (!live) {
    return { outcome: 'rejected', rejected: rejectCandidate(candidate, 'INVALID_PRICE') };
  }

  const usdgIsToken0 = live.token0.toLowerCase() === (config.usdgAddress as string).toLowerCase();
  const range = computeMultiRange({
    currentTick: live.currentTick,
    tickSpacing: live.tickSpacing,
    widthPercent: config.rangePercent,
    usdgIsToken0,
  });

  if (!range.valid) {
    return { outcome: 'rejected', rejected: rejectCandidate(candidate, range.rejectedReason) };
  }

  const intent: TradeIntent = {
    strategy: 'multi',
    chainId: config.chainId,
    token: candidate.address,
    quoteToken: config.usdgAddress as string,
    pool: selected,
    fee: selected.fee ?? 0,
    side: range.side,
    range: { tickLower: range.tickLower, tickUpper: range.tickUpper },
    positionSize:
      config.positionSizeUsd != null
        ? { sizeMode: 'fixed', fixedAmountHuman: config.positionSizeUsd }
        : {
            sizeMode: opts.prefs.sizeMode,
            balancePercent: opts.prefs.balancePercent,
            fixedAmountHuman: opts.prefs.fixedAmountHuman,
          },
    depositToken: config.usdgAddress as string,
    reason: `candidateScore=${candidate.candidateScore.toFixed(3)} poolScore=${selected.totalScore.toFixed(3)}`,
    candidateScore: candidate.candidateScore,
    poolScore: selected.totalScore,
  };

  const gate = await runRiskGate(intent, config, { exposureEstimator: opts.exposureEstimator });
  const failure = gate.find((r) => !r.pass);
  if (failure) {
    return { outcome: 'rejected', rejected: rejectCandidate(candidate, failure.reason ?? 'RISK_GATE_FAILED') };
  }

  if (opts.dryRun) {
    return { outcome: 'dry_run_intent', intent };
  }

  const outcome = await executeTradeIntent({
    intent,
    candidate,
    config,
    prefs: opts.prefs,
    mintFn: opts.mintFn,
    verifyLiquidityFn: opts.verifyLiquidityFn,
    exposureEstimator: opts.exposureEstimator,
  });
  if ('skipped' in outcome) {
    return { outcome: 'rejected', rejected: rejectCandidate(candidate, outcome.reason) };
  }
  return { outcome: 'executed', intent, tokenId: outcome.tokenId, txHash: outcome.txHash };
}

/**
 * Re-validates and then executes a single TradeIntent through the existing
 * execution pipeline (mintSingleSided → journalledSend → tx lock → journal →
 * receipt → accounting). MULTI never calls a wallet client directly and
 * never implements a second broadcast path — `mintFn` defaults to the same
 * `mintSingleSided` used by manual mints.
 */
export async function executeTradeIntent(params: {
  intent: TradeIntent;
  candidate: MultiCandidate;
  config: MultiConfig;
  prefs: UserPrefs;
  mintFn?: MintFn;
  verifyLiquidityFn?: LiquidityCheckFn;
  exposureEstimator?: IncomingExposureEstimator;
}): Promise<{ tokenId: string; txHash: string } | { skipped: true; reason: string }> {
  const { intent, candidate, config, prefs } = params;
  const mintFn = params.mintFn ?? mintSingleSided;
  const verifyLiquidityFn = params.verifyLiquidityFn ?? defaultVerifyLiquidity;

  // The execution layer re-validates — it never trusts the intent blindly,
  // even though it was assembled by our own strategy code moments earlier.
  const gate = await runRiskGate(intent, config, { exposureEstimator: params.exposureEstimator });
  const failure = gate.find((r) => !r.pass);
  if (failure) {
    return { skipped: true, reason: failure.reason ?? 'RISK_GATE_FAILED' };
  }

  const usdgAddress = config.usdgAddress;
  if (!usdgAddress) {
    return { skipped: true, reason: 'NOT_USDG' };
  }

  // Phase 4.7 audit (F-08): DexScreener's pool.tvlUsd (scored/ranked in
  // multiPool.ts, left untouched by this check) is never independently
  // verified on-chain before this point. Re-verifying only here — once, for
  // the single candidate about to receive a real deposit, not for every
  // Top-N candidate during a dry-run scan — keeps this bounded to exactly
  // one additional on-chain check per real execution (see the RPC-impact
  // note in each verify function's own doc comment). Fails closed: any
  // classification other than OK aborts the trade before any capital moves.
  const liquidityCheck = await verifyLiquidityFn(intent);
  if (liquidityCheck.status !== 'OK') {
    return { skipped: true, reason: liquidityCheck.status };
  }

  let sizeMode: 'percent' | 'fixed' = 'fixed';
  let fixedAmountHuman = 0;
  let balancePercent = 0;

  if (config.positionSizeUsd != null) {
    // Phase 4.7 fix: a failed/unavailable USDG price lookup must abort the
    // trade, not silently fabricate $1.00 — no capital has moved yet at
    // this point, so failing closed here is free. Fabricating a price to
    // size a real deposit ($positionSizeUsd / assumedPrice) risked
    // depositing a materially wrong token amount whenever MULTI_USDG_ADDRESS
    // is overridden to a non-default quote asset DexScreener fails to
    // price (the built-in chain default short-circuits to a real
    // stable-peg 1.0 and is not affected — see price/dexscreener.ts).
    const usdgPrice = await getTokenPriceUsd(config.chainId, usdgAddress);
    if (usdgPrice == null) {
      return { skipped: true, reason: 'PRICE_UNAVAILABLE' };
    }
    fixedAmountHuman = config.positionSizeUsd / usdgPrice;
  } else if (prefs.sizeMode === 'fixed') {
    fixedAmountHuman = prefs.fixedAmountHuman;
  } else {
    sizeMode = 'percent';
    balancePercent = prefs.balancePercent;
  }

  let result: MintResult;
  try {
    result = await mintFn({
      chainId: intent.chainId,
      poolAddress: intent.pool.poolAddress,
      depositToken: usdgAddress,
      balancePercent,
      sizeMode,
      fixedAmountHuman,
      widthPercent: config.rangePercent,
      protocol: intent.pool.protocol,
      dex: intent.pool.dex,
      poolId: intent.pool.protocol === 'v4' ? (intent.pool.poolAddress as Hex) : undefined,
    });
  } catch {
    return { skipped: true, reason: 'SIMULATION_FAILED' };
  }

  const tokenId = result.tokenId.toString();

  recordOpenPosition({
    chainId: intent.chainId,
    tokenId,
    poolAddress: String(result.poolAddress),
    token0: result.token0,
    token1: result.token1,
    fee: result.fee,
    tickLower: result.tickLower,
    tickUpper: result.tickUpper,
    protocol: result.protocol ?? 'v3',
    dex: result.dex ?? 'uniswap',
    strategy: 'multi',
    entrySignals: {
      marketCapUsd: candidate.marketCapUsd ?? 0,
      volume6hUsd: candidate.volume6hUsd ?? 0,
      ageHours: candidate.ageHours ?? 0,
      poolTvlUsd: intent.pool.tvlUsd ?? 0,
      poolVolumeUsd: intent.pool.volumeUsd ?? 0,
      poolVolumeTvlRatio:
        intent.pool.tvlUsd != null && intent.pool.tvlUsd > 0 && intent.pool.volumeUsd != null
          ? intent.pool.volumeUsd / intent.pool.tvlUsd
          : 0,
      poolFee: intent.pool.fee ?? 0,
    },
  });

  const usdgMeta = await getTokenMeta(intent.chainId, usdgAddress);
  const depositAmountHuman = humanToFloat(result.depositAmount, usdgMeta.decimals);
  // The deposit has already been broadcast and confirmed by this point —
  // unlike the pre-mint sizing lookup above, there is no safe way to abort
  // here. A failed lookup still must not silently masquerade as a normal,
  // confident $1.00 price: logged so a real quote-asset depeg or DexScreener
  // outage during the accounting step is observable rather than invisible.
  const usdgPriceRaw = await getTokenPriceUsd(intent.chainId, usdgAddress);
  if (usdgPriceRaw == null) {
    console.warn(
      `[multi] price lookup failed while recording deposit accounting for ${usdgAddress} on chain ${intent.chainId} — falling back to $1.00; verify via /pnl if this quote asset is not actually pegged`,
    );
  }
  const usdgPriceNow = usdgPriceRaw ?? 1;
  const depositUsd = depositAmountHuman * usdgPriceNow;

  setJournalAccountingMeta(intent.chainId, result.hash, [
    {
      kind: 'deposit',
      tokenId,
      tokenAddress: usdgAddress,
      amountRaw: result.depositAmount.toString(),
      amountHuman: depositAmountHuman,
      usd: depositUsd,
      strategy: 'multi',
    },
  ]);

  recordLedger({
    chainId: intent.chainId,
    tokenId,
    kind: 'deposit',
    tokenAddress: usdgAddress,
    amountRaw: result.depositAmount.toString(),
    amountHuman: depositAmountHuman,
    usd: depositUsd,
    txHash: result.hash,
    strategy: 'multi',
  });

  // entryPrice intentionally null: deriving a decimals-correct USD entry price from
  // raw ticks here would require the same oriented-price logic already implemented
  // in chain/prices.ts — recomputing it independently risks silent drift, so this
  // is left unset rather than manufacturing a number that looks more precise than it is.
  recordMultiPositionMeta({
    chainId: intent.chainId,
    tokenId,
    candidateSource: candidate.source,
    candidateInterval: '6h',
    candidateMarketCapUsd: candidate.marketCapUsd,
    candidateAgeHours: candidate.ageHours,
    candidateVolume6hUsd: candidate.volume6hUsd,
    candidateClassification: candidate.classification,
    candidateScore: candidate.candidateScore,
    poolAddress: String(result.poolAddress),
    poolFee: intent.pool.fee,
    poolTvlUsd: intent.pool.tvlUsd,
    poolVolumeUsd: intent.pool.volumeUsd,
    poolScore: intent.pool.totalScore,
    entryPrice: null,
    tickLower: result.tickLower,
    tickUpper: result.tickUpper,
    positionSizeUsd: depositUsd,
    timestamp: Date.now(),
  });

  setPositionTpSl(intent.chainId, tokenId, {
    enabled: true,
    tpPercent: config.tpPercent,
    slPercent: config.slPercent,
  });

  recordEntryCooldown(intent.chainId, intent.token);

  return { tokenId, txHash: result.hash };
}

/**
 * Runs the full MULTI pipeline: fetch/filter candidates → discover/score
 * pools → compute range → risk gate → (dry-run: stop here) or execute.
 * Every rejection carries a specific reason code — never a generic
 * "candidate rejected".
 */
export async function runMultiStrategy(
  config: MultiConfig,
  opts?: {
    dryRun?: boolean;
    mintFn?: MintFn;
    fetcher?: CandidateFetcher;
    infoFetcher?: TokenInfoFetcher;
    poolFetcher?: PoolFetcher;
    prefs?: UserPrefs;
    now?: number;
    verifyLiquidityFn?: LiquidityCheckFn;
    exposureEstimator?: IncomingExposureEstimator;
  },
): Promise<MultiStrategyRun> {
  const now = opts?.now ?? Date.now();
  const dryRun = opts?.dryRun ?? true;

  const empty: MultiStrategyRun = {
    chainId: config.chainId,
    dryRun,
    timestamp: now,
    candidates: [],
    rejected: [],
    intents: [],
    executed: [],
  };

  if (!config.enabled || !config.usdgAddress) {
    return empty;
  }

  if (!dryRun) {
    const pending = checkPendingTransaction(config.chainId);
    if (!pending.pass) {
      return empty;
    }
  }

  const { candidates, rejected, sourceError } = await fetchAndFilterCandidates(config, {
    fetcher: opts?.fetcher,
    infoFetcher: opts?.infoFetcher,
    now,
  });

  const intents: TradeIntent[] = [];
  const executed: { tokenId: string; txHash: string; intent: TradeIntent }[] = [];
  const prefs = opts?.prefs ?? DEFAULT_PREFS;

  for (const candidate of candidates) {
    const result = await evaluateAndExecuteCandidate(candidate, config, {
      dryRun,
      prefs,
      poolFetcher: opts?.poolFetcher,
      mintFn: opts?.mintFn,
      verifyLiquidityFn: opts?.verifyLiquidityFn,
      exposureEstimator: opts?.exposureEstimator,
    });

    if (result.outcome === 'rejected') {
      rejected.push(result.rejected);
      continue;
    }
    intents.push(result.intent);
    if (result.outcome === 'executed') {
      executed.push({ tokenId: result.tokenId, txHash: result.txHash, intent: result.intent });
    }
  }

  return { chainId: config.chainId, dryRun, timestamp: now, candidates, rejected, intents, executed, sourceError };
}
