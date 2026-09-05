import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLift,
  defaultWeightTuningConfig,
  recalculateWeights,
  type PerformanceRecord,
  type SignalWeights,
} from '../src/strategy/signalWeights.js';

function rec(overrides: Partial<PerformanceRecord> = {}): PerformanceRecord {
  return { signals: {}, realizedUsd: 0, closedAt: Date.now(), ...overrides };
}

// ── computeLift ────────────────────────────────────────────────

test('computeLift is positive when higher normalized values coincide with wins', () => {
  const records: PerformanceRecord[] = [
    rec({ signals: { volume6hUsd: 100 }, realizedUsd: 50 }), // win, high
    rec({ signals: { volume6hUsd: 90 }, realizedUsd: 40 }), // win, high
    rec({ signals: { volume6hUsd: 10 }, realizedUsd: -20 }), // loss, low
    rec({ signals: { volume6hUsd: 5 }, realizedUsd: -10 }), // loss, low
  ];
  const lift = computeLift(records, 'volume6hUsd');
  assert.ok(lift != null && lift > 0.5, `expected strong positive lift, got ${lift}`);
});

test('computeLift is negative when higher normalized values coincide with losses', () => {
  const records: PerformanceRecord[] = [
    rec({ signals: { ageHours: 1 }, realizedUsd: 50 }),
    rec({ signals: { ageHours: 2 }, realizedUsd: 40 }),
    rec({ signals: { ageHours: 100 }, realizedUsd: -20 }),
    rec({ signals: { ageHours: 200 }, realizedUsd: -10 }),
  ];
  const lift = computeLift(records, 'ageHours');
  assert.ok(lift != null && lift < -0.5, `expected strong negative lift, got ${lift}`);
});

test('computeLift returns null (never 0) when one class has no known values for the signal', () => {
  const records: PerformanceRecord[] = [
    rec({ signals: { poolFee: 3000 }, realizedUsd: 50 }),
    rec({ signals: {}, realizedUsd: -20 }), // loss, signal unknown
  ];
  assert.equal(computeLift(records, 'poolFee'), null);
});

test('computeLift returns null when the signal has zero variance across all records', () => {
  const records: PerformanceRecord[] = [
    rec({ signals: { poolFee: 3000 }, realizedUsd: 50 }),
    rec({ signals: { poolFee: 3000 }, realizedUsd: -20 }),
  ];
  assert.equal(computeLift(records, 'poolFee'), null);
});

// ── recalculateWeights: insufficient data guard ─────────────────

test('recalculateWeights leaves weights completely unchanged with too few samples', () => {
  const current: SignalWeights = { volume6hUsd: 0.3, poolTvlUsd: 0.3 };
  const records: PerformanceRecord[] = [
    rec({ signals: { volume6hUsd: 100 }, realizedUsd: 50 }),
    rec({ signals: { volume6hUsd: 10 }, realizedUsd: -20 }),
  ]; // 1 win, 1 loss — below default minSamplesPerClass=5
  const result = recalculateWeights(current, records);
  assert.deepEqual(result, current);
});

test('recalculateWeights ignores records outside the configured window', () => {
  const current: SignalWeights = {
    volume6hUsd: 0.3,
    poolTvlUsd: 0.3,
    poolVolumeUsd: 0.2,
    poolFee: 0.2,
  };
  const old = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 days ago
  const records: PerformanceRecord[] = Array.from({ length: 10 }, (_, i) =>
    rec({
      signals: { volume6hUsd: i < 5 ? 100 : 10 },
      realizedUsd: i < 5 ? 50 : -20,
      closedAt: old,
    }),
  );
  const result = recalculateWeights(current, records, { ...defaultWeightTuningConfig(), windowDays: 30 });
  assert.deepEqual(result, current, 'old records outside the window must not count toward the sample threshold');
});

// ── recalculateWeights: quartile boost/decay ────────────────────

test('recalculateWeights boosts the top-lift signal and decays the bottom-lift signal, leaving the middle untouched', () => {
  const current: SignalWeights = {
    volume6hUsd: 0.3, // will have strong POSITIVE lift (high in wins)
    poolTvlUsd: 0.3, // middling — deliberately uncorrelated
    poolVolumeUsd: 0.2, // middling — deliberately uncorrelated
    ageHours: 0.2, // will have strong NEGATIVE lift (high in losses)
  };
  const records: PerformanceRecord[] = Array.from({ length: 12 }, (_, i) => {
    const isWin = i < 6;
    return rec({
      signals: {
        volume6hUsd: isWin ? 100 + i : 10 + i,
        // Uncorrelated with outcome (alternates regardless of isWin) — has
        // real variance (so it stays "scoreable", unlike a constant value
        // which correctly returns null lift and gets excluded from
        // ranking), but its lift should land near zero, in the middle.
        poolTvlUsd: i % 2 === 0 ? 80 : 20,
        poolVolumeUsd: i % 2 === 0 ? 20 : 80,
        ageHours: isWin ? 1 + i : 500 + i,
      },
      realizedUsd: isWin ? 50 : -20,
    });
  });
  const result = recalculateWeights(current, records);
  assert.ok(result.volume6hUsd! > current.volume6hUsd!, 'positive-lift signal should be boosted');
  assert.ok(result.ageHours! < current.ageHours!, 'negative-lift signal should be decayed');
});

test('recalculateWeights never pushes a weight below the configured floor', () => {
  const current: SignalWeights = { volume6hUsd: 0.3, poolTvlUsd: 0.06, poolVolumeUsd: 0.2, ageHours: 0.2 };
  const records: PerformanceRecord[] = Array.from({ length: 12 }, (_, i) => {
    const isWin = i < 6;
    return rec({
      signals: {
        volume6hUsd: isWin ? 100 + i : 10 + i,
        poolTvlUsd: isWin ? 1 + i : 500 + i, // strong negative lift — repeated decay would breach the floor
        poolVolumeUsd: 50,
        ageHours: 50,
      },
      realizedUsd: isWin ? 50 : -20,
    });
  });
  const config = { ...defaultWeightTuningConfig(), decayFactor: 0.5, floor: 0.05 };
  let weights = current;
  for (let i = 0; i < 10; i++) {
    weights = recalculateWeights(weights, records, config);
  }
  assert.ok(weights.poolTvlUsd! >= 0.05 - 1e-9, `weight ${weights.poolTvlUsd} fell below the floor`);
});

test('recalculateWeights never pushes a weight above the configured ceiling', () => {
  const current: SignalWeights = { volume6hUsd: 0.9, poolTvlUsd: 0.2, poolVolumeUsd: 0.2, ageHours: 0.2 };
  const records: PerformanceRecord[] = Array.from({ length: 12 }, (_, i) => {
    const isWin = i < 6;
    return rec({
      signals: {
        volume6hUsd: isWin ? 100 + i : 10 + i, // strong positive lift — repeated boost would breach the ceiling
        poolTvlUsd: 50,
        poolVolumeUsd: 50,
        ageHours: 50,
      },
      realizedUsd: isWin ? 50 : -20,
    });
  });
  const config = { ...defaultWeightTuningConfig(), boostFactor: 1.5, ceiling: 1.0 };
  let weights = current;
  for (let i = 0; i < 10; i++) {
    weights = recalculateWeights(weights, records, config);
  }
  assert.ok(weights.volume6hUsd! <= 1.0 + 1e-9, `weight ${weights.volume6hUsd} exceeded the ceiling`);
});

test('recalculateWeights never invents a weight for a signal absent from currentWeights', () => {
  const current: SignalWeights = { volume6hUsd: 0.3, poolTvlUsd: 0.3, poolVolumeUsd: 0.2, ageHours: 0.2 };
  // poolFee is never in currentWeights — even with a full, strongly-differentiated dataset.
  const records: PerformanceRecord[] = Array.from({ length: 12 }, (_, i) => {
    const isWin = i < 6;
    return rec({
      signals: { volume6hUsd: isWin ? 100 : 10, poolFee: isWin ? 3000 : 500 },
      realizedUsd: isWin ? 50 : -20,
    });
  });
  const result = recalculateWeights(current, records);
  assert.equal(result.poolFee, undefined);
});

test('with fewer than 4 scoreable signals, weights are left untouched (quartile split is not meaningful)', () => {
  const current: SignalWeights = { volume6hUsd: 0.5, poolTvlUsd: 0.5 };
  const records: PerformanceRecord[] = Array.from({ length: 12 }, (_, i) => {
    const isWin = i < 6;
    return rec({ signals: { volume6hUsd: isWin ? 100 : 10 }, realizedUsd: isWin ? 50 : -20 });
  });
  const result = recalculateWeights(current, records);
  assert.deepEqual(result, current);
});
