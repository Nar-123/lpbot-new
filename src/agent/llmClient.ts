import Anthropic from '@anthropic-ai/sdk';
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
