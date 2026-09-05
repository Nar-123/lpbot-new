/**
 * Periodic autonomous agent runner — mirrors meridian-rs's own two-timer
 * model (screening_interval_min for discovery, management_interval_min for
 * position review), and mirrors THIS codebase's own tpslWatcher.ts for its
 * start/stop lifecycle conventions (idempotent start, awaitable graceful
 * stop, injectable deps for testing, no real timers in unit tests).
 *
 * Gated behind config.autonomousSchedule (default OFF even when
 * AGENT_MODE=on) — see agent/config.ts's doc comment for why this is a
 * separate, higher-friction opt-in from AGENT_MODE itself.
 */
import type { Bot } from 'grammy';
import { CHAINS, isSupportedChainId, type SupportedChainId } from '../config.js';
import { getAgentMode, loadAgentConfig, type AgentConfig } from './config.js';
import { createAnthropicClient } from './llmClient.js';
import { runAgent } from './loop.js';
import type { AgentRunLog } from './types.js';

type SchedulerState = 'stopped' | 'running';

let screeningTimer: ReturnType<typeof setInterval> | null = null;
let managementTimer: ReturnType<typeof setInterval> | null = null;
let state: SchedulerState = 'stopped';
let inFlight = false;

type SchedulerDeps = {
  runAgent: typeof runAgent;
};
// eslint-disable-next-line @typescript-eslint/no-use-before-define
let deps: SchedulerDeps = { runAgent };
export function __setSchedulerDepsForTests(overrides: Partial<SchedulerDeps>): void {
  deps = { ...deps, ...overrides };
}
export function __resetSchedulerDepsForTests(): void {
  deps = { runAgent };
}

async function notifyAll(bot: Bot, text: string): Promise<void> {
  const { config } = await import('../config.js');
  for (const uid of [...config.allowedUserIds]) {
    try {
      await bot.api.sendMessage(uid, text, { link_preview_options: { is_disabled: true } });
    } catch (e) {
      console.warn('[agent-scheduler] notify', uid, e instanceof Error ? e.message : e);
    }
  }
}

function summarize(log: AgentRunLog): string {
  const actionLines = log.toolCalls
    .filter((c) => c.name === 'deploy_position' || c.name === 'close_position')
    .map((c) => `• ${c.name}(${JSON.stringify(c.args)}) → ${c.resultSummary}`);
  const header = `🤖 Scheduled agent (${log.role}) — ${log.steps} step(s), stopped: ${log.stoppedReason}`;
  return [header, ...actionLines, log.finalText].filter(Boolean).join('\n').slice(0, 3900);
}

async function runOneCycle(bot: Bot, role: 'screener' | 'manager', agentConfig: AgentConfig): Promise<void> {
  if (inFlight) return; // never overlap a scheduled run with another already in flight (screener/manager share this guard deliberately — simpler than per-role tracking, and this codebase's own capital-moving tools already serialize via mint/close locks regardless)
  if (getAgentMode() !== 'on' || !agentConfig.apiKey) return;
  inFlight = true;
  try {
    const chainIdRaw = Number(process.env.MULTI_CHAIN_ID ?? 4663);
    const chainId: SupportedChainId = isSupportedChainId(chainIdRaw) ? chainIdRaw : 4663;
    const goal =
      role === 'screener'
        ? `Look for one good MULTI candidate to enter on chain ${CHAINS[chainId].name} and deploy into it if one clearly qualifies. It is completely fine to conclude that nothing qualifies right now.`
        : `Review currently open positions on chain ${CHAINS[chainId].name} and close any that should be closed. It is completely fine to conclude that no action is needed right now.`;
    const llm = createAnthropicClient(agentConfig.apiKey!, agentConfig.model);
    const log = await deps.runAgent(role, chainId, goal, { llm, config: agentConfig });
    await notifyAll(bot, summarize(log));
  } catch (e) {
    console.error(`[agent-scheduler] ${role} cycle failed`, e);
  } finally {
    inFlight = false;
  }
}

/**
 * Idempotent start — a second call while already running is a no-op (same
 * convention as tpslWatcher.ts's startTpslWatcher). No-ops entirely (does
 * not even set up timers) unless AGENT_MODE=on AND
 * AGENT_AUTONOMOUS_SCHEDULE=on — both explicit opt-ins are required.
 */
export function startAgentScheduler(bot: Bot): void {
  if (state === 'running') return;
  const agentConfig = loadAgentConfig();
  if (getAgentMode() !== 'on' || !agentConfig.autonomousSchedule) return;
  state = 'running';
  screeningTimer = setInterval(() => void runOneCycle(bot, 'screener', agentConfig), agentConfig.screeningIntervalMs);
  managementTimer = setInterval(() => void runOneCycle(bot, 'manager', agentConfig), agentConfig.managementIntervalMs);
  console.log(
    `[agent-scheduler] started — screening every ${agentConfig.screeningIntervalMs / 60_000}min, management every ${agentConfig.managementIntervalMs / 60_000}min`,
  );
}

export function stopAgentScheduler(): void {
  if (screeningTimer) clearInterval(screeningTimer);
  if (managementTimer) clearInterval(managementTimer);
  screeningTimer = null;
  managementTimer = null;
  state = 'stopped';
}

export function __getSchedulerStateForTests(): SchedulerState {
  return state;
}

/** Test-only: run one cycle directly, bypassing the interval timer entirely. */
export async function __runCycleForTests(bot: Bot, role: 'screener' | 'manager'): Promise<void> {
  await runOneCycle(bot, role, loadAgentConfig());
}

export function __resetSchedulerForTests(): void {
  stopAgentScheduler();
  inFlight = false;
  __resetSchedulerDepsForTests();
}
