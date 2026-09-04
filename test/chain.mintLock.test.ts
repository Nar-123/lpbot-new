/**
 * Phase 4.8 — capital-safety finding (Priority 1, item 3).
 *
 * Root cause: `mintSingleSided`'s v3 path (src/chain/mint.ts) and
 * `mintV4SingleSided` (src/chain/v4.ts) each read the hot wallet's current
 * balance to size a deposit, then — several awaits later (a pool reload, an
 * optional wrap tx, an optional allowance tx, a simulate, a gas estimate) —
 * broadcast the actual mint. A manual /mint and an automated MULTI entry on
 * the same chain both read the same wallet's balance; nothing stopped both
 * from sizing against the same stale snapshot and racing each other through
 * that window (MULTI-vs-MULTI is separately guarded by the tx journal via
 * checkPendingTransaction, but MULTI-vs-manual and manual-vs-manual were
 * not).
 *
 * Fix: both mint functions now acquire a shared per-chain lock
 * (src/chain/mintLock.ts) as the very first thing they do — before any
 * balance read — and release it in a `finally` spanning their entire body.
 * A concurrent mint attempt on the same chain is rejected immediately with
 * a clear error instead of silently sizing from a stale balance.
 *
 * This suite proves:
 * 1. The lock primitives themselves are correct (pure unit tests, no
 *    network).
 * 2. Both real mint functions are actually wired to acquire the lock
 *    BEFORE their balance read and release it in a `finally` around their
 *    whole body — proven via source inspection, the same technique this
 *    codebase's own test/strategy.multiExecute.test.ts "execution boundary"
 *    tests already use for a boundary that's expensive/risky to exercise
 *    via a real broadcast (this repo has no mint.test.ts at all, for the
 *    same reason: mintSingleSided/mintV4SingleSided need live RPC/wallet
 *    access with no injectable seam, unlike the strategy layer above them).
 *    The two read-only preview functions (describeMintPreview,
 *    describeV4MintPreview) are confirmed to NOT take the lock, since they
 *    never broadcast.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  tryAcquireMintLock,
  releaseMintLock,
  isMintLocked,
  __resetMintLockForTests,
} = await import('../src/chain/mintLock.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src', 'chain');

// ── Pure lock primitives ────────────────────────────────────────────────

test('tryAcquireMintLock: a free chain lock is acquired, and a second attempt on the same chain is rejected', () => {
  __resetMintLockForTests();
  const CHAIN = 4663;
  assert.equal(tryAcquireMintLock(CHAIN), true, 'first acquire on a free chain must succeed');
  assert.equal(
    tryAcquireMintLock(CHAIN),
    false,
    'a second acquire on the same chain, while still held, must be rejected — this is the exact race the fix closes',
  );
  assert.equal(isMintLocked(CHAIN), true);
});

test('releaseMintLock: frees the chain so a subsequent acquire succeeds again', () => {
  __resetMintLockForTests();
  const CHAIN = 4663;
  assert.equal(tryAcquireMintLock(CHAIN), true);
  releaseMintLock(CHAIN);
  assert.equal(isMintLocked(CHAIN), false);
  assert.equal(tryAcquireMintLock(CHAIN), true, 'the lock must be genuinely released, not permanently stuck');
});

test('mint locks are scoped per chain — locking one chain never blocks a different chain', () => {
  __resetMintLockForTests();
  assert.equal(tryAcquireMintLock(4663), true);
  assert.equal(tryAcquireMintLock(56), true, 'a different chain (different hot wallet) must not be affected');
  assert.equal(isMintLocked(4663), true);
  assert.equal(isMintLocked(56), true);
});

// ── Structural: both real mint paths actually acquire the lock before ────
// ── reading the balance used for sizing, and release it around their ─────
// ── whole body ─────────────────────────────────────────────────────────

test('mint.ts: mintSingleSided (v3 path) acquires the shared mint lock before the balance read used for sizing', () => {
  const src = fs.readFileSync(path.join(srcDir, 'mint.ts'), 'utf8');

  const lockIdx = src.indexOf('tryAcquireMintLock(lockChainId)');
  const lockedFnIdx = src.indexOf('async function mintSingleSidedV3Locked');
  const balanceReadIdx = src.indexOf('await getEffectiveDepositBalance(chainId, depositToken)');

  assert.ok(lockIdx > -1, 'mintSingleSided must call tryAcquireMintLock');
  assert.ok(lockedFnIdx > -1, 'the v3 mint body must be split into a locked helper');
  assert.ok(balanceReadIdx > -1, 'sanity: the sizing balance read must still exist');
  assert.ok(
    lockIdx < lockedFnIdx && lockedFnIdx < balanceReadIdx,
    'the lock must be acquired in mintSingleSided BEFORE the balance-read/broadcast body (mintSingleSidedV3Locked) even begins',
  );
  assert.match(
    src,
    /if \(!tryAcquireMintLock\(lockChainId\)\) \{[\s\S]{0,400}?try \{[\s\S]{0,200}?mintSingleSidedV3Locked\(params\)[\s\S]{0,200}?\} finally \{[\s\S]{0,100}?releaseMintLock\(lockChainId\)/,
    'the lock must be released in a finally block spanning the call to the locked v3 body — a thrown error must still release it',
  );
});

test('v4.ts: mintV4SingleSided acquires the shared mint lock before the balance read used for sizing', () => {
  const src = fs.readFileSync(path.join(srcDir, 'v4.ts'), 'utf8');

  const lockIdx = src.indexOf('tryAcquireMintLock(lockChainId)');
  const lockedFnIdx = src.indexOf('async function mintV4SingleSidedLocked');
  const balanceReadIdx = src.indexOf('const eff = await getEffectiveDepositBalance(\n    chainId,');

  assert.ok(lockIdx > -1, 'mintV4SingleSided must call tryAcquireMintLock');
  assert.ok(lockedFnIdx > -1, 'the v4 mint body must be split into a locked helper');
  assert.ok(balanceReadIdx > -1, 'sanity: the sizing balance read must still exist');
  assert.ok(
    lockIdx < lockedFnIdx && lockedFnIdx < balanceReadIdx,
    'the lock must be acquired in mintV4SingleSided BEFORE the balance-read/broadcast body (mintV4SingleSidedLocked) even begins',
  );
  assert.match(
    src,
    /if \(!tryAcquireMintLock\(lockChainId\)\) \{[\s\S]{0,400}?try \{[\s\S]{0,200}?mintV4SingleSidedLocked\(params\)[\s\S]{0,200}?\} finally \{[\s\S]{0,100}?releaseMintLock\(lockChainId\)/,
    'the lock must be released in a finally block spanning the call to the locked v4 body — a thrown error must still release it',
  );
});

test('mint.ts and v4.ts: the read-only mint preview functions do NOT take the mint lock (they never broadcast)', () => {
  const mintSrc = fs.readFileSync(path.join(srcDir, 'mint.ts'), 'utf8');
  const v4Src = fs.readFileSync(path.join(srcDir, 'v4.ts'), 'utf8');

  const previewStart = mintSrc.indexOf('export async function describeMintPreview');
  assert.ok(previewStart > -1, 'sanity: describeMintPreview must exist');
  assert.ok(
    !mintSrc.slice(previewStart).includes('tryAcquireMintLock'),
    'describeMintPreview must never acquire the mint lock — it only reads state, never broadcasts',
  );

  const v4PreviewStart = v4Src.indexOf('export async function describeV4MintPreview');
  assert.ok(v4PreviewStart > -1, 'sanity: describeV4MintPreview must exist');
  assert.ok(
    !v4Src.slice(v4PreviewStart).includes('tryAcquireMintLock'),
    'describeV4MintPreview must never acquire the mint lock — it only reads state, never broadcasts',
  );
});
