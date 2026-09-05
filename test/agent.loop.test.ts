/**
 * Agent loop tests — the ReAct loop itself (src/agent/loop.ts), with a
 * mocked LlmClient (no network/API key) and mocked tool deps (no live
 * RPC). Proves: it stops when the model stops asking for tools, respects
 * maxSteps, enforces the capital-moving action budget independently of
 * maxSteps, logs every tool call regardless of outcome, and never crashes
 * the run when a tool handler throws.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-agent-loop-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { runAgent } = await import('../src/agent/loop.js');
const { loadAgentConfig } = await import('../src/agent/config.js');
import type { LlmClient, LlmResponse } from '../src/agent/llmClient.js';
import type { ToolDeps } from '../src/agent/tools.js';

const CHAIN = 4663;

function baseConfig(overrides: Partial<ReturnType<typeof loadAgentConfig>> = {}) {
  return { ...loadAgentConfig(), mode: 'on' as const, maxSteps: 5, maxActionsPerRun: 3, ...overrides };
}

/** A scripted LlmClient: returns each entry in `script` in order, one per `send()` call. */
function scriptedLlm(script: LlmResponse[]): LlmClient {
  let i = 0;
  return {
    async send() {
      const res = script[Math.min(i, script.length - 1)];
      i++;
      return res;
    },
  };
}

function textOnly(text: string): LlmResponse {
  return { blocks: [{ type: 'text', text }], stopReason: 'end_turn' };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): LlmResponse {
  return { blocks: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use' };
}

const noopToolDeps: ToolDeps = {
  fetchCandidates: async () => ({ candidates: [] }),
  evaluateCandidate: async () => ({ outcome: 'rejected', rejected: { rejectedReason: 'TEST' } }) as any,
  doClosePosition: async () => {
    throw new Error('should not be called in this test');
  },
};

test('stops immediately when the model replies with text and no tool_use', async () => {
  const llm = scriptedLlm([textOnly('Nothing to do right now.')]);
  const log = await runAgent('manager', CHAIN, 'check on positions', {
    llm,
    config: baseConfig(),
    toolDeps: noopToolDeps,
  });
  assert.equal(log.stoppedReason, 'done');
  assert.equal(log.steps, 0);
  assert.equal(log.finalText, 'Nothing to do right now.');
});

test('executes a tool call, feeds the result back, and logs it', async () => {
  let sawSecondCallWithToolResult = false;
  const llm: LlmClient = {
    async send({ messages }) {
      if (messages.length === 1) {
        return toolUse('t1', 'get_my_positions', { chainId: CHAIN });
      }
      sawSecondCallWithToolResult = messages.some(
        (m) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result'),
      );
      return textOnly('Reviewed positions, nothing to close.');
    },
  };
  const deps: ToolDeps = {
    ...noopToolDeps,
  };
  const log = await runAgent('manager', CHAIN, 'review positions', {
    llm,
    config: baseConfig(),
    toolDeps: deps,
  });
  assert.equal(sawSecondCallWithToolResult, true);
  assert.equal(log.steps, 1);
  assert.equal(log.toolCalls[0].name, 'get_my_positions');
  assert.equal(log.stoppedReason, 'done');
});

test('respects maxSteps — a model that never stops asking for tools is cut off, not left to run forever', async () => {
  const llm: LlmClient = {
    async send() {
      return toolUse(`t-${Math.random()}`, 'get_wallet_balance', { chainId: CHAIN });
    },
  };
  const log = await runAgent('manager', CHAIN, 'loop forever', {
    llm,
    config: baseConfig({ maxSteps: 4, maxActionsPerRun: 100 }),
    toolDeps: noopToolDeps,
  });
  assert.equal(log.stoppedReason, 'max_steps');
  assert.equal(log.steps, 4);
});

test('enforces the capital-moving action budget independently of maxSteps — refuses further deploy/close once exhausted', async () => {
  let deployCalls = 0;
  const deps: ToolDeps = {
    ...noopToolDeps,
    fetchCandidates: async () => ({
      candidates: [
        {
          address: '0x1111111111111111111111111111111111111111',
          symbol: 'X',
          name: 'X',
          chainId: CHAIN,
          marketCapUsd: 5_000_000,
          ageHours: 48,
          volumeUsd: 100_000,
          liquidityUsd: 50_000,
          classification: 'MEME',
          launchpadPlatform: 'pump',
          candidateScore: 1,
          reasons: [],
          source: 'gmgn_trending_6h',
          sourceTimestamp: Date.now(),
        },
      ],
    }),
    evaluateCandidate: async () => {
      deployCalls++;
      return { outcome: 'executed', intent: {} as any, tokenId: `tok-${deployCalls}`, txHash: `0xhash${deployCalls}` };
    },
  };
  const llm: LlmClient = {
    async send() {
      return toolUse(`t-${Math.random()}`, 'deploy_position', {
        chainId: CHAIN,
        tokenAddress: '0x1111111111111111111111111111111111111111',
      });
    },
  };
  const log = await runAgent('screener', CHAIN, 'deploy repeatedly', {
    llm,
    config: baseConfig({ maxSteps: 10, maxActionsPerRun: 2 }),
    toolDeps: deps,
  });
  // Exactly 2 deploys actually executed (the budget), even though maxSteps=10
  // would otherwise allow far more tool-call round-trips.
  assert.equal(deployCalls, 2);
  assert.equal(log.stoppedReason, 'max_actions');
});

test('a tool handler throwing is reported back to the model as an error result, never crashes the run', async () => {
  const deps: ToolDeps = {
    ...noopToolDeps,
    doClosePosition: async () => {
      throw new Error('rpc exploded');
    },
  };
  let sawErrorToolResult = false;
  const llm: LlmClient = {
    async send({ messages }) {
      if (messages.length === 1) {
        return toolUse('t1', 'close_position', {
          chainId: CHAIN,
          tokenId: '123',
          protocol: 'v3',
          reason: 'testing',
        });
      }
      // close_position's own try/catch means the tool result is a normal
      // {closed:false, reason:...} payload, not a thrown handler — assert
      // the loop survives regardless of which shape produced it.
      sawErrorToolResult = messages.some(
        (m) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result'),
      );
      return textOnly('Close failed, will retry later.');
    },
  };
  const log = await runAgent('manager', CHAIN, 'close a stuck position', {
    llm,
    config: baseConfig(),
    toolDeps: deps,
  });
  assert.equal(sawErrorToolResult, true);
  assert.equal(log.stoppedReason, 'done');
  assert.match(log.toolCalls[0].resultSummary, /rpc exploded/);
});

test('an unknown tool name from the model is reported as an error result, not a crash', async () => {
  const llm: LlmClient = {
    async send({ messages }) {
      if (messages.length === 1) {
        return toolUse('t1', 'delete_wallet', {});
      }
      return textOnly('ok');
    },
  };
  const log = await runAgent('manager', CHAIN, 'test unknown tool', {
    llm,
    config: baseConfig(),
    toolDeps: noopToolDeps,
  });
  assert.equal(log.stoppedReason, 'done');
  assert.match(log.toolCalls[0].resultSummary, /unknown tool/);
});

test('AgentRunLog always records role, chainId, and goal for auditability', async () => {
  const log = await runAgent('screener', CHAIN, 'find a candidate', {
    llm: scriptedLlm([textOnly('no candidates today')]),
    config: baseConfig(),
    toolDeps: noopToolDeps,
  });
  assert.equal(log.role, 'screener');
  assert.equal(log.chainId, CHAIN);
  assert.equal(log.goal, 'find a candidate');
  assert.ok(log.startedAt <= log.finishedAt);
});

test('recent lessons are included in the system prompt sent to the LLM', async () => {
  const { appendLesson } = await import('../src/db/index.js');
  appendLesson({
    chainId: CHAIN,
    tokenId: 'lesson-test-1',
    content: 'Low-volume entries tend to stall out of range quickly.',
    closeReason: 'out_of_range',
    realizedUsd: -5,
  });

  let capturedSystem = '';
  const llm: LlmClient = {
    async send({ system }) {
      capturedSystem = system;
      return textOnly('no action needed');
    },
  };
  await runAgent('screener', CHAIN, 'evaluate the market', {
    llm,
    config: baseConfig(),
    toolDeps: noopToolDeps,
  });
  assert.match(capturedSystem, /Low-volume entries tend to stall out of range quickly\./);
  assert.match(capturedSystem, /never commands/);
});
