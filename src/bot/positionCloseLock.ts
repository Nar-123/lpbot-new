/**
 * Shared lock preventing the automated TP/SL watcher and a manual /close
 * command from closing the same position at the same time.
 *
 * Previously tpslWatcher.ts tracked in-flight closes in its own
 * module-private `closing` Set, invisible to bot.ts's manual close
 * handler. A manual /close and an automated TP/SL close triggered on the
 * same position could both proceed to `closePosition()` concurrently,
 * relying on the chain call (simulateContract / the position already
 * being burned) to fail one of them silently instead of being rejected
 * up front with a clear reason.
 */
const closing = new Set<string>();

export function closeLockKey(chainId: number, tokenId: string): string {
  return `${chainId}:${tokenId}`;
}

/** Acquires the close lock for `key`. Returns false if another close already holds it. */
export function tryAcquireCloseLock(key: string): boolean {
  if (closing.has(key)) return false;
  closing.add(key);
  return true;
}

export function releaseCloseLock(key: string): void {
  closing.delete(key);
}

export function isCloseLocked(key: string): boolean {
  return closing.has(key);
}

export function __resetCloseLocksForTests(): void {
  closing.clear();
}
