import { getEnv } from '@/lib/env';
import { LlmError, type GenerateInput, type GenerateOutput, type LlmProvider } from './types';

/**
 * OpenAI Chat Completions provider. PAID — every call is billed.
 *
 * Only constructed when LLM_PROVIDER=openai is set explicitly and a key is
 * present; `getEnv()` fails startup otherwise. Nothing in the app falls back to
 * this provider.
 */
export class OpenAiLlmProvider implements LlmProvider {
  readonly name = 'openai' as const;
  readonly isPaid = true;
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor() {
    const env = getEnv();
    if (!env.OPENAI_API_KEY) {
      throw new LlmError('OpenAiLlmProvider constructed without OPENAI_API_KEY', 'openai');
    }
    this.apiKey = env.OPENAI_API_KEY;
    this.model = env.OPENAI_MODEL;
    this.baseUrl = env.OPENAI_BASE_URL.replace(/\/$/, '');
  }

  async generate(input: GenerateInput): Promise<GenerateOutput> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_completion_tokens: input.maxOutputTokens,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
        }),
      });

      if (!response.ok) {
        // The body may echo request content; only the status is surfaced.
        throw new LlmError(`OpenAI request failed with status ${response.status}`, 'openai');
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const text = json.choices?.[0]?.message?.content;
      if (!text) throw new LlmError('OpenAI returned no message content', 'openai');

      return {
        text,
        requestId: response.headers.get('x-request-id'),
        usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
      };
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if (e instanceof Error && e.name === 'AbortError') {
        throw new LlmError(`OpenAI request timed out after ${input.timeoutMs}ms`, 'openai', e);
      }
      throw new LlmError('OpenAI request failed', 'openai', e);
    } finally {
      clearTimeout(timer);
    }
  }
}
