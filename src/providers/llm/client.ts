import { getEnv } from '@/lib/env';
import { getLlmProvider } from './factory';
import { buildPrompt } from './prompt';
import { LlmError, LlmSchemaError, type LlmResult, type StructuredRequest } from './types';

/**
 * The only entry point the verification domain uses.
 *
 * Responsibilities:
 *  - build a prompt with untrusted content fenced,
 *  - enforce timeout, retry, and output-token limits,
 *  - parse and validate against the caller's Zod schema,
 *  - retry once per remaining attempt with a repair instruction on schema
 *    failure, and fail loudly rather than storing an unvalidated object,
 *  - emit telemetry (provider, model, latency, request id) without prompt bodies.
 *
 * Nothing invalid is ever returned. A caller that gets a value back can rely on
 * it matching the schema exactly.
 */

export async function runStructured<T>(request: StructuredRequest<T>): Promise<LlmResult<T>> {
  const env = getEnv();
  const provider = getLlmProvider();
  const prompt = buildPrompt(request);
  const maxOutputTokens = Math.min(request.maxOutputTokens ?? env.LLM_MAX_OUTPUT_TOKENS, env.LLM_MAX_OUTPUT_TOKENS);

  const started = Date.now();
  let attempts = 0;
  let lastIssues: unknown = null;
  let lastError: unknown = null;
  let user = prompt.user;

  const totalAttempts = env.LLM_MAX_RETRIES + 1;

  for (let i = 0; i < totalAttempts; i++) {
    attempts++;
    try {
      const output = await provider.generate({
        system: prompt.system,
        user,
        maxOutputTokens,
        timeoutMs: env.LLM_TIMEOUT_MS,
        schemaName: request.schemaName,
        structuredContext: {
          task: request.task,
          instruction: request.instruction,
          untrusted: request.untrusted,
        },
      });

      const parsed = parseJsonObject(output.text);
      if (!parsed.ok) {
        lastIssues = parsed.error;
        user = repairPrompt(prompt.user, `The previous reply was not valid JSON: ${parsed.error}`);
        continue;
      }

      const validated = request.schema.safeParse(parsed.value);
      if (!validated.success) {
        lastIssues = validated.error.issues;
        user = repairPrompt(
          prompt.user,
          `The previous reply did not match the required shape. Problems: ${summarizeIssues(validated.error.issues)}`,
        );
        continue;
      }

      logTelemetry({
        provider: provider.name,
        model: provider.model,
        task: request.task,
        latencyMs: Date.now() - started,
        requestId: output.requestId,
        attempts,
        outcome: 'ok',
      });

      return {
        data: validated.data,
        telemetry: {
          provider: provider.name,
          model: provider.model,
          task: request.task,
          latencyMs: Date.now() - started,
          requestId: output.requestId,
          attempts,
          inputTokens: output.usage?.inputTokens,
          outputTokens: output.usage?.outputTokens,
        },
      };
    } catch (e) {
      lastError = e;
      // Transport failures are retried on the SAME provider. There is no
      // cross-provider fallback by design.
      if (i === totalAttempts - 1) break;
    }
  }

  logTelemetry({
    provider: provider.name,
    model: provider.model,
    task: request.task,
    latencyMs: Date.now() - started,
    requestId: null,
    attempts,
    outcome: 'failed',
  });

  if (lastIssues) {
    throw new LlmSchemaError(
      `Model output failed schema validation for ${request.schemaName} after ${attempts} attempt(s).`,
      provider.name,
      lastIssues,
    );
  }
  throw new LlmError(
    `Model call for ${request.task} failed after ${attempts} attempt(s): ${describeError(lastError)}`,
    provider.name,
    lastError,
  );
}

function repairPrompt(original: string, problem: string): string {
  return `${original}\n\nYOUR PREVIOUS REPLY WAS REJECTED.\n${problem}\nReturn only a single valid JSON object matching the shape above.`;
}

interface ParseOk {
  ok: true;
  value: unknown;
}
interface ParseErr {
  ok: false;
  error: string;
}

/**
 * Tolerant JSON extraction. Models wrap objects in prose or code fences even
 * when told not to; we recover the object rather than burning a retry.
 */
export function parseJsonObject(text: string): ParseOk | ParseErr {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const direct = tryParse(withoutFence);
  if (direct.ok) return direct;

  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const sliced = tryParse(withoutFence.slice(start, end + 1));
    if (sliced.ok) return sliced;
  }

  return { ok: false, error: 'no parseable JSON object found in the reply' };
}

function tryParse(candidate: string): ParseOk | ParseErr {
  try {
    const value: unknown = JSON.parse(candidate);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'reply was not a JSON object' };
    }
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unparseable' };
  }
}

function summarizeIssues(issues: Array<{ path: Array<string | number>; message: string }>): string {
  return issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

interface TelemetryLine {
  provider: string;
  model: string;
  task: string;
  latencyMs: number;
  requestId: string | null;
  attempts: number;
  outcome: 'ok' | 'failed';
}

/**
 * Structured observability. Deliberately records no prompt content, no document
 * text, and no key material — only what is needed to diagnose latency, retries,
 * and provider incidents.
 */
function logTelemetry(line: TelemetryLine): void {
  const env = getEnv();
  if (env.NODE_ENV === 'test') return;
  console.warn(JSON.stringify({ event: 'llm_call', ...line }));
}
