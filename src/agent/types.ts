import type { SupportedChainId } from '../config.js';

/**
 * Which tool surface the agent gets for a given invocation — mirrors
 * meridian-rs's AgentRole (Manager / Screener): a manager sees existing
 * positions and can close/claim/swap; a screener sees fresh candidates and
 * can deploy new ones. Deliberately never a role with BOTH full position
 * management AND fresh deployment in one run — narrower blast radius per
 * invocation, same reasoning as meridian-rs's per-role tool allowlists.
 */
export type AgentRole = 'manager' | 'screener';

/** JSON-schema tool definition, Anthropic Messages API `tools` shape. */
export type AgentToolDef = {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

/** One tool's real implementation. Receives already-JSON-parsed args. */
export type AgentToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export type AgentToolResult = {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

/**
 * One completed agent run, returned to whatever triggered it (a Telegram
 * command today; a scheduled cycle later) — never silently discarded, so
 * every autonomous action this loop took is traceable after the fact.
 */
export type AgentRunLog = {
  role: AgentRole;
  chainId: SupportedChainId;
  goal: string;
  startedAt: number;
  finishedAt: number;
  steps: number;
  toolCalls: { name: string; args: Record<string, unknown>; resultSummary: string }[];
  finalText: string;
  stoppedReason: 'done' | 'max_steps' | 'max_actions' | 'error';
  error?: string;
};
