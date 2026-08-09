import type { z } from 'zod';
import type { LlmProviderName } from '@/lib/env';

/**
 * Provider-neutral LLM contract.
 *
 * The verification domain never imports a provider. It calls `runStructured`
 * (see `client.ts`) with a Zod schema and gets validated data back, so adding a
 * provider means adding one file that implements `LlmProvider` and one line in
 * the factory — no domain change.
 *
 * The model is confined to language work. It cannot reach the database, cannot
 * call a tool, and its output shape has no field for a verification status, a
 * fraud determination, or a decision. Those capabilities are absent from the
 * schemas, so a compromised or prompt-injected model cannot exercise them.
 */

export interface GenerateInput {
  /** Trusted system instruction. Never contains applicant document text. */
  system: string;
  /** User message. Untrusted content is fenced inside it, clearly labelled. */
  user: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Advisory name for providers that support named JSON schemas. */
  schemaName: string;
  /**
   * Pre-fence view of the same request.
   *
   * Network providers ignore this and use `system`/`user` only — it exists so
   * a local, deterministic provider (the mock) can work from structured input
   * instead of re-parsing its own prompt. It carries no additional authority:
   * the content is identical to what is fenced inside `user`, and it is still
   * untrusted applicant data.
   */
  structuredContext: {
    task: LlmTask;
    instruction: string;
    untrusted: UntrustedBlock[];
  };
}

export interface GenerateOutput {
  /** Raw model text, expected to be a JSON object. Never trusted before parsing. */
  text: string;
  /** Provider-side request id, when exposed. Useful for support escalations. */
  requestId: string | null;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  readonly model: string;
  /** Drives the administration warning banner. */
  readonly isPaid: boolean;
  generate(input: GenerateInput): Promise<GenerateOutput>;
}

/** Named tasks the model is permitted to perform. This list is closed. */
export type LlmTask =
  | 'EXTRACT_CLAIMS'
  | 'NORMALIZE_CLAIM'
  | 'SUMMARIZE_EVIDENCE'
  | 'GENERATE_INTERVIEW_QUESTIONS'
  | 'DRAFT_CLARIFICATION';

/** A block of content that came from outside the trust boundary. */
export interface UntrustedBlock {
  /** Where it came from, e.g. "resume.pdf page 2" or "https://example.org/x". */
  label: string;
  content: string;
}

export interface StructuredRequest<T> {
  task: LlmTask;
  /** Trusted instruction written by this application. */
  instruction: string;
  untrusted: UntrustedBlock[];
  schema: z.ZodType<T>;
  schemaName: string;
  /** JSON shape description included in the prompt to steer the model. */
  schemaHint: string;
  maxOutputTokens?: number;
}

export interface LlmTelemetry {
  provider: LlmProviderName;
  model: string;
  task: LlmTask;
  latencyMs: number;
  requestId: string | null;
  /** How many generate() calls were made, including schema-repair retries. */
  attempts: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmResult<T> {
  data: T;
  telemetry: LlmTelemetry;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export class LlmSchemaError extends LlmError {
  constructor(
    message: string,
    provider: string,
    readonly issues: unknown,
  ) {
    super(message, provider);
    this.name = 'LlmSchemaError';
  }
}
