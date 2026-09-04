/**
 * Phase 4.8 — observability finding (Priority 2, item 4).
 *
 * Root cause (src/gmgn/cli.ts's gmgnMarketTrending, before this fix): a
 * well-formed, valid-JSON, non-error response that simply doesn't match
 * either expected shape (a bare array, or `{ rank: [...] }`) — e.g. GMGN
 * renaming `rank` to something else, or `rank` becoming an object instead
 * of an array — silently fell through to `return [];`. That is
 * indistinguishable from "the source responded and genuinely found no
 * trending tokens today", and never passes through the `sourceError`
 * mechanism multiCandidates.ts's fetchAndFilterCandidates relies on to
 * classify a candidate-source failure. MULTI would appear to run normally
 * with an empty candidate list forever, with no alertable signal that its
 * only candidate source had silently broken.
 *
 * Fix: the shape check was extracted into `parseTrendingResponse` (still
 * used by `gmgnMarketTrending` itself) and now throws a `GmgnError` coded
 * `GMGN_CLI_MALFORMED_OUTPUT` for any shape other than the two recognized
 * ones. That error propagates through `gmgnMarketTrending` and is caught by
 * fetchAndFilterCandidates's existing try/catch, which reports it as
 * `sourceError` instead of an empty candidate list — the same path an
 * ENOENT or non-JSON failure already takes (see test/gmgnCli.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GmgnError, parseTrendingResponse } from '../src/gmgn/cli.js';

test('parseTrendingResponse: a bare array is returned as-is', () => {
  const result = parseTrendingResponse([{ address: '0xabc' }]);
  assert.deepEqual(result, [{ address: '0xabc' }]);
});

test('parseTrendingResponse: { rank: [...] } is unwrapped to the array', () => {
  const result = parseTrendingResponse({ rank: [{ address: '0xdef' }] });
  assert.deepEqual(result, [{ address: '0xdef' }]);
});

test('parseTrendingResponse: a genuinely empty { rank: [] } is a real, legitimate empty result — not an error', () => {
  const result = parseTrendingResponse({ rank: [] });
  assert.deepEqual(result, [], 'a real "no trending tokens today" response must not be reported as a schema error');
});

test('parseTrendingResponse: a schema rename ({} without .rank) throws GMGN_CLI_MALFORMED_OUTPUT instead of silently returning []', () => {
  assert.throws(
    () => parseTrendingResponse({}),
    (err: GmgnError) => {
      assert.ok(err instanceof GmgnError, 'must throw a classified GmgnError, not a generic error or silent []');
      assert.equal(err.code, 'GMGN_CLI_MALFORMED_OUTPUT');
      return true;
    },
  );
});

test('parseTrendingResponse: .rank present but not an array (schema drift) throws, not silently coerced', () => {
  assert.throws(
    () => parseTrendingResponse({ rank: 'not an array' }),
    (err: GmgnError) => {
      assert.equal(err.code, 'GMGN_CLI_MALFORMED_OUTPUT');
      return true;
    },
  );
});

test('parseTrendingResponse: a renamed top-level field (e.g. "list" instead of "rank") throws, not silently returns []', () => {
  assert.throws(
    () => parseTrendingResponse({ list: [{ address: '0xabc' }] }),
    (err: GmgnError) => {
      assert.equal(err.code, 'GMGN_CLI_MALFORMED_OUTPUT');
      return true;
    },
  );
});

test('parseTrendingResponse: null/undefined data throws rather than being treated as an empty result', () => {
  assert.throws(() => parseTrendingResponse(null), (err: GmgnError) => err.code === 'GMGN_CLI_MALFORMED_OUTPUT');
  assert.throws(() => parseTrendingResponse(undefined), (err: GmgnError) => err.code === 'GMGN_CLI_MALFORMED_OUTPUT');
});
