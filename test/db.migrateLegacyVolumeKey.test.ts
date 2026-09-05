/**
 * SUB-FASE 3B — backward-compat read shim for the volume6hUsd -> volumeUsd
 * rename (strategy/signalWeights.ts's SignalName, strategy/types.ts's
 * MultiCandidate).
 *
 * A deployment that ran before this rename may already have `entry_signals`
 * (per position) or `tuned_signal_weights` persisted with the OLD key
 * 'volume6hUsd'. db/index.ts's migrateLegacyVolumeKey (called only at the
 * two read points below, never at write) must fill in 'volumeUsd' from the
 * old key's value without deleting the old key or touching genuinely new
 * data.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-migrate-legacy-volume-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const {
  recordOpenPosition,
  markClosed,
  getSignalPerformanceHistory,
  getTunedSignalWeights,
  setTunedSignalWeights,
  __resetStoreForTests,
} = await import('../src/db/index.js');

const CHAIN = 4663;

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

let tokenCounter = 1;
function freshTokenId(): string {
  tokenCounter++;
  return `legacy-vol-${tokenCounter}`;
}

function openAndCloseWithSignals(tokenId: string, signals: Record<string, number>): void {
  recordOpenPosition({
    chainId: CHAIN,
    tokenId,
    poolAddress: '0xpool',
    token0: '0xusdg',
    token1: '0xtok',
    fee: 3000,
    tickLower: 0,
    tickUpper: 100,
    strategy: 'multi',
    entrySignals: signals,
  });
  markClosed(CHAIN, tokenId);
}

test.beforeEach(resetDb);

// ── entry_signals (getSignalPerformanceHistory) ─────────────────────────

test('getSignalPerformanceHistory: legacy entry_signals (only "volume6hUsd", no "volumeUsd") gets "volumeUsd" filled in with the same value', () => {
  const tokenId = freshTokenId();
  openAndCloseWithSignals(tokenId, { volume6hUsd: 250_000, marketCapUsd: 5_000_000 });

  const history = getSignalPerformanceHistory(CHAIN);
  const row = history.find((h) => h.closedAt != null); // just-closed row
  assert.ok(row, 'sanity: the closed position must appear in history');
  assert.equal(row!.signals.volumeUsd, 250_000, 'volumeUsd must be filled in from the legacy volume6hUsd value');
  assert.equal(row!.signals.volume6hUsd, 250_000, 'the old key must be left in place, never deleted');
  assert.equal(row!.signals.marketCapUsd, 5_000_000, 'unrelated signals must pass through untouched');
});

test('getSignalPerformanceHistory: new-style entry_signals (already "volumeUsd") pass through unchanged — no duplication, no corruption', () => {
  const tokenId = freshTokenId();
  openAndCloseWithSignals(tokenId, { volumeUsd: 300_000, marketCapUsd: 6_000_000 });

  const history = getSignalPerformanceHistory(CHAIN);
  const row = history.find((h) => h.closedAt != null);
  assert.ok(row);
  assert.equal(row!.signals.volumeUsd, 300_000);
  assert.equal('volume6hUsd' in row!.signals, false, 'the shim must never invent a legacy key for new data');
  assert.equal(Object.keys(row!.signals).length, 2, 'no extra keys added for already-current data');
});

test('getSignalPerformanceHistory: a record with BOTH keys already present is left exactly as stored (new key wins, shim does not overwrite it)', () => {
  const tokenId = freshTokenId();
  openAndCloseWithSignals(tokenId, { volume6hUsd: 111, volumeUsd: 999 });

  const history = getSignalPerformanceHistory(CHAIN);
  const row = history.find((h) => h.closedAt != null);
  assert.equal(row!.signals.volumeUsd, 999, 'an already-present volumeUsd must never be overwritten by the legacy value');
});

// ── tuned_signal_weights (getTunedSignalWeights) ────────────────────────

test('getTunedSignalWeights: legacy weights (only "volume6hUsd") get "volumeUsd" filled in with the same value', () => {
  setTunedSignalWeights({ volume6hUsd: 0.42, poolTvlUsd: 0.3 });

  const weights = getTunedSignalWeights();
  assert.ok(weights);
  assert.equal(weights!.volumeUsd, 0.42);
  assert.equal(weights!.volume6hUsd, 0.42, 'old key left in place');
  assert.equal(weights!.poolTvlUsd, 0.3);
});

test('getTunedSignalWeights: new-style weights (already "volumeUsd") pass through unchanged', () => {
  setTunedSignalWeights({ volumeUsd: 0.55, poolTvlUsd: 0.3 });

  const weights = getTunedSignalWeights();
  assert.ok(weights);
  assert.equal(weights!.volumeUsd, 0.55);
  assert.equal('volume6hUsd' in weights!, false);
  assert.equal(Object.keys(weights!).length, 2);
});

test('getTunedSignalWeights: returns null when nothing has ever been persisted (shim must not fabricate a result)', () => {
  assert.equal(getTunedSignalWeights(), null);
});
