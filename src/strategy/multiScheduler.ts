/**
 * Periodic autonomous runner for the deterministic MULTI strategy
 * (runMultiStrategy) — NO LLM involved at all, unlike agent/scheduler.ts
 * (which drives the LLM ReAct loop via runAgent). This is a separate
 * scheduler entirely, not a modification of agent/scheduler.ts.
 *
 * Mirrors this codebase's own established lifecycle conventions:
 * tpslWatcher.ts's idempotent start/stop, and agent/scheduler.ts's own
 * DI/inFlight-guard pattern for a periodic strategy runner.
 *
 * Gated behind TWO explicit opt-ins, same split as AGENT_MODE vs
 * AGENT_AUTONOMOUS_SCHEDULE in agent/config.ts:
 *   1. STRATEGY=multi (getActiveStrategyName() — the same base gate the
 *      manual /multi command itself uses).
 *   2. config.autonomousSchedule (MULTI_AUTONOMOUS_SCHEDULE=on, default
 *      off) — a separate, higher-friction opt-in. STRATEGY=multi alone
 *      only makes the manual /multi command available; nothing runs on
 *      its own until this is ALSO explicitly turned on.
 */
import type { Bot } from 'grammy';
import { config as appConfig } from '../config.js';
import { getActiveStrategyName, loadMultiConfig } from './multiConfig.js';
import { runMultiStrategy } from './multiExecute.js';
import type { MultiStrategyRun } from './types.js';

type SchedulerState = 'stopped' | 'running';

let screeningTimer: ReturnType<typeof setInterval> | null = null;
let state: SchedulerState = 'stopped';
let inFlight = false;

type SchedulerDeps = {
  runMultiStrategy: typeof runMultiStrategy;
};
// eslint-disable-next-line @typescript-eslint/no-use-before-define
let deps: SchedulerDeps = { runMultiStrategy };
export function __setSchedulerDepsForTests(overrides: Partial<SchedulerDeps>): void {
  deps = { ...deps, ...overrides };
}
export function __resetSchedulerDepsForTests(): void {
  deps = { runMultiStrategy };
}

async function notifyAll(bot: Bot, text: string): Promise<void> {
  for (const uid of [...appConfig.allowedUserIds]) {
    try {
      await bot.api.sendMessage(uid, text, { link_preview_options: { is_disabled: true } });
    } catch (e) {
      console.warn('[multi-scheduler] notify', uid, e instanceof Error ? e.message : e);
    }
  }
}

/** Only ever called when at least one position was actually opened — an empty/no-op cycle never notifies (would spam every 15min otherwise). */
function summarize(run: MultiStrategyRun): string {
  const lines = run.executed.map(
    (e) => `• ${e.intent.token} → tokenId=${e.tokenId} tx=${e.txHash}`,
  );
  return [
    `🤖 Scheduled MULTI scan (chain ${run.chainId}) — ${run.executed.length} position(s) opened`,
    ...lines,
  ].join('\n').slice(0, 3900);
}

async function runOneCycle(bot: Bot): Promise<void> {
  if (inFlight) return; // never overlap a scheduled run with another already in flight
  if (getActiveStrategyName() !== 'multi') return;
  const config = loadMultiConfig();
  inFlight = true;
  try {
    if (!config.enabled) return; // invalid/disabled config (see validateMultiConfig) — nothing to run
    const run = await deps.runMultiStrategy(config, { dryRun: false });
    if (run.executed.length > 0) {
      await notifyAll(bot, summarize(run));
    }
  } catch (e) {
    console.error('[multi-scheduler] cycle failed', e);
  } finally {
    inFlight = false;
  }
}

/**
 * Idempotent start — a second call while already running is a no-op (same
 * convention as tpslWatcher.ts's startTpslWatcher). No-ops entirely (does
 * not even set up a timer) unless STRATEGY=multi AND
 * MULTI_AUTONOMOUS_SCHEDULE=on — both explicit opt-ins are required.
 */
export function startMultiScheduler(bot: Bot): void {
  if (state === 'running') return;
  if (getActiveStrategyName() !== 'multi') return;
  const config = loadMultiConfig();
  if (!config.autonomousSchedule) return;
  state = 'running';
  screeningTimer = setInterval(() => void runOneCycle(bot), config.screeningIntervalMs);
  console.log(`[multi-scheduler] started — scanning every ${config.screeningIntervalMs / 60_000}min`);
}

export function stopMultiScheduler(): void {
  if (screeningTimer) clearInterval(screeningTimer);
  screeningTimer = null;
  state = 'stopped';
}

export function __getSchedulerStateForTests(): SchedulerState {
  return state;
}

/** Test-only: run one cycle directly, bypassing the interval timer entirely. */
export async function __runCycleForTests(bot: Bot): Promise<void> {
  await runOneCycle(bot);
}

export function __resetSchedulerForTests(): void {
  stopMultiScheduler();
  inFlight = false;
  __resetSchedulerDepsForTests();
}
