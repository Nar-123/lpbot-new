/**
 * In-memory per-chain mint lock.
 *
 * Both `mintSingleSided`'s v3 path (mint.ts) and `mintV4SingleSided`
 * (v4.ts) read the hot wallet's current balance to size a deposit
 * (percent-of-balance or fixed-amount), then — several awaits and, for
 * percent/fixed sizing that needs it, a wrap and an allowance transaction
 * later — broadcast the actual mint. A manual /mint and an automated MULTI
 * entry on the same chain both read the same wallet's balance; without a
 * guard spanning that whole window, both could size against the same stale
 * balance snapshot and race each other through wrap/allowance/mint.
 * MULTI-vs-MULTI is separately guarded by the tx journal
 * (`checkPendingTransaction` in multiRisk.ts); this lock closes the
 * remaining gap for MULTI-vs-manual and manual-vs-manual mints within the
 * same process, by serializing the whole balance-read-to-broadcast section
 * per chain (this bot uses one hot wallet per chain).
 */
const minting = new Set<number>();

export function tryAcquireMintLock(chainId: number): boolean {
  if (minting.has(chainId)) return false;
  minting.add(chainId);
  return true;
}

export function releaseMintLock(chainId: number): void {
  minting.delete(chainId);
}

export function isMintLocked(chainId: number): boolean {
  return minting.has(chainId);
}

export function __resetMintLockForTests(): void {
  minting.clear();
}
