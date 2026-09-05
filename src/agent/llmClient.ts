import Anthropic from '@anthropic-ai/sdk';
import type { AgentConfig } from './config.js';
import type { AgentToolDef } from './types.js';

export type LlmMessage =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'user' | 'assistant'; content: unknown[] };

export type LlmToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type LlmTextBlock = { type: 'text'; text: string };
export type LlmResponseBlock = LlmToolUseBlock | LlmTextBlock;

export type LlmResponse = {
  blocks: LlmResponseBlock[];
  stopReason: string | null;
};

/**
 * Real Anthropic-backed client. Injectable interface (see AgentLoop's
 * `llm` param) so the ReAct loop itself never needs a live API key or
 * network access under test — mirrors every other external dependency in
 * this codebase (mintFn, poolFetcher, fetcher, ...).
 */
export type LlmClient = {
  send(params: {
    system: string;
    messages: LlmMessage[];
    tools: AgentToolDef[];
  }): Promise<LlmResponse>;
};

export function createAnthropicClient(apiKey: string, model: string): LlmClient {
  const client = new Anthropic({ apiKey });
  return {
    async send({ system, messages, tools }) {
      const res = await client.messages.create({
        model,
        max_tokens: 2048,
        system,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: messages as any,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        })),
      });
      const blocks: LlmResponseBlock[] = res.content.map((block) => {
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          };
        }
        if (block.type === 'text') {
          return { type: 'text', text: block.text };
        }
        return { type: 'text', text: '' };
      });
      return { blocks, stopReason: res.stop_reason };
    },
  };
}

// ── OpenRouter (OpenAI-compatible chat completions) client ─────────────────

type OpenAiToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type OpenAiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

type OpenAiToolDef = {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
};

type OpenAiChatCompletionResponse = {
  choices?: {
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason?: string | null;
  }[];
};

/** Anthropic-shaped tool_result block — the only array-content shape agent/loop.ts ever puts on a 'user' LlmMessage. */
type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

/**
 * Translates this codebase's Anthropic-shaped conversation history
 * (LlmMessage[], built by agent/loop.ts — untouched by this file) into
 * OpenAI-compatible chat messages. loop.ts only ever produces two
 * array-content shapes: an assistant turn's own LlmResponseBlock[]
 * (tool_use/text, exactly what createAnthropicClient's `send` returned),
 * and a user turn's tool_result[] (one entry per tool call answered) — both
 * handled here so createAnthropicClient itself needed no changes at all.
 */
function toOpenAiMessages(system: string, messages: LlmMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: OpenAiToolCall[] = [];
      for (const raw of m.content) {
        const b = raw as LlmResponseBlock;
        if (b.type === 'text') {
          textParts.push(b.text);
        } else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      out.push({
        role: 'assistant',
        content: textParts.length ? textParts.join('\n') : null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      for (const raw of m.content) {
        const b = raw as AnthropicToolResultBlock;
        if (b.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
        }
      }
    }
  }
  return out;
}

function toOpenAiTools(tools: AgentToolDef[]): OpenAiToolDef[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/**
 * Translates an OpenAI-compatible chat completion response back into this
 * codebase's LlmResponse shape. Per OpenRouter's own tool-calling docs
 * (openrouter.ai/docs/guides/features/tool-calling),
 * `tool_calls[].function.arguments` arrives as a JSON *string*, never an
 * object — a malformed one throws a clear error here rather than silently
 * becoming `{}`, matching this codebase's fail-closed convention for
 * schema/shape validation (e.g. gmgn/cli.ts's parseTrendingResponse).
 */
function fromOpenAiResponse(json: OpenAiChatCompletionResponse): LlmResponse {
  const choice = json.choices?.[0];
  const message = choice?.message;
  const blocks: LlmResponseBlock[] = [];
  if (message?.content) {
    blocks.push({ type: 'text', text: message.content });
  }
  for (const call of message?.tool_calls ?? []) {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(call.function.arguments) as Record<string, unknown>;
    } catch {
      throw new Error(
        `OpenRouter tool call "${call.function.name}" (id ${call.id}) returned invalid JSON arguments: ${call.function.arguments.slice(0, 300)}`,
      );
    }
    blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
  }
  return { blocks, stopReason: choice?.finish_reason ?? null };
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * OpenRouter-backed client (OpenAI-compatible chat completions API),
 * implementing the exact same LlmClient interface as createAnthropicClient
 * — agent/loop.ts, agent/tools.ts, and agent/lessons.ts never know or care
 * which provider is behind it. Uses plain `fetch` (Node 20+ built-in) — no
 * new dependency added. Request/response shapes verified directly against
 * openrouter.ai/docs/guides/features/tool-calling and
 * openrouter.ai/docs/api-reference/overview (not assumed from memory).
 */
export function createOpenRouterClient(apiKey: string, model: string): LlmClient {
  return {
    async send({ system, messages, tools }) {
      const body: { model: string; messages: OpenAiMessage[]; tools?: OpenAiToolDef[] } = {
        model,
        messages: toOpenAiMessages(system, messages),
      };
      if (tools.length > 0) {
        body.tools = toOpenAiTools(tools);
      }

      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          // Recommended attribution headers (openrouter.ai/docs/api-reference/overview).
          'HTTP-Referer': 'https://github.com/Nar-123/lpbot-new',
          'X-Title': 'LP Uniswap Bot Agent',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`OpenRouter request failed: HTTP ${res.status} ${res.statusText} — ${text.slice(0, 300)}`);
      }

      const json = (await res.json()) as OpenAiChatCompletionResponse;
      return fromOpenAiResponse(json);
    },
  };
}

/**
 * Single construction point for every call site (previously each one
 * hardcoded createAnthropicClient directly). Selects the provider per
 * agentConfig.provider — default ('anthropic', the value loadAgentConfig()
 * returns when AGENT_LLM_PROVIDER is unset) produces byte-for-byte the same
 * client construction as before this function existed. Fails closed with a
 * clear, provider-specific message if the required API key is missing,
 * rather than passing `undefined` into the underlying SDK/fetch call.
 */
export function createLlmClientFromConfig(agentConfig: AgentConfig): LlmClient {
  if (!agentConfig.apiKey) {
    throw new Error(
      agentConfig.provider === 'openrouter' ? 'OPENROUTER_API_KEY is not set' : 'ANTHROPIC_API_KEY is not set',
    );
  }
  return agentConfig.provider === 'openrouter'
    ? createOpenRouterClient(agentConfig.apiKey, agentConfig.model)
    : createAnthropicClient(agentConfig.apiKey, agentConfig.model);
}
