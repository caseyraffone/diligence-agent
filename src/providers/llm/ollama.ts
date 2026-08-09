import { getEnv } from '@/lib/env';
import { LlmError, type GenerateInput, type GenerateOutput, type LlmProvider } from './types';

/**
 * Ollama provider — local models, no API cost, no data leaving the host.
 *
 * Attractive for this product because applicant documents never reach a third
 * party. Output quality varies by model, so schema validation and the
 * human-review boundary matter more here, not less.
 */
export class OllamaLlmProvider implements LlmProvider {
  readonly name = 'ollama' as const;
  readonly isPaid = false;
  readonly model: string;

  private readonly baseUrl: string;

  constructor() {
    const env = getEnv();
    this.model = env.OLLAMA_MODEL;
    this.baseUrl = env.OLLAMA_BASE_URL.replace(/\/$/, '');
  }

  async generate(input: GenerateInput): Promise<GenerateOutput> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: 'json',
          options: { temperature: 0, num_predict: input.maxOutputTokens },
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
        }),
      });

      if (!response.ok) {
        throw new LlmError(
          `Ollama request failed with status ${response.status}. Is the daemon running at ${this.baseUrl}?`,
          'ollama',
        );
      }

      const json = (await response.json()) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };

      const text = json.message?.content;
      if (!text) throw new LlmError('Ollama returned no message content', 'ollama');

      return {
        text,
        requestId: null,
        usage: { inputTokens: json.prompt_eval_count, outputTokens: json.eval_count },
      };
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if (e instanceof Error && e.name === 'AbortError') {
        throw new LlmError(`Ollama request timed out after ${input.timeoutMs}ms`, 'ollama', e);
      }
      throw new LlmError(`Ollama request failed. Is the daemon running at ${this.baseUrl}?`, 'ollama', e);
    } finally {
      clearTimeout(timer);
    }
  }
}
