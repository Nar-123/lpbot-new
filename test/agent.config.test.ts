/**
 * agent/config.ts — AGENT_LLM_PROVIDER selection (Anthropic -> OpenRouter
 * provider switch).
 *
 * Root requirement: the new provider option must be fully opt-in — leaving
 * AGENT_LLM_PROVIDER unset must produce byte-for-byte the same AgentConfig
 * as before this option existed (provider:'anthropic', same default model,
 * apiKey still sourced from ANTHROPIC_API_KEY). A present-but-unrecognized
 * value must fail closed (throw), mirroring AGENT_MODE/STRATEGY/
 * TRADING_MODE's own validators elsewhere in this codebase — never silently
 * absorbed into the default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAgentLlmProvider,
  assertValidAgentLlmProviderEnv,
  loadAgentConfig,
} from '../src/agent/config.js';

function clearEnv(): void {
  delete process.env.AGENT_LLM_PROVIDER;
  delete process.env.AGENT_MODEL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
}

test.beforeEach(clearEnv);
test.after(clearEnv);

test('getAgentLlmProvider: defaults to "anthropic" when AGENT_LLM_PROVIDER is unset', () => {
  assert.equal(getAgentLlmProvider(), 'anthropic');
});

test('getAgentLlmProvider: "openrouter" (any case/whitespace) selects openrouter', () => {
  process.env.AGENT_LLM_PROVIDER = '  OpenRouter  ';
  assert.equal(getAgentLlmProvider(), 'openrouter');
});

test('getAgentLlmProvider: an unrecognized value falls back to "anthropic" (assertValidAgentLlmProviderEnv is the fail-closed gate, not this live getter)', () => {
  process.env.AGENT_LLM_PROVIDER = 'totally-bogus';
  assert.equal(getAgentLlmProvider(), 'anthropic');
});

test('assertValidAgentLlmProviderEnv: unset does not throw', () => {
  assert.doesNotThrow(() => assertValidAgentLlmProviderEnv());
});

test('assertValidAgentLlmProviderEnv: "anthropic" and "openrouter" do not throw', () => {
  process.env.AGENT_LLM_PROVIDER = 'anthropic';
  assert.doesNotThrow(() => assertValidAgentLlmProviderEnv());
  process.env.AGENT_LLM_PROVIDER = 'openrouter';
  assert.doesNotThrow(() => assertValidAgentLlmProviderEnv());
});

test('assertValidAgentLlmProviderEnv: a typo\'d/unrecognized value fails closed (throws), never silently absorbed', () => {
  process.env.AGENT_LLM_PROVIDER = 'openai';
  assert.throws(() => assertValidAgentLlmProviderEnv(), /Invalid AGENT_LLM_PROVIDER "openai"/);
});

test('loadAgentConfig: default (unset AGENT_LLM_PROVIDER) is byte-for-byte the pre-existing Anthropic behavior', () => {
  process.env.ANTHROPIC_API_KEY = 'ant-key-123';
  const cfg = loadAgentConfig();
  assert.equal(cfg.provider, 'anthropic');
  assert.equal(cfg.model, 'claude-sonnet-4-6', 'default model must be unchanged for the default provider');
  assert.equal(cfg.apiKey, 'ant-key-123', 'apiKey must still come from ANTHROPIC_API_KEY by default');
});

test('loadAgentConfig: provider=openrouter sources apiKey from OPENROUTER_API_KEY, not ANTHROPIC_API_KEY', () => {
  process.env.AGENT_LLM_PROVIDER = 'openrouter';
  process.env.ANTHROPIC_API_KEY = 'ant-key-should-be-ignored';
  process.env.OPENROUTER_API_KEY = 'or-key-456';
  const cfg = loadAgentConfig();
  assert.equal(cfg.provider, 'openrouter');
  assert.equal(cfg.apiKey, 'or-key-456');
});

test('loadAgentConfig: provider=openrouter with no AGENT_MODEL set defaults to openai/gpt-4o-mini, not the Anthropic default', () => {
  process.env.AGENT_LLM_PROVIDER = 'openrouter';
  const cfg = loadAgentConfig();
  assert.equal(cfg.model, 'openai/gpt-4o-mini');
});

test('loadAgentConfig: an explicit AGENT_MODEL overrides the provider-specific default for either provider', () => {
  process.env.AGENT_LLM_PROVIDER = 'openrouter';
  process.env.AGENT_MODEL = 'openai/gpt-4o';
  assert.equal(loadAgentConfig().model, 'openai/gpt-4o');

  delete process.env.AGENT_LLM_PROVIDER;
  process.env.AGENT_MODEL = 'claude-opus-4';
  assert.equal(loadAgentConfig().model, 'claude-opus-4');
});

test('loadAgentConfig: apiKey is undefined (not an empty string) when the relevant key env var is unset', () => {
  const cfgAnthropic = loadAgentConfig();
  assert.equal(cfgAnthropic.apiKey, undefined);

  process.env.AGENT_LLM_PROVIDER = 'openrouter';
  process.env.ANTHROPIC_API_KEY = 'should-not-be-used';
  const cfgOpenrouter = loadAgentConfig();
  assert.equal(cfgOpenrouter.apiKey, undefined, 'openrouter provider must never fall back to an Anthropic key');
});
