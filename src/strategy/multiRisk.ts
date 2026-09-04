import type { Address } from 'viem';
import type { SupportedChainId } from '../config.js';
import { getMultiPositionMeta, listOpenPositions, listUnresolvedTxJournal } from '../db/index.js';
import { getTokenBalance, getTokenMeta, humanToFloat } from '../chain/tokens.js';
import { getTokenPriceUsd } from '../price/dexscreener.js';
import type { MultiConfig } from './multiConfig.js';
import type { TradeIntent } from './types.js';

export type RiskGateResult = { pass: boolean; reason?: string };

/** In-memory only (not persisted) — a process restart resets cooldowns, which is acceptable since duplicate-position/pending-tx checks are the durable guards against double-entry. */
const cooldownMap = new Map<string, number>();

function cooldownKey(chainId: number, tokenAddress: string): string {
  return `${chainId}:${tokenAddress.toLowerCase()}`;
}

/**
 * Phase 4.6.8: every successful MULTI entry adds one permanent key to
 * `cooldownMap` that this codebase previously never removed — over weeks of
 * continuous operation (MULTI typically enters a different meme token each
 * time), the map's key count grows with the lifetime count of distinct
 * tokens ever entered, not with anything currently relevant. An entry whose
 * cooldown window has already elapsed can never again affect
 * checkEntryCooldown's result (see the `< config.entryCooldownMs` check
 * below), so it is safe to drop — purely a memory bound, not a behavior
 * change. Mirrors the same prune-on-tick idiom already used by
 * volumeAlertWatcher.ts's `pruneCooldowns`.
 */
function pruneCooldownMap(maxAgeMs: number): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [key, at] of cooldownMap) {
    if (at < cutoff) cooldownMap.delete(key);
  }
}

/** Any open position (any strategy) already holding this token on this chain blocks a new MULTI entry. */
export function checkDoubleEntry(
  chainId: SupportedChainId,
  tokenAddress: string,
): RiskGateResult {
  const addr = tokenAddress.toLowerCase();
  const duplicate = listOpenPositions(chainId).some(
    (p) => p.token0.toLowerCase() === addr || p.token1.toLowerCase() === addr,
  );
  return duplicate ? { pass: false, reason: 'DUPLICATE_POSITION' } : { pass: true };
}

/** MULTI_MAX_OPEN_POSITIONS / MULTI_MAX_POSITIONS_PER_TOKEN / MULTI_MAX_EXPOSURE_USD — scoped to strategy='multi' positions only. */
export function checkPositionLimits(
  config: MultiConfig,
  chainId: SupportedChainId,
  tokenAddress: string,
  /**
   * Phase 4.8 fix: pre-mint USD estimate of the position about to be
   * opened. Defaults to `config.positionSizeUsd ?? 0` (the pre-4.8 fixed-USD
   * behavior, unchanged for callers that don't pass this) — callers that can
   * produce a real estimate for percent-of-balance sizing (see
   * `checkPositionLimitsAsync` below) pass it in here instead of leaving the
   * cap blind to that mode.
   */
  incomingUsdEstimate?: number,
): RiskGateResult {
  const addr = tokenAddress.toLowerCase();
  const openMulti = listOpenPositions(chainId).filter((p) => p.strategy === 'multi');

  if (openMulti.length >= config.maxOpenPositions) {
    return { pass: false, reason: 'POSITION_LIMIT' };
  }

  const perToken = openMulti.filter(
    (p) => p.token0.toLowerCase() === addr || p.token1.toLowerCase() === addr,
  ).length;
  if (perToken >= config.maxPositionsPerToken) {
    return { pass: false, reason: 'POSITION_LIMIT' };
  }

  // Phase 4.7 fix: a missing/not-yet-written position-meta row must fail
  // closed. It previously contributed $0 to the exposure sum (`?? 0`) —
  // exactly backwards, since lost accounting data silently permitted MORE
  // trading, not less. `config.positionSizeUsd` (the configured fixed
  // position size) is the best available worst-case estimate for a
  // metadata-less position; falling back to it, not to 0, keeps the cap
  // meaningful even when a meta write was lost to a crash window
  // (multiExecute.ts's recordMultiPositionMeta lands after several awaits).
  const exposureUsd = openMulti.reduce((sum, p) => {
    const meta = getMultiPositionMeta(p.chainId, p.tokenId);
    return sum + (meta?.positionSizeUsd ?? config.positionSizeUsd ?? 0);
  }, 0);
  // Phase 4.7 fix: include the position about to be opened, not only
  // already-open ones — otherwise the cap only ever fires *after* it has
  // already been exceeded by up to one more position's size.
  // Phase 4.8 fix: `incomingUsdEstimate` now lets percent-of-balance sizing
  // supply a real pre-mint estimate too (via checkPositionLimitsAsync) —
  // previously only fixed-USD sizing (config.positionSizeUsd) had one, so
  // this cap was silently non-pre-emptive whenever MULTI_POSITION_SIZE_USD
  // was unset.
  const incomingUsd = incomingUsdEstimate ?? config.positionSizeUsd ?? 0;
  if (exposureUsd + incomingUsd >= config.maxExposureUsd) {
    return { pass: false, reason: 'POSITION_LIMIT' };
  }

  return { pass: true };
}

/**
 * Phase 4.8 fix (Priority 1, item 2): produces the pre-mint USD estimate
 * `checkPositionLimits` needs to make its exposure cap pre-emptive in
 * percent-of-balance sizing, not only fixed-USD sizing.
 *
 * - `config.positionSizeUsd` set (fixed-USD mode): returned directly, no
 *   lookup needed — unchanged from Phase 4.7.
 * - `positionSize.sizeMode === 'fixed'` (a fixed *token* amount from
 *   UserPrefs, not from MULTI_POSITION_SIZE_USD): converted to USD via the
 *   live quote-asset price.
 * - `positionSize.sizeMode === 'percent'`: the actual gap this fixes —
 *   estimated as `currentQuoteAssetBalance * balancePercent * price`, the
 *   same wallet balance and price mintSingleSided itself will use for the
 *   real deposit moments later.
 *
 * Injectable (mirrors this codebase's mintFn/poolFetcher/verifyLiquidityFn
 * pattern) so callers — and runRiskGate's own tests — never need live
 * RPC/price-API access to exercise the fixed-USD path, which needs no
 * network call at all.
 */
export type IncomingExposureEstimator = (
  config: MultiConfig,
  positionSize: TradeIntent['positionSize'],
) => Promise<number | null>;

export const defaultEstimateIncomingExposureUsd: IncomingExposureEstimator = async (
  config,
  positionSize,
) => {
  if (config.positionSizeUsd != null) return config.positionSizeUsd;

  const quoteToken = config.usdgAddress;
  if (!quoteToken) return 0;

  const price = await getTokenPriceUsd(config.chainId, quoteToken);
  if (price == null) return null; // unavailable — fail closed, never fabricate a $0 or $1 estimate

  if (positionSize.sizeMode === 'fixed') {
    return (positionSize.fixedAmountHuman ?? 0) * price;
  }

  try {
    const [balanceRaw, meta] = await Promise.all([
      getTokenBalance(config.chainId, quoteToken as Address),
      getTokenMeta(config.chainId, quoteToken as Address),
    ]);
    const balanceHuman = humanToFloat(balanceRaw, meta.decimals);
    return balanceHuman * ((positionSize.balancePercent ?? 0) / 100) * price;
  } catch {
    return null;
  }
};

/**
 * Async wrapper around `checkPositionLimits` that fills in
 * `incomingUsdEstimate` via `estimator` (defaulting to
 * `defaultEstimateIncomingExposureUsd`). A `null` estimate (price/balance
 * lookup failed) fails the gate closed — an unknown incoming exposure must
 * never be treated as $0, exactly the class of bug Phase 4.7's F-04 fixed
 * for missing position-meta rows.
 */
export async function checkPositionLimitsAsync(
  config: MultiConfig,
  chainId: SupportedChainId,
  tokenAddress: string,
  positionSize: TradeIntent['positionSize'],
  estimator: IncomingExposureEstimator = defaultEstimateIncomingExposureUsd,
): Promise<RiskGateResult> {
  const incomingUsd = await estimator(config, positionSize);
  if (incomingUsd == null) {
    return { pass: false, reason: 'EXPOSURE_ESTIMATE_UNAVAILABLE' };
  }
  return checkPositionLimits(config, chainId, tokenAddress, incomingUsd);
}

export function checkEntryCooldown(
  chainId: SupportedChainId,
  tokenAddress: string,
  config: MultiConfig,
): RiskGateResult {
  pruneCooldownMap(config.entryCooldownMs);
  const last = cooldownMap.get(cooldownKey(chainId, tokenAddress));
  if (last != null && Date.now() - last < config.entryCooldownMs) {
    return { pass: false, reason: 'ENTRY_COOLDOWN' };
  }
  return { pass: true };
}

/** Called only after a successful entry — never on rejection, so retries aren't penalized. */
export function recordEntryCooldown(chainId: SupportedChainId, tokenAddress: string): void {
  cooldownMap.set(cooldownKey(chainId, tokenAddress), Date.now());
}

export function __resetMultiCooldownForTests(): void {
  cooldownMap.clear();
}

/** Test-only: insert a cooldown entry with an explicit (possibly backdated) timestamp. */
export function __setCooldownEntryForTests(
  chainId: number,
  tokenAddress: string,
  at: number,
): void {
  cooldownMap.set(cooldownKey(chainId, tokenAddress), at);
}

export function __cooldownMapSizeForTests(): number {
  return cooldownMap.size;
}

/** Any unresolved (non-final) journal entry on this chain blocks a new MULTI send. */
export function checkPendingTransaction(chainId: SupportedChainId): RiskGateResult {
  const unresolved = listUnresolvedTxJournal({ chainId });
  return unresolved.length > 0 ? { pass: false, reason: 'PENDING_TRANSACTION' } : { pass: true };
}

/**
 * Runs every risk-gate check and returns ALL results (not just the first
 * failure) for auditability. The caller (multiExecute.ts) treats any
 * non-passing result as a hard block — none of these checks are advisory.
 */
export async function runRiskGate(
  intent: TradeIntent,
  config: MultiConfig,
  opts?: { exposureEstimator?: IncomingExposureEstimator },
): Promise<RiskGateResult[]> {
  const results: RiskGateResult[] = [];

  const usdgOk =
    config.usdgAddress != null &&
    intent.quoteToken.toLowerCase() === config.usdgAddress.toLowerCase();
  results.push(usdgOk ? { pass: true } : { pass: false, reason: 'NOT_USDG' });

  results.push(
    intent.range.tickLower < intent.range.tickUpper
      ? { pass: true }
      : { pass: false, reason: 'INVALID_RANGE' },
  );

  results.push(checkDoubleEntry(intent.chainId, intent.token));
  results.push(
    await checkPositionLimitsAsync(
      config,
      intent.chainId,
      intent.token,
      intent.positionSize,
      opts?.exposureEstimator,
    ),
  );
  results.push(checkEntryCooldown(intent.chainId, intent.token, config));
  results.push(checkPendingTransaction(intent.chainId));

  return results;
}
