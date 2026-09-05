/**
 * One-shot diagnostic: collect real GMGN candidate volume data for
 * calibrating MULTI_MIN_CANDIDATE_VOLUME_USD. Read-only — never mints,
 * never deploys, never touches the wallet or chain state.
 *
 * The .env-configured volume floor is overridden to 0 IN MEMORY ONLY
 * (never writes to .env) so every candidate with volume > 0 (the one
 * hard, non-configurable floor — see multiCandidates.ts's
 * VOLUME_NON_POSITIVE check) passes through; every other filter
 * (market cap, token age, KOL count, interval) stays exactly as
 * configured in .env, so the collected data reflects the same
 * combination of filters already calibrated on this branch.
 *
 * Usage: npx tsx scripts/collect-candidate-volume-data.ts
 */
import 'dotenv/config';
import { fetchAndFilterCandidates } from '../src/strategy/multiCandidates.js';
import { loadMultiConfig } from '../src/strategy/multiConfig.js';
import type { MultiCandidate } from '../src/strategy/types.js';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

async function main(): Promise<void> {
  const baseConfig = loadMultiConfig();

  if (!baseConfig.enabled) {
    console.error(`MULTI config is disabled — cannot collect data. disabledReason: ${baseConfig.disabledReason}`);
    process.exitCode = 1;
    return;
  }

  // In-memory only — .env itself is never touched. This is the ONE hard
  // floor we temporarily zero out; VOLUME_NON_POSITIVE (volume must still
  // be > 0) is always-on regardless and cannot be disabled this way.
  const config = { ...baseConfig, minCandidateVolumeUsd: 0 };

  console.log('── Config used for this collection ──');
  console.log(`interval:          ${config.interval}`);
  console.log(`minMarketCapUsd:   ${config.minMarketCapUsd}`);
  console.log(`minTokenAgeHours:  ${config.minTokenAgeHours}`);
  console.log(`minKolCount:       ${config.minKolCount}`);
  console.log(`minCandidateVolumeUsd: 0 (OVERRIDDEN in-memory for this collection only — .env unchanged)`);
  console.log(`topN:              ${config.topN}`);
  console.log('');

  const { candidates, rejected, sourceError } = await fetchAndFilterCandidates(config);

  if (sourceError) {
    console.error(`GMGN candidate source error — code=${sourceError.code}: ${sourceError.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Fetched: ${candidates.length} candidate(s) passed market cap/age/KOL/classification (volume floor disabled); ${rejected.length} rejected on other grounds.`);
  console.log('');

  if (candidates.length === 0) {
    console.log('No candidates matched — nothing to report. Try again during higher market activity, or check that GMGN CLI is configured correctly.');
    return;
  }

  const sorted = [...candidates].sort((a, b) => (b.volumeUsd ?? 0) - (a.volumeUsd ?? 0));

  const addrCol = 10;
  const symCol = 10;
  const volCol = 14;
  const mcCol = 14;
  const ageCol = 10;
  const kolCol = 6;
  const scoreCol = 8;

  function row(cells: string[]): string {
    return cells.join(' | ');
  }

  console.log(
    row([
      'address'.padEnd(addrCol),
      'symbol'.padEnd(symCol),
      'volumeUsd'.padStart(volCol),
      'marketCapUsd'.padStart(mcCol),
      'ageHours'.padStart(ageCol),
      'kolCnt'.padStart(kolCol),
      'score'.padStart(scoreCol),
    ]),
  );
  console.log('-'.repeat(addrCol + symCol + volCol + mcCol + ageCol + kolCol + scoreCol + 6 * 3));

  for (const c of sorted) {
    console.log(
      row([
        c.address.slice(0, 8).padEnd(addrCol),
        (c.symbol ?? '?').slice(0, symCol).padEnd(symCol),
        (c.volumeUsd != null ? fmtUsd(c.volumeUsd) : 'n/a').padStart(volCol),
        (c.marketCapUsd != null ? fmtUsd(c.marketCapUsd) : 'n/a').padStart(mcCol),
        (c.ageHours != null ? c.ageHours.toFixed(1) : 'n/a').padStart(ageCol),
        (c.kolCount != null ? String(c.kolCount) : 'n/a').padStart(kolCol),
        c.candidateScore.toFixed(3).padStart(scoreCol),
      ]),
    );
  }

  console.log('');
  console.log('── Volume statistics (USD) across matched candidates ──');
  const volumes: number[] = sorted
    .map((c: MultiCandidate) => c.volumeUsd)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);

  if (volumes.length === 0) {
    console.log('No candidate had a known volumeUsd — cannot compute statistics.');
    return;
  }

  console.log(`count:  ${volumes.length}`);
  console.log(`min:    ${fmtUsd(volumes[0]!)}`);
  console.log(`p25:    ${fmtUsd(percentile(volumes, 25))}`);
  console.log(`median: ${fmtUsd(percentile(volumes, 50))}`);
  console.log(`p75:    ${fmtUsd(percentile(volumes, 75))}`);
  console.log(`p90:    ${fmtUsd(percentile(volumes, 90))}`);
  console.log(`max:    ${fmtUsd(volumes[volumes.length - 1]!)}`);
}

main().catch((e) => {
  console.error('Unexpected error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
