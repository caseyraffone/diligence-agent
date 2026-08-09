import { getEnv } from '@/lib/env';
import { LlmError, type GenerateInput, type GenerateOutput, type LlmProvider } from './types';

/**
 * Anthropic Messages provider. PAID — every call is billed.
 *
 * Only constructed when LLM_PROVIDER=anthropic is set explicitly and a key is
 * present. Nothing in the app falls back to this provider.
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly isPaid = true;
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor() {
    const env = getEnv();
    if (!env.ANTHROPIC_API_KEY) {
      throw new LlmError('AnthropicLlmProvider constructed without ANTHROPIC_API_KEY', 'anthropic');
    }
    this.apiKey = env.ANTHROPIC_API_KEY;
    this.model = env.ANTHROPIC_MODEL;
    this.baseUrl = env.ANTHROPIC_BASE_URL.replace(/\/$/, '');
  }

  async generate(input: GenerateInput): Promise<GenerateOutput> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: input.maxOutputTokens,
          temperature: 0,
          system: input.system,
          messages: [
            { role: 'user', content: input.user },
            // Prefilling the opening brace constrains the reply to a JSON object.
            { role: 'assistant', content: '{' },
          ],
        }),
      });

      if (!response.ok) {
        throw new LlmError(`Anthropic request failed with status ${response.status}`, 'anthropic');
      }

      const json = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      const body = json.content?.find((c) => c.type === 'text')?.text;
      if (body === undefined) throw new LlmError('Anthropic returned no text content', 'anthropic');

      return {
        // Re-attach the prefilled brace that the API does not echo back.
        text: `{${body}`,
        requestId: response.headers.get('request-id'),
        usage: { inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens },
      };
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if (e instanceof Error && e.name === 'AbortError') {
        throw new LlmError(`Anthropic request timed out after ${input.timeoutMs}ms`, 'anthropic', e);
      }
      throw new LlmError('Anthropic request failed', 'anthropic', e);
    } finally {
      clearTimeout(timer);
    }
  }
}
