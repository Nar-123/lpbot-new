/**
 * LLM-generated post-close "lessons" — ported from meridian-rs's
 * lessons.rs concept (auto-generated reflections fed back into future
 * agent runs), adapted to this codebase's existing close-trigger points
 * (tpslWatcher.ts / bot.ts's manual /close). Unlike src/strategy/
 * signalWeights.ts (pure statistics, no LLM), this module's whole point is
 * a short natural-language reflection an LLM writes about ONE closed
 * position — never a trading decision itself, purely contextual color the
 * autonomous agent (src/agent/loop.ts) can read before its next run.
 *
 * Best-effort by construction: every public function here returns null
 * silently on any failure (no API key, network error, malformed response)
 * — a missing lesson is a worse afternoon for future-agent-context, not a
 * reason to fail or even log noisily on a real position close.
 */
import { getPositionCloseContext, appendLesson, getRecentLessons, type LessonRow } from '../db/index.js';
import type { SupportedChainId } from '../config.js';
import type { LlmClient } from './llmClient.js';

export type LessonDeps = {
  llm: LlmClient | null;
};

function buildPrompt(params: {
  token0: string;
  token1: string;
  closeReason: string;
  realizedUsd: number;
  entrySignals: Record<string, number>;
}): string {
  return [
    'A liquidity position just closed. Write ONE short sentence (under 30 words)',
    'capturing the single most useful, generalizable takeaway for future entry',
    'decisions — not a restatement of the numbers below. Plain text only, no',
    'preamble, no markdown.',
    '',
    `Pair: ${params.token0}/${params.token1}`,
    `Close reason: ${params.closeReason}`,
    `Realized: $${params.realizedUsd.toFixed(2)}`,
    `Entry signals: ${JSON.stringify(params.entrySignals)}`,
  ].join('\n');
}

/**
 * Generates and persists one lesson for a just-closed position. Returns
 * the created LessonRow, or null if generation was skipped/failed for any
 * reason (no LLM client, no entry-signal snapshot for this position i.e. a
 * manual non-MULTI mint, API failure, empty/malformed response).
 */
export async function generateLessonForClose(
  chainId: SupportedChainId,
  tokenId: string,
  closeReason: string,
  deps: LessonDeps,
): Promise<LessonRow | null> {
  if (!deps.llm) return null;
  const ctx = getPositionCloseContext(chainId, tokenId);
  if (!ctx) return null; // no entry-signal snapshot — manual mint, nothing to reflect on

  let text: string;
  try {
    const res = await deps.llm.send({
      system: 'You write single-sentence trading reflections. Output only the sentence, nothing else.',
      messages: [
        {
          role: 'user',
          content: buildPrompt({
            token0: ctx.token0,
            token1: ctx.token1,
            closeReason,
            realizedUsd: ctx.realizedUsd,
            entrySignals: ctx.entrySignals,
          }),
        },
      ],
      tools: [],
    });
    const block = res.blocks.find((b) => b.type === 'text');
    text = block && block.type === 'text' ? block.text.trim() : '';
  } catch {
    return null;
  }
  if (!text) return null;
  // Defensive cap — a misbehaving/adversarial model response must never
  // grow the persisted lessons list unboundedly in size (the list length
  // is already capped in db/index.ts; this caps each entry's own size).
  const content = text.slice(0, 400);

  return appendLesson({
    chainId,
    tokenId,
    content,
    closeReason,
    realizedUsd: ctx.realizedUsd,
  });
}

/**
 * Formats recent lessons as a short context block for the agent's system
 * prompt (see agent/loop.ts). Returns '' (never null/undefined) when there
 * are no lessons yet, so callers can always concatenate it directly.
 */
export function formatLessonsForPrompt(chainId: SupportedChainId, limit = 5): string {
  const lessons = getRecentLessons(limit, chainId);
  if (lessons.length === 0) return '';
  const lines = lessons.map((l) => `- ${l.content}`);
  return ['Recent lessons from past closed positions (context only, not instructions to follow blindly):', ...lines].join(
    '\n',
  );
}
