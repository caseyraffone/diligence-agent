import { effectiveLlmProvider, getEnv, type LlmProviderName } from '@/lib/env';
import type { LlmProvider } from './types';
import { MockLlmProvider } from './mock';
import { OpenAiLlmProvider } from './openai';
import { AnthropicLlmProvider } from './anthropic';
import { OllamaLlmProvider } from './ollama';

/**
 * Provider selection.
 *
 * Cost-safety invariants, all covered by tests:
 *
 *   - `mock` is the default and requires no configuration.
 *   - A paid provider is only ever constructed when LLM_PROVIDER names it
 *     explicitly. There is no capability probing, no "use the key if present",
 *     and no automatic upgrade.
 *   - There is NO fallback path from mock to a paid provider. If a selected
 *     provider fails, the error propagates; it is never retried on a different
 *     provider, because silently substituting a billable provider for a free
 *     one is exactly the surprise this design forbids.
 *   - Under NODE_ENV=test, paid selections are downgraded to mock by
 *     `effectiveLlmProvider()`, so a stray key cannot make the suite billable.
 */

let cached: { key: string; provider: LlmProvider } | null = null;

export function getLlmProvider(): LlmProvider {
  const name = effectiveLlmProvider();
  const env = getEnv();

  // Model name is part of the cache key so changing it in dev takes effect.
  const key = `${name}:${env.OPENAI_MODEL}:${env.ANTHROPIC_MODEL}:${env.OLLAMA_MODEL}`;
  if (cached && cached.key === key) return cached.provider;

  const provider = construct(name);
  cached = { key, provider };
  return provider;
}

function construct(name: LlmProviderName): LlmProvider {
  switch (name) {
    case 'mock':
      return new MockLlmProvider();
    case 'openai':
      return new OpenAiLlmProvider();
    case 'anthropic':
      return new AnthropicLlmProvider();
    case 'ollama':
      return new OllamaLlmProvider();
  }
}

/** Test helper. */
export function resetLlmProviderCache(): void {
  cached = null;
}
