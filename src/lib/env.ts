import { z } from 'zod';

/**
 * Environment is validated once, at first access, and never read via
 * `process.env` elsewhere. Missing or malformed configuration fails loudly at
 * boot instead of producing a half-configured security posture at runtime.
 *
 * Cost safety is enforced here, not in the call sites: the default provider is
 * `mock`, and selecting a paid provider requires an explicit, deliberate change
 * to `LLM_PROVIDER`. There is no code path that upgrades `mock` to a paid
 * provider automatically, and no fallback that reaches for a paid provider when
 * something fails. See `src/providers/llm/factory.ts`.
 */
const booleanish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_BASE_URL: z.string().url().default('http://localhost:3200'),

  DATABASE_URL: z.string().min(1),
  TEST_DATABASE_URL: z.string().optional(),

  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
  DOCUMENT_ENCRYPTION_KEY: z.string().min(16),

  // --- LLM provider selection -------------------------------------------
  // `mock` is deterministic, offline, free, and the default everywhere.
  LLM_PROVIDER: z.enum(['mock', 'openai', 'anthropic', 'ollama']).default('mock'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(30_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(32_000).default(4_096),
  /** Opt-in prompt logging. Off by default: prompts contain applicant data. */
  LLM_LOG_PROMPTS: booleanish.default('false'),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  ANTHROPIC_BASE_URL: z.string().default('https://api.anthropic.com'),

  OLLAMA_BASE_URL: z.string().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default('llama3.1'),

  DOCUMENT_PROCESSORS: z.string().default('text,pdf,mock-ocr'),

  OBJECT_STORE_DRIVER: z.enum(['local', 's3']).default('local'),
  OBJECT_STORE_LOCAL_PATH: z.string().default('./storage'),

  MALWARE_SCANNER: z.enum(['noop', 'clamav-http']).default('noop'),
  CLAMAV_HTTP_URL: z.string().optional(),

  ENABLE_LIVE_SOURCES: booleanish.default('false'),
  LIVE_SOURCE_CONTACT_EMAIL: z.string().optional(),
  LIVE_SOURCE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),

  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(26_214_400),
  LOGIN_RATE_LIMIT_PER_15MIN: z.coerce.number().int().positive().default(10),
  TIP_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(5),
});

export type Env = z.infer<typeof schema>;
export type LlmProviderName = Env['LLM_PROVIDER'];

/** Providers that bill per request. Used to drive the admin warning banner. */
export const PAID_PROVIDERS: readonly LlmProviderName[] = ['openai', 'anthropic'] as const;

export function isPaidProvider(provider: LlmProviderName): boolean {
  return PAID_PROVIDERS.includes(provider);
}

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  // A paid provider must be fully configured before it is ever selected. We
  // fail startup rather than quietly degrading, so a misconfigured deployment
  // can never silently run extraction against the wrong provider.
  if (env.LLM_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
    throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY. Set LLM_PROVIDER=mock to run without API costs.');
  }
  if (env.LLM_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    throw new Error(
      'LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY. Set LLM_PROVIDER=mock to run without API costs.',
    );
  }

  // Live external calls are only permitted when a contact address is supplied:
  // the open APIs we call (Crossref, PubMed) require an identifying User-Agent
  // as a condition of their access policies.
  if (env.ENABLE_LIVE_SOURCES && !env.LIVE_SOURCE_CONTACT_EMAIL) {
    throw new Error('ENABLE_LIVE_SOURCES=true requires LIVE_SOURCE_CONTACT_EMAIL to be set.');
  }

  cached = env;
  return env;
}

/** Test helper: forces re-validation after mutating process.env. */
export function resetEnvCache(): void {
  cached = null;
}

/**
 * Paid providers are hard-disabled under NODE_ENV=test. A stray key in a
 * developer's shell must never turn `npm test` into a billable run.
 */
export function effectiveLlmProvider(): LlmProviderName {
  const env = getEnv();
  if (env.NODE_ENV === 'test' && isPaidProvider(env.LLM_PROVIDER)) return 'mock';
  return env.LLM_PROVIDER;
}

/**
 * Live source access is hard-disabled under NODE_ENV=test so a fixture or a
 * local `.env` can never make the suite hit a third party.
 */
export function liveSourcesEnabled(): boolean {
  const env = getEnv();
  if (env.NODE_ENV === 'test') return false;
  return env.ENABLE_LIVE_SOURCES;
}

/**
 * Non-secret provider posture for the administration screen. Deliberately
 * returns no key material — not even a masked prefix.
 */
export interface ProviderPosture {
  provider: LlmProviderName;
  model: string;
  isPaid: boolean;
  /** True when a key is configured. Never exposes the key itself. */
  credentialConfigured: boolean;
  liveSourcesEnabled: boolean;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
}

export function describeProviderPosture(): ProviderPosture {
  const env = getEnv();
  const provider = effectiveLlmProvider();
  const model =
    provider === 'openai'
      ? env.OPENAI_MODEL
      : provider === 'anthropic'
        ? env.ANTHROPIC_MODEL
        : provider === 'ollama'
          ? env.OLLAMA_MODEL
          : 'deterministic-mock-v1';
  const credentialConfigured =
    provider === 'openai'
      ? Boolean(env.OPENAI_API_KEY)
      : provider === 'anthropic'
        ? Boolean(env.ANTHROPIC_API_KEY)
        : provider === 'ollama' || provider === 'mock';

  return {
    provider,
    model,
    isPaid: isPaidProvider(provider),
    credentialConfigured,
    liveSourcesEnabled: liveSourcesEnabled(),
    timeoutMs: env.LLM_TIMEOUT_MS,
    maxRetries: env.LLM_MAX_RETRIES,
    maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
  };
}
