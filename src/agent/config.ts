/**
 * Autonomous LLM agent — global toggle and safety bounds.
 *
 * Mirrors the exact pattern already established by config.ts's TRADING_MODE
 * and strategy/multiConfig.ts's STRATEGY: OFF is the default (byte-for-byte
 * unchanged behavior for anyone who never sets AGENT_MODE), a present-but-
 * unrecognized value fails closed at startup rather than being silently
 * absorbed, and the live read stays a cheap sync check with no I/O.
 *
 * This module only decides WHETHER the agent may run and HOW MANY actions
 * it gets per invocation. It does not grant the agent any capability the
 * rest of the codebase doesn't already expose — every tool the agent calls
 * (src/agent/tools.ts) still goes through the exact same risk gate, mint
 * lock, and close lock as a manual command or the deterministic MULTI
 * strategy. The agent picks WHAT/WHEN; it never gets a private execution
 * path that skips validation.
 */

export type AgentMode = 'off' | 'on';

const VALID_AGENT_MODES: readonly AgentMode[] = ['off', 'on'];

export function getAgentMode(): AgentMode {
  const raw = (process.env.AGENT_MODE ?? 'off').trim().toLowerCase();
  return raw === 'on' ? 'on' : 'off';
}

/** Startup-time validation — call once, alongside assertValidTradingModeEnv/assertValidStrategyEnv. */
export function assertValidAgentModeEnv(): void {
  const raw = process.env.AGENT_MODE;
  if (raw == null) return;
  const normalized = raw.trim().toLowerCase();
  if ((VALID_AGENT_MODES as readonly string[]).includes(normalized)) return;
  throw new Error(
    `Invalid AGENT_MODE "${raw}": expected one of ${VALID_AGENT_MODES.join(', ')} (or unset, which defaults to 'off')`,
  );
}

/**
 * Which LLM backend agent/llmClient.ts's createLlmClientFromConfig
 * constructs. 'anthropic' (unset AGENT_LLM_PROVIDER) is the default —
 * byte-for-byte the same behavior as before this option existed. Mirrors
 * the same fail-closed-on-present-but-unrecognized-value pattern as
 * AGENT_MODE/STRATEGY/TRADING_MODE elsewhere in this codebase.
 */
export type AgentLlmProvider = 'anthropic' | 'openrouter';

const VALID_AGENT_LLM_PROVIDERS: readonly AgentLlmProvider[] = ['anthropic', 'openrouter'];

export function getAgentLlmProvider(): AgentLlmProvider {
  const raw = (process.env.AGENT_LLM_PROVIDER ?? 'anthropic').trim().toLowerCase();
  return raw === 'openrouter' ? 'openrouter' : 'anthropic';
}

/** Startup-time validation — call once, alongside assertValidAgentModeEnv. */
export function assertValidAgentLlmProviderEnv(): void {
  const raw = process.env.AGENT_LLM_PROVIDER;
  if (raw == null) return;
  const normalized = raw.trim().toLowerCase();
  if ((VALID_AGENT_LLM_PROVIDERS as readonly string[]).includes(normalized)) return;
  throw new Error(
    `Invalid AGENT_LLM_PROVIDER "${raw}": expected one of ${VALID_AGENT_LLM_PROVIDERS.join(', ')} (or unset, which defaults to 'anthropic')`,
  );
}

export type AgentConfig = {
  mode: AgentMode;
  provider: AgentLlmProvider;
  model: string;
  apiKey: string | undefined;
  /** Hard ceiling on LLM round-trips per invocation — mirrors meridian-rs's AgentLoop::max_steps=20. */
  maxSteps: number;
  /**
   * Hard ceiling on CAPITAL-MOVING tool calls (deploy_position / close_position
   * / swap_token) per single invocation — independent of maxSteps, because a
   * step can be a harmless read (get_my_positions) or a real broadcast. This
   * is the one number an operator should lower to shrink blast radius without
   * also crippling the agent's ability to look around before acting.
   */
  maxActionsPerRun: number;
  /**
   * Whether the agent runs on its OWN schedule (mirrors meridian-rs's
   * management_interval_min/screening_interval_min) rather than only ever
   * being triggered on demand via /agent. Default OFF even when
   * AGENT_MODE=on — a periodic, fully automatic LLM-driven trading loop is
   * a materially bigger step up in autonomy than an operator manually
   * choosing to run it once, and deserves its own explicit opt-in rather
   * than riding in on AGENT_MODE=on.
   */
  autonomousSchedule: boolean;
  screeningIntervalMs: number;
  managementIntervalMs: number;
};

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadAgentConfig(): AgentConfig {
  const provider = getAgentLlmProvider();
  // Provider-specific defaults so an operator switching AGENT_LLM_PROVIDER
  // without also setting AGENT_MODEL doesn't end up passing an
  // Anthropic-only model id to OpenRouter (or vice versa). An explicit
  // AGENT_MODEL always wins for either provider.
  const defaultModel = provider === 'openrouter' ? 'openai/gpt-4o-mini' : 'claude-sonnet-4-6';
  return {
    mode: getAgentMode(),
    provider,
    model: process.env.AGENT_MODEL?.trim() || defaultModel,
    apiKey:
      (provider === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.ANTHROPIC_API_KEY)?.trim() ||
      undefined,
    maxSteps: Math.round(envNum('AGENT_MAX_STEPS', 20)),
    maxActionsPerRun: Math.round(envNum('AGENT_MAX_ACTIONS_PER_RUN', 3)),
    autonomousSchedule: (process.env.AGENT_AUTONOMOUS_SCHEDULE ?? 'off').trim().toLowerCase() === 'on',
    screeningIntervalMs: Math.round(envNum('AGENT_SCREENING_INTERVAL_MIN', 30) * 60_000),
    managementIntervalMs: Math.round(envNum('AGENT_MANAGEMENT_INTERVAL_MIN', 10) * 60_000),
  };
}
