/**
 * multiScheduler.ts's runOneCycle() must read the OPERATOR'S actual saved
 * prefs (getUserPrefs(firstUserId), firstUserId from
 * config.allowedUserIds — TELEGRAM_USER_IDS) rather than DEFAULT_PREFS.
 *
 * Separate file (not appended to strategy.multiScheduler.test.ts): src/config.ts
 * caches its resolved AppConfig on first access (`if (_config) return _config;`,
 * no test reset hook), so TELEGRAM_USER_IDS must be set to a value distinct
 * from every other test file BEFORE anything in this process ever reads
 * config.allowedUserIds — proving the scheduler genuinely reads "the first
 * configured user" dynamically, not a hardcoded/assumed id (e.g. '1', used
 * by every other multiScheduler test file).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'grammy';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-multi-scheduler-opprefs-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '777123'; // deliberately distinct from '1' used elsewhere
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');
process.env.STRATEGY = 'multi';

const { __runCycleForTests, __setSchedulerDepsForTests, __resetSchedulerForTests } =
  await import('../src/strategy/multiScheduler.js');
const { __resetMultiCooldownForTests } = await import('../src/strategy/multiRisk.js');
const { setUserPrefs } = await import('../src/db/index.js');

const fakeBot = { api: { sendMessage: async () => {} } } as unknown as Bot;

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
  __resetSchedulerForTests();
  __resetMultiCooldownForTests();
});

test('the scheduler uses the FIRST id from config.allowedUserIds (TELEGRAM_USER_IDS) dynamically, not a hardcoded/assumed id', async () => {
  // A distinctive balancePercent that could not coincidentally match
  // DEFAULT_PREFS (50) or the value used by user '1' in the sibling test file (35).
  setUserPrefs(777123, { sizeMode: 'percent', balancePercent: 22 });

  let receivedPrefs: { balancePercent?: number } | undefined;
  __setSchedulerDepsForTests({
    runMultiStrategy: (async (_config, opts) => {
      receivedPrefs = opts?.prefs;
      return fakeRun();
    }) as typeof import('../src/strategy/multiExecute.js').runMultiStrategy,
  });

  await __runCycleForTests(fakeBot);

  assert.ok(receivedPrefs, 'runMultiStrategy must receive opts.prefs');
  assert.equal(
    receivedPrefs!.balancePercent,
    22,
    'must resolve to TELEGRAM_USER_IDS=777123\'s actual saved prefs, proving the user id is read from config.allowedUserIds rather than assumed',
  );
});
