/**
 * resolveRangePercentForCandidate (src/strategy/multiExecute.ts) —
 * volume-tiered range width selection (FASE 2).
 *
 * Pure function, no network/DB — takes a candidate + config and returns
 * which widthPercent to hand to computeMultiRange. 'static' mode (default,
 * unset MULTI_RANGE_MODE) must be byte-for-byte the pre-existing behavior:
 * always config.rangePercent, regardless of candidate volume.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRangePercentForCandidate } from '../src/strategy/multiExecute.js';
import type { MultiCandidate } from '../src/strategy/types.js';
import type { MultiConfig } from '../src/strategy/multiConfig.js';

function candidateWithVolume(volume6hUsd: number): MultiCandidate {
  return {
    address: '0xaaa',
    symbol: 'TOK',
    name: 'Token',
    chainId: 4663,
    marketCapUsd: 2_000_000,
    ageHours: 48,
    volume6hUsd,
    liquidityUsd: 200_000,
    kolCount: 10,
    classification: 'MEME',
    launchpadPlatform: 'pump.fun',
    candidateScore: 1,
    reasons: [],
    source: 'gmgn_trending_6h',
    sourceTimestamp: Date.now(),
  };
}

function config(overrides: Partial<MultiConfig> = {}): MultiConfig {
  return {
    rangeMode: 'static',
    rangePercent: 50,
    rangeTierVolumeUsd: 500_000,
    rangeTierLowPercent: 50,
    rangeTierHighPercent: 30,
    ...overrides,
  } as MultiConfig;
}

test('rangeMode="static" (default): always returns config.rangePercent, regardless of candidate volume', () => {
  const cfg = config({ rangeMode: 'static', rangePercent: 42 });
  assert.equal(resolveRangePercentForCandidate(candidateWithVolume(1), cfg), 42);
  assert.equal(resolveRangePercentForCandidate(candidateWithVolume(1_000_000), cfg), 42);
  assert.equal(resolveRangePercentForCandidate(candidateWithVolume(500_000), cfg), 42);
  assert.equal(resolveRangePercentForCandidate(candidateWithVolume(999_999_999), cfg), 42);
});

test('rangeMode unset on the config object also behaves as static (defensive — matches loadMultiConfig\'s own default)', () => {
  const cfg = { rangePercent: 55, rangeTierVolumeUsd: 500_000, rangeTierLowPercent: 50, rangeTierHighPercent: 30 } as MultiConfig;
  assert.equal(resolveRangePercentForCandidate(candidateWithVolume(10_000_000), cfg), 55);
});

test('rangeMode="volume_tiered": volume below the tier threshold (400,000 < 500,000) uses rangeTierLowPercent (50)', () => {
  const cfg = config({ rangeMode: 'volume_tiered', rangeTierVolumeUsd: 500_000, rangeTierLowPercent: 50, rangeTierHighPercent: 30 });
  assert.equal(resolveRangePercentForCandidate(candidateWithVolume(400_000), cfg), 50);
});

test('rangeMode="volume_tiered": volume above the tier threshold (600,000 > 500,000) uses rangeTierHighPercent (30)', () => {
  const cfg = config({ rangeMode: 'volume_tiered', rangeTierVolumeUsd: 500_000, rangeTierLowPercent: 50, rangeTierHighPercent: 30 });
  assert.equal(resolveRangePercentForCandidate(candidateWithVolume(600_000), cfg), 30);
});

test('rangeMode="volume_tiered": volume EXACTLY at the tier threshold (500,000) uses rangeTierHighPercent (30) — proves >=, not >', () => {
  const cfg = config({ rangeMode: 'volume_tiered', rangeTierVolumeUsd: 500_000, rangeTierLowPercent: 50, rangeTierHighPercent: 30 });
  assert.equal(resolveRangePercentForCandidate(candidateWithVolume(500_000), cfg), 30);
});

test('rangeMode="volume_tiered": one dollar below the threshold still uses the low tier', () => {
  const cfg = config({ rangeMode: 'volume_tiered', rangeTierVolumeUsd: 500_000, rangeTierLowPercent: 50, rangeTierHighPercent: 30 });
  assert.equal(resolveRangePercentForCandidate(candidateWithVolume(499_999.99), cfg), 50);
});

test('rangeMode="volume_tiered": a non-default tier threshold/percents are honored exactly (not hardcoded to the 500k/50/30 defaults)', () => {
  const cfg = config({ rangeMode: 'volume_tiered', rangeTierVolumeUsd: 1_000_000, rangeTierLowPercent: 20, rangeTierHighPercent: 70 });
  assert.equal(resolveRangePercentForCandidate(candidateWithVolume(999_999), cfg), 20);
  assert.equal(resolveRangePercentForCandidate(candidateWithVolume(1_000_000), cfg), 70);
});
