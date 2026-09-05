/**
 * agent/llmClient.ts — OpenRouter provider (Anthropic -> OpenRouter switch).
 *
 * agent/loop.ts, agent/tools.ts, and agent/lessons.ts are untouched by this
 * change — they only ever talk to the `LlmClient` interface (`send({system,
 * messages, tools}) => Promise<{blocks, stopReason}>`). This suite proves
 * `createOpenRouterClient` implements that exact interface correctly for
 * OpenRouter's OpenAI-compatible chat completions API:
 *   - the two-way translation between this codebase's Anthropic-shaped
 *     conversation history (LlmMessage[]) and OpenAI's messages/tools
 *     format (system prompt as a `role:"system"` message, not a separate
 *     field; tools as `{type:"function", function:{...}}`; tool results as
 *     `{role:"tool", tool_call_id, content}`);
 *   - `tool_calls[].function.arguments` (a JSON string per OpenRouter's own
 *     docs) is parsed into `LlmResponseBlock`'s `input` object, and a
 *     malformed one fails loudly, never silently as `{}`;
 *   - `createLlmClientFromConfig` picks the right provider from
 *     AgentConfig.provider, defaulting to Anthropic.
 *
 * `global.fetch` is mocked throughout — no live network access, no API key
 * needed. Request/response shapes were verified directly against
 * openrouter.ai/docs/guides/features/tool-calling and
 * openrouter.ai/docs/api-reference/overview before writing this suite (see
 * PHASE4_8-era commit for the verification), not assumed from memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenRouterClient,
  createLlmClientFromConfig,
  type LlmMessage,
} from '../src/agent/llmClient.js';
import type { AgentToolDef } from '../src/agent/types.js';
import type { AgentConfig } from '../src/agent/config.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

type CapturedCall = { url: string; init: RequestInit };

const originalFetch = globalThis.fetch;

function installFetchMock(handler: (call: CapturedCall) => Promise<Response> | Response): {
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = (async (input: any, init: any) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function baseAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    mode: 'on',
    provider: 'anthropic',
    model: 'test-model',
    apiKey: 'test-key',
    maxSteps: 20,
    maxActionsPerRun: 3,
    autonomousSchedule: false,
    screeningIntervalMs: 1_800_000,
    managementIntervalMs: 600_000,
    ...overrides,
  };
}

const sampleTools: AgentToolDef[] = [
  {
    name: 'get_my_positions',
    description: 'List open positions.',
    input_schema: { type: 'object', properties: {} },
  },
];

// ── Request translation: system prompt, messages, tools ────────────────────

test('createOpenRouterClient: sends the system prompt as a role:"system" message, not a separate field', async () => {
  const { calls } = installFetchMock(() =>
    jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
  );
  const client = createOpenRouterClient('key', 'openai/gpt-4o-mini');
  await client.send({ system: 'You are a helpful agent.', messages: [{ role: 'user', content: 'hello' }], tools: [] });

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0]!.init.body as string);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'You are a helpful agent.');
  assert.equal(body.messages[1].role, 'user');
  assert.equal(body.messages[1].content, 'hello');
});

test('createOpenRouterClient: hits the OpenRouter chat completions endpoint with Authorization/HTTP-Referer/X-Title headers', async () => {
  const { calls } = installFetchMock(() =>
    jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
  );
  const client = createOpenRouterClient('sk-or-abc123', 'openai/gpt-4o-mini');
  await client.send({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [] });

  assert.equal(calls[0]!.url, OPENROUTER_URL);
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers['Authorization'], 'Bearer sk-or-abc123');
  assert.ok(headers['HTTP-Referer'], 'HTTP-Referer header must be present per OpenRouter docs');
  assert.ok(headers['X-Title'], 'X-Title header must be present per OpenRouter docs');
});

test('createOpenRouterClient: translates AgentToolDef[] into OpenAI-compatible {type:"function", function:{name,description,parameters}} tools', async () => {
  const { calls } = installFetchMock(() =>
    jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
  );
  const client = createOpenRouterClient('key', 'openai/gpt-4o-mini');
  await client.send({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: sampleTools });

  const body = JSON.parse(calls[0]!.init.body as string);
  assert.deepEqual(body.tools, [
    {
      type: 'function',
      function: {
        name: 'get_my_positions',
        description: 'List open positions.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ]);
});

test('createOpenRouterClient: omits the "tools" field entirely when no tools are offered (matches agent/lessons.ts\'s tools:[] calls)', async () => {
  const { calls } = installFetchMock(() =>
    jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
  );
  const client = createOpenRouterClient('key', 'openai/gpt-4o-mini');
  await client.send({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [] });

  const body = JSON.parse(calls[0]!.init.body as string);
  assert.equal('tools' in body, false);
});

test('createOpenRouterClient: translates an assistant turn\'s Anthropic-shaped blocks (tool_use + text) into an OpenAI assistant message with tool_calls (arguments as a JSON string)', async () => {
  const { calls } = installFetchMock(() =>
    jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
  );
  const client = createOpenRouterClient('key', 'openai/gpt-4o-mini');

  // Exactly the shape agent/loop.ts pushes: messages.push({ role: 'assistant', content: res.blocks })
  const messages: LlmMessage[] = [
    { role: 'user', content: 'goal' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'call_1', name: 'get_my_positions', input: { chainId: 4663 } },
      ],
    },
  ];
  await client.send({ system: 'sys', messages, tools: sampleTools });

  const body = JSON.parse(calls[0]!.init.body as string);
  const assistantMsg = body.messages[2];
  assert.equal(assistantMsg.role, 'assistant');
  assert.equal(assistantMsg.content, 'Let me check.');
  assert.equal(assistantMsg.tool_calls.length, 1);
  assert.equal(assistantMsg.tool_calls[0].id, 'call_1');
  assert.equal(assistantMsg.tool_calls[0].type, 'function');
  assert.equal(assistantMsg.tool_calls[0].function.name, 'get_my_positions');
  assert.equal(
    typeof assistantMsg.tool_calls[0].function.arguments,
    'string',
    'arguments must be sent as a JSON string, not an object, per OpenAI/OpenRouter\'s contract',
  );
  assert.deepEqual(JSON.parse(assistantMsg.tool_calls[0].function.arguments), { chainId: 4663 });
});

test('createOpenRouterClient: translates an assistant tool_use-only turn (no text) to content:null, matching OpenAI\'s own documented shape', async () => {
  const { calls } = installFetchMock(() =>
    jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
  );
  const client = createOpenRouterClient('key', 'openai/gpt-4o-mini');
  const messages: LlmMessage[] = [
    { role: 'user', content: 'goal' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_my_positions', input: {} }] },
  ];
  await client.send({ system: 'sys', messages, tools: sampleTools });

  const body = JSON.parse(calls[0]!.init.body as string);
  assert.equal(body.messages[2].content, null);
});

test('createOpenRouterClient: translates a user turn\'s Anthropic tool_result block(s) into separate {role:"tool", tool_call_id, content} messages', async () => {
  const { calls } = installFetchMock(() =>
    jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
  );
  const client = createOpenRouterClient('key', 'openai/gpt-4o-mini');

  // Exactly the shape agent/loop.ts pushes: messages.push({ role: 'user', content: toolResults })
  const messages: LlmMessage[] = [
    { role: 'user', content: 'goal' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_my_positions', input: {} }] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"positions":[]}' }],
    },
  ];
  await client.send({ system: 'sys', messages, tools: sampleTools });

  const body = JSON.parse(calls[0]!.init.body as string);
  const toolMsg = body.messages[3];
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_1');
  assert.equal(toolMsg.content, '{"positions":[]}');
});

// ── Response translation ────────────────────────────────────────────────────

test('createOpenRouterClient: a text-only response becomes a single text block, stopReason from finish_reason', async () => {
  installFetchMock(() =>
    jsonResponse({ choices: [{ message: { content: 'All done.' }, finish_reason: 'stop' }] }),
  );
  const client = createOpenRouterClient('key', 'openai/gpt-4o-mini');
  const res = await client.send({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [] });

  assert.deepEqual(res.blocks, [{ type: 'text', text: 'All done.' }]);
  assert.equal(res.stopReason, 'stop');
});

test('createOpenRouterClient: a tool_calls response is parsed into tool_use blocks with `input` as a real object (not a string)', async () => {
  installFetchMock(() =>
    jsonResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_9',
                type: 'function',
                function: { name: 'get_my_positions', arguments: '{"chainId":4663,"limit":5}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  );
  const client = createOpenRouterClient('key', 'openai/gpt-4o-mini');
  const res = await client.send({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: sampleTools });

  assert.equal(res.blocks.length, 1);
  const block = res.blocks[0]!;
  assert.equal(block.type, 'tool_use');
  if (block.type === 'tool_use') {
    assert.equal(block.id, 'call_9');
    assert.equal(block.name, 'get_my_positions');
    assert.deepEqual(block.input, { chainId: 4663, limit: 5 }, 'input must be a parsed object, not the raw JSON string');
  }
  assert.equal(res.stopReason, 'tool_calls');
});

test('createOpenRouterClient: a response with BOTH text and tool_calls yields both a text block and a tool_use block', async () => {
  installFetchMock(() =>
    jsonResponse({
      choices: [
        {
          message: {
            content: 'Checking positions now.',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'get_my_positions', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  );
  const client = createOpenRouterClient('key', 'openai/gpt-4o-mini');
  const res = await client.send({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: sampleTools });

  assert.equal(res.blocks.length, 2);
  assert.equal(res.blocks[0]!.type, 'text');
  assert.equal(res.blocks[1]!.type, 'tool_use');
});

test('createOpenRouterClient: malformed JSON in tool_calls[].function.arguments throws a clear error, never silently becomes an empty object', async () => {
  installFetchMock(() =>
    jsonResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'call_bad', type: 'function', function: { name: 'deploy_position', arguments: '{not valid json' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  );
  const client = createOpenRouterClient('key', 'openai/gpt-4o-mini');

  await assert.rejects(
    () => client.send({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: sampleTools }),
    (err: Error) => {
      assert.match(err.message, /deploy_position/, 'error must name the offending tool call');
      assert.match(err.message, /invalid JSON/i);
      return true;
    },
  );
});

test('createOpenRouterClient: a non-OK HTTP response throws a clear error including the status code', async () => {
  installFetchMock(() => new Response('invalid api key', { status: 401, statusText: 'Unauthorized' }));
  const client = createOpenRouterClient('bad-key', 'openai/gpt-4o-mini');

  await assert.rejects(
    () => client.send({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [] }),
    /401/,
  );
});

// ── createLlmClientFromConfig: provider selection ───────────────────────────

test('createLlmClientFromConfig: provider="anthropic" (default) constructs a client that calls api.anthropic.com, never openrouter.ai', async () => {
  const { calls } = installFetchMock(() =>
    jsonResponse({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }),
  );
  const client = createLlmClientFromConfig(baseAgentConfig({ provider: 'anthropic', apiKey: 'ant-key' }));
  await client.send({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [] });

  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.url.includes('api.anthropic.com'), `expected an api.anthropic.com URL, got ${calls[0]!.url}`);
});

test('createLlmClientFromConfig: provider="openrouter" constructs a client that calls openrouter.ai, never api.anthropic.com', async () => {
  const { calls } = installFetchMock(() =>
    jsonResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }),
  );
  const client = createLlmClientFromConfig(baseAgentConfig({ provider: 'openrouter', apiKey: 'or-key' }));
  await client.send({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [] });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, OPENROUTER_URL);
});

test('createLlmClientFromConfig: throws a clear, provider-specific error when apiKey is missing, for either provider', () => {
  assert.throws(
    () => createLlmClientFromConfig(baseAgentConfig({ provider: 'anthropic', apiKey: undefined })),
    /ANTHROPIC_API_KEY is not set/,
  );
  assert.throws(
    () => createLlmClientFromConfig(baseAgentConfig({ provider: 'openrouter', apiKey: undefined })),
    /OPENROUTER_API_KEY is not set/,
  );
});
