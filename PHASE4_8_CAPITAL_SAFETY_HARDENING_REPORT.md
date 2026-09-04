# PHASE 4.8 — PRE-LIVE CAPITAL SAFETY & HARDENING REPORT

## 1. Scope

Six findings handed down before enabling `TRADING_MODE=live` with real
capital: three P1 (race conditions / capital safety) and three P2
(observability / hardening), all previously known gaps — three were already
documented as open items in `PHASE4_7_FINAL_ADVERSARIAL_PRODUCTION_READINESS_AUDIT.md`
(F-06, F-10, F-12, F-15's residual percent-mode gap), three (the TP/SL-vs-manual
close race, the percent-mode exposure gate, and the mint TOCTOU) are new to
this phase. Each fix below is minimal, matches an existing pattern already
established elsewhere in this codebase, and ships with a regression test
proven to fail against the pre-fix code and pass against the fix.

## 2. Baseline

`npm run typecheck && npm test` before any change: **643/643 tests pass**,
typecheck clean. (One test, `test/retry.test.ts`'s "backoff is linear"
timing assertion, is flaky under load when run as part of the full suite but
passes reliably in isolation — pre-existing, unrelated to this phase, not
touched.)

After all six fixes: **667/667 tests pass** (24 new tests), typecheck clean,
full suite re-run clean start to finish.

## 3. Findings & Fixes

### P1-1 — TP/SL auto-close and manual /close could race the same position

**Files:** `src/bot/positionCloseLock.ts` (new), `src/bot/tpslWatcher.ts`,
`src/bot/bot.ts`

**Root cause:** `tpslWatcher.ts` tracked in-flight closes in its own
module-private `closing` Set, invisible to `bot.ts`'s manual `/close`
handler (`executeClosePosition`). A TP/SL-triggered auto-close and a manual
`/close` on the same position, fired at the same time, would both proceed
straight into `closePosition()` with no mutual awareness — relying on the
chain call itself (or accidental luck) to keep them from double-executing,
instead of one being rejected up front with a clear reason.

**Fix:** Extracted a tiny shared lock module, `positionCloseLock.ts`
(`tryAcquireCloseLock` / `releaseCloseLock` / `isCloseLocked`, keyed by
`${chainId}:${tokenId}`). `tpslWatcher.ts`'s `executeClose` and
`recheckAndMaybeClose` now acquire/check this shared lock instead of a
private Set; `bot.ts`'s `executeClosePosition` acquires it too (a new thin
wrapper, `executeClosePositionLocked`, holds the original function body
unchanged) and replies "⏳ Posisi sedang ditutup oleh TP/SL…" if it's already
held, without ever calling `closePosition()`. Whichever side loses the race
is rejected immediately — never silently raced. `stopTpslWatcher()`'s old
`closing.clear()` was removed (now unsafe on a *shared* lock — it could
release a lock still legitimately held by the other side, or by a close
still running past the shutdown deadline); each close's own `finally`
already releases its own key on completion.

**Failure scenario closed:** an operator fires manual `/close` at the exact
moment TP/SL's 5s-confirmed auto-close is also calling `closePosition()` for
the same position → both proceed concurrently with no coordination.

**Tests:** `test/tpslWatcher.closeLock.test.ts` (2 tests) — proves both
directions: a lock already held by a simulated manual close blocks the
TP/SL watcher from touching the same position (`closePosition` never
called), and a lock held by an in-flight TP/SL close rejects a simulated
concurrent manual-close attempt, with the lock verified free again once the
TP/SL close actually finishes. Verified to fail against the pre-fix
(private-Set) `tpslWatcher.ts`, pass against the fix.

### P1-2 — Percent-of-balance sizing had no pre-emptive exposure cap

**Files:** `src/strategy/multiRisk.ts`, `src/strategy/multiExecute.ts`

**Root cause:** Phase 4.7's F-03 fix made `checkPositionLimits`'s exposure
cap pre-emptive (existing + incoming vs. the cap) — but only for fixed-USD
sizing (`MULTI_POSITION_SIZE_USD` set), the only mode with a USD figure
available before mint. When unset (percent-of-balance sizing, the
`UserPrefs.sizeMode === 'percent'` path), `incomingUsd` fell back to
`config.positionSizeUsd ?? 0` — exactly 0, every time. The cap only ever
fired one position late, after the real size had already landed in the next
check's exposure sum.

**Fix:** `checkPositionLimits` now takes an optional `incomingUsdEstimate`
(defaults to the old `config.positionSizeUsd ?? 0`, so no behavior change
for any caller that doesn't pass it). A new async
`checkPositionLimitsAsync` (called by `runRiskGate`) fills that estimate via
an injectable `IncomingExposureEstimator` — mirrors this codebase's existing
`mintFn`/`poolFetcher`/`verifyLiquidityFn` DI pattern, so tests never need
live RPC/price-API access. The real
`defaultEstimateIncomingExposureUsd`: returns `config.positionSizeUsd`
directly when set (no lookup, unchanged fast path); converts a prefs-driven
fixed *token* amount to USD via the live quote price; and for percent mode,
estimates `currentQuoteAssetBalance × balancePercent × price` — the same
inputs `mintSingleSided` itself uses moments later for the real deposit. A
`null` estimate (price/balance lookup failed) fails the gate **closed**
(`EXPOSURE_ESTIMATE_UNAVAILABLE`), never treated as $0.

**Failure scenario closed:** `MULTI_MAX_EXPOSURE_USD=500`, percent sizing,
$400 already open, wallet holds $1000 and sizes a new entry at 30% ($300) →
existing $400 + incoming $300 = $700, over the cap — pre-fix this passed
(incoming counted as $0); post-fix it's rejected `POSITION_LIMIT` before
mint.

**Tests:** `test/strategy.multiRisk.percentExposure.test.ts` (5 tests) —
`runRiskGate` blocking a percent-mode entry once a real injected estimate
would exceed the cap; a percent-mode entry that genuinely stays under the
cap still passing; `checkPositionLimitsAsync` failing closed on a `null`
estimate; and `defaultEstimateIncomingExposureUsd`'s two network-free
branches (fixed-USD passthrough, prefs-fixed-amount × stable-peg price).
The primary test verified to fail against the pre-fix exposure formula,
pass against the fix. Full existing `multiRisk`/`multiExecute` suites (34
tests) re-run clean — no percent-mode test previously existed, so no
existing behavior changed for fixed-USD sizing.

### P1-3 — TOCTOU between balance-read sizing and mint broadcast

**Files:** `src/chain/mintLock.ts` (new), `src/chain/mint.ts`,
`src/chain/v4.ts`

**Root cause:** Both `mintSingleSided`'s v3 path and `mintV4SingleSided`
read the hot wallet's current balance to size a deposit, then — a pool
reload, an optional wrap tx, an optional allowance tx, a simulate, and a gas
estimate later — broadcast the actual mint. A manual `/mint` and an
automated MULTI entry on the same chain both read the same wallet's
balance; MULTI-vs-MULTI was already guarded by the tx journal
(`checkPendingTransaction`), but MULTI-vs-manual and manual-vs-manual within
the same process were not — both could size against the same stale
snapshot.

**Fix:** A new per-chain in-memory lock, `mintLock.ts`
(`tryAcquireMintLock`/`releaseMintLock`/`isMintLocked`). Both
`mintSingleSided`'s v3 branch and `mintV4SingleSided` were split into a thin
locking wrapper (acquires the lock, delegates to an unchanged
`*Locked` helper holding the original body, releases in `finally`) — a
concurrent mint on the same chain is rejected immediately with a clear
error instead of sizing from a stale balance. The two read-only preview
functions (`describeMintPreview`, `describeV4MintPreview`) deliberately do
**not** take the lock — they never broadcast.

**Failure scenario closed:** an operator's manual `/mint` and a MULTI
auto-entry both read a $1000 wallet balance within the same RPC round-trip
window and each size a deposit off it, racing through wrap/allowance/mint
against what is actually a single, now-shrinking balance.

**Tests:** `test/chain.mintLock.test.ts` (6 tests) — pure unit tests of the
lock primitives (acquire/reject-duplicate/release/per-chain isolation), plus
source-inspection tests proving both real mint functions acquire the lock
*before* their balance read and release it in a `finally` spanning their
whole body (this repo has no `mint.test.ts` exercising a real broadcast —
`mintSingleSided`/`mintV4SingleSided` need live RPC/wallet access with no
injectable seam, the same reason `strategy.multiExecute.test.ts` uses
source-inspection for its own "execution boundary" checks). Verified to
fail against the pre-fix (unlocked) `mint.ts`/`v4.ts`, pass against the fix.

### P2-4 — GMGN trending schema drift silently returned `[]`

**File:** `src/gmgn/cli.ts`

**Root cause:** `gmgnMarketTrending` accepted only a bare array or
`{ rank: [...] }`; any other well-formed JSON shape (a field rename, `rank`
becoming a non-array) fell through to `return [];` — indistinguishable from
"the source responded and genuinely found nothing today", and never routed
through the `sourceError` mechanism `fetchAndFilterCandidates` relies on
(that mechanism only classifies a *thrown* error). MULTI would appear to
run normally with a healthy-looking empty candidate list forever.

**Fix:** The shape check was extracted into an exported, unit-testable
`parseTrendingResponse`, which now throws a `GmgnError` coded
`GMGN_CLI_MALFORMED_OUTPUT` for any shape other than the two recognized
ones (including `null`/non-object data). That error propagates through
`gmgnMarketTrending` and is caught by `fetchAndFilterCandidates`'s existing
try/catch — the exact same path an ENOENT or non-JSON failure already
takes.

**Failure scenario closed:** GMGN renames `rank` to something else; MULTI
silently stops trading with `sourceError: undefined` and an empty candidate
list every 6h cycle, indistinguishable from a quiet market.

**Tests:** `test/gmgnCli.trendingSchema.test.ts` (7 tests) — both
recognized shapes (including a genuinely empty `{ rank: [] }`, confirmed
*not* to be treated as an error), and every schema-drift shape (missing
`rank`, `rank` not an array, a renamed top-level field, `null`/`undefined`)
throwing the classified error. One bug caught by this test suite itself
during development: `JSON.stringify(undefined)` returns `undefined`, not a
string, which crashed the error-message `.slice()` call on `null`/
`undefined` input — fixed with `String(JSON.stringify(data))`. Verified to
fail against the pre-fix `return []`, pass against the fix.

### P2-5 — `accountCache` was the last unbounded module-level cache

**File:** `src/chain/clients.ts`

**Root cause:** Every other module-level cache in `src/` had already been
bounded (Phase 4.6.8/4.6.9's `metaCache`/`supplyCache` in `tokens.ts`,
`priceCache` in `dexscreener.ts`) — `accountCache` (keyed by wallet id,
never evicted) was the one the Phase 4.7 audit's accumulator inventory
flagged as the sole exception (F-10).

**Fix:** Added `setAccountCacheBounded`, mirroring `tokens.ts`'s
`setMetaCacheBounded` exactly — FIFO eviction via `Map`'s insertion order
once `MAX_ACCOUNT_CACHE_SIZE` (500) is reached. A cached `Account` never
goes stale, so eviction only ever costs one extra (cheap, local, no RPC)
`privateKeyToAccount` recomputation, never an incorrect result.

**Tests:** Added to the existing `test/memoryGrowth.test.ts` (which already
covers the other three bounded caches) — 3 new tests: bounded at 500 over
10,000 inserts, FIFO evicts the oldest key first, re-caching an existing key
doesn't consume a slot or evict. Verified to fail against the pre-fix
unbounded `Map.set`, pass against the fix.

### P2-6 — `tickSpacing` validation didn't reject non-integers

**File:** `src/chain/ticks.ts`

**Root cause:** `computeSingleSidedRange`'s guard checked
`Number.isFinite(tickSpacing) && tickSpacing > 0` but not integrality — a
fractional value like `2.5` passed this function's own input contract
(F-12). On-chain `tickSpacing` is always a real int24, so this was latent;
a fractional value does still throw today, but only incidentally, several
calls deeper, as an opaque `Invariant failed: INTEGERS` from the bundled
Uniswap SDK's `nearestUsableTick` — not a clear error attributable to this
function's own validation.

**Fix:** `Number.isInteger(tickSpacing)` (which already subsumes
finiteness — `Infinity`/`NaN` are not integers) replaces the finiteness
check.

**Tests:** Added to the existing `test/ticks.test.ts`'s tickSpacing
validation section — asserts the *specific* new error message via regex,
not just "throws", specifically to distinguish "rejected here, for this
stated reason" from "happened to blow up somewhere downstream" (a naive
`assert.throws()` with no message check would have passed against the
pre-fix code too, since the downstream SDK already throws for a different
reason — caught during verification and corrected before accepting the
test as valid).

## 4. Files Changed

| File | Change |
|---|---|
| `src/bot/positionCloseLock.ts` | new — shared close lock |
| `src/bot/tpslWatcher.ts` | use shared close lock instead of private Set |
| `src/bot/bot.ts` | manual `/close` acquires the shared close lock |
| `src/strategy/multiRisk.ts` | `checkPositionLimitsAsync` + `IncomingExposureEstimator` |
| `src/strategy/multiExecute.ts` | thread `exposureEstimator` through `runRiskGate`/`executeTradeIntent`/`runMultiStrategy` |
| `src/chain/mintLock.ts` | new — per-chain mint lock |
| `src/chain/mint.ts` | v3 mint path acquires the mint lock |
| `src/chain/v4.ts` | v4 mint path acquires the mint lock |
| `src/gmgn/cli.ts` | `parseTrendingResponse` throws on unrecognized shape |
| `src/chain/clients.ts` | `accountCache` bounded (FIFO, 500) |
| `src/chain/ticks.ts` | `tickSpacing` must be an integer |

## 5. New Tests

| File | Tests |
|---|---|
| `test/tpslWatcher.closeLock.test.ts` | 2 |
| `test/strategy.multiRisk.percentExposure.test.ts` | 5 |
| `test/chain.mintLock.test.ts` | 6 |
| `test/gmgnCli.trendingSchema.test.ts` | 7 |
| `test/memoryGrowth.test.ts` (+3) | 3 |
| `test/ticks.test.ts` (+1) | 1 |
| **Total** | **24** |

## 6. Verification Method

For every fix, the pre-fix code was temporarily restored (from an
out-of-repo backup, this project has no git history to diff against) and
the new test(s) re-run to confirm a genuine failure, then the fix was
restored and the test(s) re-run to confirm a pass — not inferred from
reading the diff. One test bug (P2-4's `JSON.stringify(undefined)` crash)
and one weak-test issue (P2-6's initial `assert.throws()` with no message
check, which passed against both pre- and post-fix code) were caught during
this process and corrected.

**Before:** 643/643 tests pass, typecheck clean.
**After:** 667/667 tests pass (24 new), typecheck clean, full suite re-run
clean start to finish.

## 7. Explicitly Not Done

Per instruction, no other file or behavior was touched. Remaining P2/P3
items from `PHASE4_7_FINAL_ADVERSARIAL_PRODUCTION_READINESS_AUDIT.md`
(F-07 no volume floor, F-08/F-09 unverified pool TVL/address, F-11 GMGN
aggregator trust boundary by design, F-13 collapsed range-rejection
reasons, F-14 dry-run range not necessarily the minted range, F-16 blind
`as T` casts in `gmgn/cli.ts`) remain open and undocumented-here by design —
none were in scope for this phase's six items. No new features were added.
