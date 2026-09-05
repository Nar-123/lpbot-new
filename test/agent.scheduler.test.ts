import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'grammy';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-agent-scheduler-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');
process.env.ANTHROPIC_API_KEY = 'test-key';

const {
  startAgentScheduler,
  stopAgentScheduler,
  __getSchedulerStateForTests,
  __runCycleForTests,
  __setSchedulerDepsForTests,
  __resetSchedulerForTests,
} = await import('../src/agent/scheduler.js');

const fakeBot = { api: { sendMessage: async () => {} } } as unknown as Bot;

function clearAgentEnv(): void {
  delete process.env.AGENT_MODE;
  delete process.env.AGENT_AUTONOMOUS_SCHEDULE;
  delete process.env.AGENT_SCREENING_INTERVAL_MIN;
  delete process.env.AGENT_MANAGEMENT_INTERVAL_MIN;
}

test.beforeEach(() => {
  clearAgentEnv();
  __resetSchedulerForTests();
});

test.after(() => {
  stopAgentScheduler();
  clearAgentEnv();
});

test('does not start (no timers) unless AGENT_MODE=on AND AGENT_AUTONOMOUS_SCHEDULE=on are both set', () => {
  startAgentScheduler(fakeBot);
  assert.equal(__getSchedulerStateForTests(), 'stopped', 'neither env var set');

  process.env.AGENT_MODE = 'on';
  startAgentScheduler(fakeBot);
  assert.equal(__getSchedulerStateForTests(), 'stopped', 'AGENT_MODE alone must not be enough');
  stopAgentScheduler();

  delete process.env.AGENT_MODE;
  process.env.AGENT_AUTONOMOUS_SCHEDULE = 'on';
  startAgentScheduler(fakeBot);
  assert.equal(__getSchedulerStateForTests(), 'stopped', 'AGENT_AUTONOMOUS_SCHEDULE alone must not be enough');
});

test('starts only when both AGENT_MODE=on and AGENT_AUTONOMOUS_SCHEDULE=on are set', () => {
  process.env.AGENT_MODE = 'on';
  process.env.AGENT_AUTONOMOUS_SCHEDULE = 'on';
  startAgentScheduler(fakeBot);
  assert.equal(__getSchedulerStateForTests(), 'running');
  stopAgentScheduler();
});

test('starting twice is idempotent (matches tpslWatcher.ts convention)', () => {
  process.env.AGENT_MODE = 'on';
  process.env.AGENT_AUTONOMOUS_SCHEDULE = 'on';
  startAgentScheduler(fakeBot);
  startAgentScheduler(fakeBot);
  assert.equal(__getSchedulerStateForTests(), 'running');
  stopAgentScheduler();
});

test('stopAgentScheduler is idempotent and always leaves state stopped', () => {
  process.env.AGENT_MODE = 'on';
  process.env.AGENT_AUTONOMOUS_SCHEDULE = 'on';
  startAgentScheduler(fakeBot);
  stopAgentScheduler();
  stopAgentScheduler();
  assert.equal(__getSchedulerStateForTests(), 'stopped');
});

test('a scheduled cycle actually invokes runAgent with the given role and reports the result', async () => {
  process.env.AGENT_MODE = 'on';
  let calledRole: string | null = null;
  __setSchedulerDepsForTests({
    runAgent: (async (role) => {
      calledRole = role;
      return {
        role,
        chainId: 4663,
        goal: 'test',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        steps: 0,
        toolCalls: [],
        finalText: 'nothing to do',
        stoppedReason: 'done',
      };
    }) as typeof import('../src/agent/loop.js').runAgent,
  });

  await __runCycleForTests(fakeBot, 'screener');
  assert.equal(calledRole, 'screener');
});

test('a cycle no-ops (never calls runAgent) when ANTHROPIC_API_KEY is not set', async () => {
  process.env.AGENT_MODE = 'on';
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  let called = false;
  __setSchedulerDepsForTests({
    runAgent: (async () => {
      called = true;
      throw new Error('should not be called');
    }) as typeof import('../src/agent/loop.js').runAgent,
  });
  try {
    await __runCycleForTests(fakeBot, 'manager');
    assert.equal(called, false);
  } finally {
    process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test('a cycle no-ops when AGENT_MODE is off, even if directly invoked', async () => {
  let called = false;
  __setSchedulerDepsForTests({
    runAgent: (async () => {
      called = true;
      throw new Error('should not be called');
    }) as typeof import('../src/agent/loop.js').runAgent,
  });
  await __runCycleForTests(fakeBot, 'screener');
  assert.equal(called, false);
});

test('overlapping cycles are prevented — a slow in-flight run blocks a second concurrent invocation', async () => {
  process.env.AGENT_MODE = 'on';
  let concurrentCalls = 0;
  let maxConcurrent = 0;
  __setSchedulerDepsForTests({
    runAgent: (async (role) => {
      concurrentCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      await new Promise((r) => setTimeout(r, 50));
      concurrentCalls--;
      return {
        role,
        chainId: 4663,
        goal: 'test',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        steps: 0,
        toolCalls: [],
        finalText: '',
        stoppedReason: 'done',
      };
    }) as typeof import('../src/agent/loop.js').runAgent,
  });

  await Promise.all([__runCycleForTests(fakeBot, 'screener'), __runCycleForTests(fakeBot, 'manager')]);
  assert.equal(maxConcurrent, 1, 'the inFlight guard must prevent two cycles running at once');
});

test('custom AGENT_SCREENING_INTERVAL_MIN/AGENT_MANAGEMENT_INTERVAL_MIN are honored without throwing', () => {
  process.env.AGENT_MODE = 'on';
  process.env.AGENT_AUTONOMOUS_SCHEDULE = 'on';
  process.env.AGENT_SCREENING_INTERVAL_MIN = '5';
  process.env.AGENT_MANAGEMENT_INTERVAL_MIN = '2';
  startAgentScheduler(fakeBot);
  assert.equal(__getSchedulerStateForTests(), 'running');
  stopAgentScheduler();
});
