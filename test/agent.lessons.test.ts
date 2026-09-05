import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-lessons-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { recordOpenPosition, recordLedger, getRecentLessons, __resetStoreForTests } = await import(
  '../src/db/index.js'
);
const { generateLessonForClose, formatLessonsForPrompt } = await import('../src/agent/lessons.js');
import type { LlmClient } from '../src/agent/llmClient.js';

const CHAIN = 4663;

function resetDb(): void {
  __resetStoreForTests();
  for (const suffix of ['', '.bak', '.tmp']) {
    try {
      fs.rmSync(`${process.env.DB_PATH!}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function textLlm(text: string): LlmClient {
  return { send: async () => ({ blocks: [{ type: 'text', text }], stopReason: 'end_turn' }) };
}

let tokenCounter = 7000;
function freshTokenId(): string {
  tokenCounter++;
  return String(tokenCounter);
}

function openMultiPosition(tokenId: string): void {
  recordOpenPosition({
    chainId: CHAIN,
    tokenId,
    poolAddress: '0xpool',
    token0: '0xusdg',
    token1: '0xtok',
    fee: 3000,
    tickLower: 0,
    tickUpper: 100,
    protocol: 'v3',
    dex: 'uniswap',
    strategy: 'multi',
    entrySignals: { marketCapUsd: 5_000_000, volume6hUsd: 100_000, ageHours: 48 },
  });
}

test.beforeEach(() => resetDb());

test('generates and persists a lesson from a real (mocked) LLM response', async () => {
  const tokenId = freshTokenId();
  openMultiPosition(tokenId);
  recordLedger({ chainId: CHAIN, tokenId, kind: 'deposit', usd: 100, tokenAddress: null, amountRaw: null, amountHuman: null, txHash: null });
  recordLedger({ chainId: CHAIN, tokenId, kind: 'withdrawal', usd: 130, tokenAddress: null, amountRaw: null, amountHuman: null, txHash: null });

  const lesson = await generateLessonForClose(CHAIN, tokenId, 'take_profit', {
    llm: textLlm('High volume6h at entry correlated with a clean take-profit exit.'),
  });

  assert.notEqual(lesson, null);
  assert.equal(lesson!.content, 'High volume6h at entry correlated with a clean take-profit exit.');
  assert.equal(lesson!.closeReason, 'take_profit');
  assert.equal(lesson!.realizedUsd, 30); // 130 withdrawal - 100 deposit
});

test('returns null (never throws) when no LLM client is available', async () => {
  const tokenId = freshTokenId();
  openMultiPosition(tokenId);
  const lesson = await generateLessonForClose(CHAIN, tokenId, 'stop_loss', { llm: null });
  assert.equal(lesson, null);
});

test('returns null for a position with no entry-signal snapshot (manual mint) — never fabricates one', async () => {
  const tokenId = freshTokenId();
  recordOpenPosition({
    chainId: CHAIN,
    tokenId,
    poolAddress: '0xpool',
    token0: '0xusdg',
    token1: '0xtok',
    fee: 3000,
    tickLower: 0,
    tickUpper: 100,
    protocol: 'v3',
    dex: 'uniswap',
    // no strategy, no entrySignals — a manual /add mint
  });
  const lesson = await generateLessonForClose(CHAIN, tokenId, 'stop_loss', {
    llm: textLlm('should never be reached'),
  });
  assert.equal(lesson, null);
});

test('returns null when the LLM call throws', async () => {
  const tokenId = freshTokenId();
  openMultiPosition(tokenId);
  const throwingLlm: LlmClient = {
    send: async () => {
      throw new Error('rate limited');
    },
  };
  const lesson = await generateLessonForClose(CHAIN, tokenId, 'stop_loss', { llm: throwingLlm });
  assert.equal(lesson, null);
});

test('returns null when the LLM responds with only whitespace/empty text', async () => {
  const tokenId = freshTokenId();
  openMultiPosition(tokenId);
  const lesson = await generateLessonForClose(CHAIN, tokenId, 'stop_loss', { llm: textLlm('   ') });
  assert.equal(lesson, null);
});

test('an oversized LLM response is capped, never stored unbounded', async () => {
  const tokenId = freshTokenId();
  openMultiPosition(tokenId);
  const huge = 'x'.repeat(10_000);
  const lesson = await generateLessonForClose(CHAIN, tokenId, 'stop_loss', { llm: textLlm(huge) });
  assert.notEqual(lesson, null);
  assert.ok(lesson!.content.length <= 400);
});

test('formatLessonsForPrompt returns empty string (never null) with no lessons yet', () => {
  assert.equal(formatLessonsForPrompt(CHAIN), '');
});

test('formatLessonsForPrompt includes recent lesson content, most recent first', async () => {
  const t1 = freshTokenId();
  const t2 = freshTokenId();
  openMultiPosition(t1);
  openMultiPosition(t2);
  await generateLessonForClose(CHAIN, t1, 'stop_loss', { llm: textLlm('First lesson.') });
  await generateLessonForClose(CHAIN, t2, 'take_profit', { llm: textLlm('Second lesson.') });

  const formatted = formatLessonsForPrompt(CHAIN);
  assert.match(formatted, /Second lesson\./);
  assert.match(formatted, /First lesson\./);
  assert.ok(formatted.indexOf('Second lesson.') < formatted.indexOf('First lesson.'), 'most recent should appear first');
});

test('getRecentLessons respects the chainId filter', async () => {
  const tokenId = freshTokenId();
  openMultiPosition(tokenId);
  await generateLessonForClose(CHAIN, tokenId, 'stop_loss', { llm: textLlm('Chain-specific lesson.') });
  const otherChainLessons = getRecentLessons(10, 8453 as never);
  assert.equal(otherChainLessons.length, 0);
});
