/**
 * strategy/multiScheduler.ts — periodic autonomous runner for the
 * deterministic MULTI strategy (no LLM). Mirrors test/agent.scheduler.test.ts
 * structure closely, since multiScheduler.ts mirrors agent/scheduler.ts's
 * own lifecycle/DI/inFlight-guard pattern — adapted for MULTI's own gates
 * (STRATEGY=multi + MULTI_AUTONOMOUS_SCHEDULE=on, instead of AGENT_MODE +
 * AGENT_AUTONOMOUS_SCHEDULE) and single screening-only cycle (no
 * screener/manager role split — runMultiStrategy does discovery+execution
 * together).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'grammy';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-multi-scheduler-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const {
  startMultiScheduler,
  stopMultiScheduler,
  __getSchedulerStateForTests,
  __runCycleForTests,
  __setSchedulerDepsForTests,
  __resetSchedulerForTests,
} = await import('../src/strategy/multiScheduler.js');
const { __resetMultiCooldownForTests } = await import('../src/strategy/multiRisk.js');
const { setUserPrefs } = await import('../src/db/index.js');

const fakeBot = { api: { sendMessage: async () => {} } } as unknown as Bot;

function clearMultiSchedulerEnv(): void {
  delete process.env.STRATEGY;
  delete process.env.MULTI_AUTONOMOUS_SCHEDULE;
  delete process.env.MULTI_SCREENING_INTERVAL_MIN;
}

function fakeRun(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 4663,
    dryRun: false,
    timestamp: Date.now(),
    candidates: [],
    rejected: [],
    intents: [],
    executed: [],
    ...overrides,
  };
}

test.beforeEach(() => {
  clearMultiSchedulerEnv();
  __resetSchedulerForTests();
  __resetMultiCooldownForTests();
});

test.after(() => {
  stopMultiScheduler();
  clearMultiSchedulerEnv();
});

test('does not start (no timer) unless STRATEGY=multi AND MULTI_AUTONOMOUS_SCHEDULE=on are both set', () => {
  startMultiScheduler(fakeBot);
  assert.equal(__getSchedulerStateForTests(), 'stopped', 'neither set');

  process.env.STRATEGY = 'multi';
  startMultiScheduler(fakeBot);
  assert.equal(__getSchedulerStateForTests(), 'stopped', 'STRATEGY=multi alone must not be enough');
  stopMultiScheduler();

  delete process.env.STRATEGY;
  process.env.MULTI_AUTONOMOUS_SCHEDULE = 'on';
  startMultiScheduler(fakeBot);
  assert.equal(__getSchedulerStateForTests(), 'stopped', 'MULTI_AUTONOMOUS_SCHEDULE alone must not be enough');
});

test('starts only when both STRATEGY=multi and MULTI_AUTONOMOUS_SCHEDULE=on are set', () => {
  process.env.STRATEGY = 'multi';
  process.env.MULTI_AUTONOMOUS_SCHEDULE = 'on';
  startMultiScheduler(fakeBot);
  assert.equal(__getSchedulerStateForTests(), 'running');
  stopMultiScheduler();
});

test('starting twice is idempotent (matches tpslWatcher.ts/agent.scheduler.ts convention)', () => {
  process.env.STRATEGY = 'multi';
  process.env.MULTI_AUTONOMOUS_SCHEDULE = 'on';
  startMultiScheduler(fakeBot);
  startMultiScheduler(fakeBot);
  assert.equal(__getSchedulerStateForTests(), 'running');
  stopMultiScheduler();
});

test('stopMultiScheduler is idempotent and always leaves state stopped', () => {
  process.env.STRATEGY = 'multi';
  process.env.MULTI_AUTONOMOUS_SCHEDULE = 'on';
  startMultiScheduler(fakeBot);
  stopMultiScheduler();
  stopMultiScheduler();
  assert.equal(__getSchedulerStateForTests(), 'stopped');
});

test('a scheduled cycle actually invokes runMultiStrategy with dryRun:false', async () => {
  process.env.STRATEGY = 'multi';
  let calledWithDryRun: unknown;
  __setSchedulerDepsForTests({
    runMultiStrategy: (async (_config, opts) => {
      calledWithDryRun = opts?.dryRun;
      return fakeRun();
    }) as typeof import('../src/strategy/multiExecute.js').runMultiStrategy,
  });

  await __runCycleForTests(fakeBot);
  assert.equal(calledWithDryRun, false, 'the scheduler must run for real (dryRun:false), never a silent dry-run');
});

test('a cycle no-ops (never calls runMultiStrategy) when STRATEGY is not multi, even if directly invoked', async () => {
  let called = false;
  __setSchedulerDepsForTests({
    runMultiStrategy: (async () => {
      called = true;
      throw new Error('should not be called');
    }) as typeof import('../src/strategy/multiExecute.js').runMultiStrategy,
  });
  await __runCycleForTests(fakeBot);
  assert.equal(called, false);
});

test('overlapping cycles are prevented — a slow in-flight run blocks a second concurrent invocation', async () => {
  process.env.STRATEGY = 'multi';
  let concurrentCalls = 0;
  let maxConcurrent = 0;
  __setSchedulerDepsForTests({
    runMultiStrategy: (async (config) => {
      concurrentCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      await new Promise((r) => setTimeout(r, 50));
      concurrentCalls--;
      return fakeRun({ chainId: config.chainId });
    }) as typeof import('../src/strategy/multiExecute.js').runMultiStrategy,
  });

  await Promise.all([__runCycleForTests(fakeBot), __runCycleForTests(fakeBot)]);
  assert.equal(maxConcurrent, 1, 'the inFlight guard must prevent two cycles running at once');
});

test('custom MULTI_SCREENING_INTERVAL_MIN is honored without throwing', () => {
  process.env.STRATEGY = 'multi';
  process.env.MULTI_AUTONOMOUS_SCHEDULE = 'on';
  process.env.MULTI_SCREENING_INTERVAL_MIN = '5';
  startMultiScheduler(fakeBot);
  assert.equal(__getSchedulerStateForTests(), 'running');
  stopMultiScheduler();
});

test('a cycle with executed positions notifies allowed users; an empty cycle (no executions) does not', async () => {
  process.env.STRATEGY = 'multi';
  let notifyCount = 0;
  const notifyingBot = {
    api: {
      sendMessage: async () => {
        notifyCount++;
      },
    },
  } as unknown as Bot;

  __setSchedulerDepsForTests({
    runMultiStrategy: (async () => fakeRun()) as typeof import('../src/strategy/multiExecute.js').runMultiStrategy,
  });
  await __runCycleForTests(notifyingBot);
  assert.equal(notifyCount, 0, 'an empty/no-op cycle must never notify — would spam every interval otherwise');

  __setSchedulerDepsForTests({
    runMultiStrategy: (async () =>
      fakeRun({
        executed: [{ tokenId: '123', txHash: '0xabc', intent: { token: '0xtoken' } }],
      })) as typeof import('../src/strategy/multiExecute.js').runMultiStrategy,
  });
  await __runCycleForTests(notifyingBot);
  assert.equal(notifyCount, 1, 'a cycle that actually opened a position must notify allowed users');
});

test('a candidate-source failure (sourceError) is logged AND notified — never silently indistinguishable from "0 candidates today"', async () => {
  process.env.STRATEGY = 'multi';
  let notifyCount = 0;
  let lastMessage = '';
  const notifyingBot = {
    api: {
      sendMessage: async (_uid: number, text: string) => {
        notifyCount++;
        lastMessage = text;
      },
    },
  } as unknown as Bot;

  __setSchedulerDepsForTests({
    runMultiStrategy: (async () =>
      fakeRun({
        sourceError: { code: 'GMGN_CLI_RATE_LIMITED', message: 'gmgn-cli rate limited (market trending)' },
      })) as typeof import('../src/strategy/multiExecute.js').runMultiStrategy,
  });

  const originalConsoleError = console.error;
  let loggedError: unknown[] | null = null;
  console.error = (...args: unknown[]) => {
    loggedError = args;
  };
  try {
    await __runCycleForTests(notifyingBot);
  } finally {
    console.error = originalConsoleError;
  }

  assert.notEqual(loggedError, null, 'a sourceError must be logged to the console, not swallowed silently');
  assert.equal(notifyCount, 1, 'a sourceError must notify allowed users — silence here is indistinguishable from a genuinely quiet market');
  assert.match(lastMessage, /gmgn-cli rate limited \(market trending\)/, 'the notification must surface the actual sourceError reason');
});

test('a scheduled cycle passes the operator\'s ACTUAL saved balancePercent (35) to runMultiStrategy, never DEFAULT_PREFS\'s 50', async () => {
  process.env.STRATEGY = 'multi';
  // TELEGRAM_USER_IDS is '1' for this whole file — set that user's real
  // saved preference to something that must NEVER be confused with
  // DEFAULT_PREFS.balancePercent (50, db/index.ts).
  setUserPrefs(1, { sizeMode: 'percent', balancePercent: 35 });

  let receivedPrefs: { balancePercent?: number; sizeMode?: string } | undefined;
  __setSchedulerDepsForTests({
    runMultiStrategy: (async (_config, opts) => {
      receivedPrefs = opts?.prefs;
      return fakeRun();
    }) as typeof import('../src/strategy/multiExecute.js').runMultiStrategy,
  });

  await __runCycleForTests(fakeBot);

  assert.ok(receivedPrefs, 'runMultiStrategy must be called with an opts.prefs, not left unset');
  assert.equal(
    receivedPrefs!.balancePercent,
    35,
    'the scheduler must use the operator\'s actual saved /settings value, not silently fall back to DEFAULT_PREFS (50)',
  );
});
