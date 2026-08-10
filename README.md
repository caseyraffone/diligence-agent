# Corroborate Agent

Investigative decision-support for authorised teams verifying factual claims in
applications, résumés, transcripts, and supporting documents.

A reviewer uploads an applicant's materials. The system extracts every
independently verifiable claim with a citation back to the page it came from,
compares claims across documents, consults approved official sources, and
assembles the evidence into a workspace and a neutral report for a trained human
to weigh.

**It does not decide anything.** It produces no admissions, hiring, eligibility,
or funding recommendation, never states that a person lied or that fraud
occurred, and treats missing evidence as an evidence gap rather than as a
finding. Those boundaries are enforced in code, not just in documentation — see
[Design commitments](#design-commitments).

> **Read [`LIMITATIONS.md`](./LIMITATIONS.md) before using this on a real
> application.** It explains why missing records, document anomalies, AI
> detectors, and model confidence cannot establish that someone was dishonest —
> and what legal review production use requires.

---

## Contents

- [Quick start](#quick-start)
- [Demo sign-ins](#demo-sign-ins)
- [What runs free, and what costs money](#what-runs-free-and-what-costs-money)
- [Architecture](#architecture)
- [The four specialist modules](#the-four-specialist-modules)
- [Design commitments](#design-commitments)
- [Security](#security)
- [Data protection and retention](#data-protection-and-retention)
- [Adding a verification adapter](#adding-a-verification-adapter)
- [Adding an LLM provider](#adding-an-llm-provider)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## Quick start

Requires **Node 22 LTS** (`>=22.11 <23`) and **PostgreSQL 16**.

```bash
git clone <your-remote> corroborate-agent
cd corroborate-agent
npm install
cp .env.example .env

docker compose up -d db     # or see "PostgreSQL without Docker" below
npm run setup               # migrate + generate + seed, one command
npm run dev                 # → http://localhost:3200
```

`npm run setup` waits for the database, applies migrations, generates the Prisma
client, and seeds three demonstration cases. It is safe to re-run.

**No API keys are needed for any of this.** The default LLM provider is a
deterministic offline mock, and every source adapter serves recorded fixtures.

### PostgreSQL without Docker

Any PostgreSQL 16 will do. On Debian/Ubuntu:

```bash
sudo apt install postgresql-16
sudo -u postgres psql -c "CREATE ROLE corroborate LOGIN PASSWORD 'corroborate_local_dev' CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE corroborate_dev OWNER corroborate;"
sudo -u postgres psql -c "CREATE DATABASE corroborate_test OWNER corroborate;"
```

macOS with Homebrew:

```bash
brew install postgresql@16 && brew services start postgresql@16
createuser corroborate --createdb && createdb corroborate_dev -O corroborate && createdb corroborate_test -O corroborate
psql -d corroborate_dev -c "ALTER ROLE corroborate PASSWORD 'corroborate_local_dev';"
```

Then point `DATABASE_URL` and `TEST_DATABASE_URL` in `.env` at them. The two
must be different databases — `npm test` truncates its own.

### Everyday commands

| Command                                     | What it does                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `npm run dev`                               | Dev server on port 3200                                                    |
| `npm run setup`                             | Migrate, generate, and seed in one step                                    |
| `npm test`                                  | Unit + integration tests against the test database                         |
| `npm run test:e2e`                          | Playwright browser tests (needs a built, seeded app)                       |
| `npm run verify`                            | Everything CI runs: format, lint, typecheck, Prisma validate, tests, build |
| `npm run db:reset`                          | Drop, re-migrate, and re-seed the dev database                             |
| `npm run prisma:migrate -- --name <change>` | Create a migration                                                         |

---

## Demo sign-ins

Seeded by `npm run setup`. All fictional; all share the password
`DemoReviewer!2026`.

| Email                      | Role              | Tenant                 |
| -------------------------- | ----------------- | ---------------------- |
| `admin@redwood.example`    | Administrator     | Redwood University     |
| `lead@redwood.example`     | Lead reviewer     | Redwood University     |
| `reviewer@redwood.example` | Reviewer          | Redwood University     |
| `auditor@redwood.example`  | Read-only auditor | Redwood University     |
| `lead@aurora.example`      | Lead reviewer     | Aurora Talent Partners |
| `admin@aurora.example`     | Administrator     | Aurora Talent Partners |

Redwood and Aurora are separate tenants and cannot see each other's cases — sign
in as each to see tenant isolation working.

### The three demonstration cases

1. **RU-2026-0142 — Amara Okonkwo** (Redwood). Fully corroborated. Registrar
   confirmations, a resolving DOI, an award listing, and a referee letter. Every
   claim has a recorded human outcome.
2. **AT-2026-0088 — Daniel Whitfield** (Aurora). A résumé and an application form
   state different job titles and start dates. The system raises two
   observations; the applicant explains a contract-to-permanent conversion and a
   promotion; the employer confirms both; the observations close as _explained_.
   **Nobody did anything wrong** — this is the false-positive path, and it is
   the case most worth clicking through.
3. **RU-2026-0207 — Priya Raman** (Redwood). A competition placement that stays
   **conflicting** after two independent checks disagree with it. The published
   results and an archived capture both show a different placement; the applicant
   responds without documentation; a reviewer records _conflicting information_
   and the recommended next step is to write to the organiser. No conclusion is
   drawn about how the difference arose. This case also contains a document with
   an embedded prompt-injection payload — recorded as an observation, ignored.

---

## What runs free, and what costs money

**Free, offline, and fully functional — the default:**

- Every feature in the product: upload, extraction, verification planning,
  source checks, cross-document comparison, discrepancy detection, clarification
  and outreach workflows, interviews, tips, timelines, reports, audit.
- `LLM_PROVIDER=mock` — a deterministic rule-based extractor. Not a stub: it
  really parses documents, which is why the seeded cases are produced by running
  the actual pipeline.
- All ten source adapters serving recorded fixtures.
- The entire test suite and CI.

**Free but requires local infrastructure:**

- `LLM_PROVIDER=ollama` — a local model. No data leaves your host.
- `ENABLE_LIVE_SOURCES=true` — real Crossref and PubMed queries. Both are open
  APIs, free, and require no agreement; set `LIVE_SOURCE_CONTACT_EMAIL` so we
  identify ourselves as their access policies ask.

**Costs money, and only when you explicitly ask for it:**

- `LLM_PROVIDER=openai` (needs `OPENAI_API_KEY`)
- `LLM_PROVIDER=anthropic` (needs `ANTHROPIC_API_KEY`)

The app **never** falls back from the mock to a paid provider, never constructs
one because a key happens to be present, and refuses to start if you select one
without configuring it. A paid provider is shown as a warning banner on every
screen and on the administration page. Under `NODE_ENV=test`, paid selections
are downgraded to the mock so a stray key cannot make `npm test` billable.

Note that a paid provider sends applicant document text to a third party. That
needs a data-processing agreement and disclosure in your privacy notice.

---

## Architecture

| Layer    | Choice                                                      | Why                                                                        |
| -------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| App      | Next.js 15 (App Router) + React 19                          | Server components keep applicant data server-side; one deployable          |
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess`           | The status machine and evidence rules are worth compile-time guarantees    |
| Data     | PostgreSQL 16 + Prisma 6                                    | Migrations, JSONB for evidence payloads, real constraints                  |
| Jobs     | `VerificationTask` rows + in-process worker                 | One runtime dependency instead of two; a restart loses nothing             |
| Storage  | `ObjectStore` interface, local FS driver                    | Originals encrypted at rest, addressable by key, deletable under retention |
| LLM      | `LlmProvider` interface: mock / openai / anthropic / ollama | Provider-neutral; the domain never imports one                             |
| Sources  | `SourceAdapter` interface, 10 adapters                      | Fixtures by default; live only for open APIs                               |

```
src/
  app/          Next routes — reviewer UI, applicant portal, API
  components/   Shared presentational pieces
  domain/       Deterministic rules. No I/O, no model calls, fully unit-tested.
    claimStatus.ts   status machine + who may assign what
    authority.ts     source hierarchy, evidence → status proposal
    consistency.ts   every cross-document detection rule
    prioritize.ts    queue ordering over a closed input set
  lib/          auth (session, RBAC, tenant scope, portal tokens), audit,
                crypto, dates, text, redaction, ratelimit, env
  modules/      The four specialists + orchestrator + workflows
  providers/    llm | documents | storage | malware
  adapters/     External sources behind one interface
  queue/        Durable worker
```

**Layering rule:** `domain/` may not import `lib/prisma`, `providers/`, or
`adapters/`. Everything consequential — status transitions, date arithmetic,
authority ranking, prioritisation — lives there so it is testable without a
database or a model. This is enforced by review, and is why 75 of the tests need
no database at all.

---

## The four specialist modules

One orchestrating agent coordinates four separated specialists.

**1. Claim Mapper** (`src/modules/claimMapper.ts`) extracts structured claims
from each document page: education, degrees, employment, awards, research,
publications, athletics, certifications, volunteering, projects and ventures,
and quantitative metrics. Every claim records its exact source passage, document,
and page. Dates proposed by the model are **re-parsed by deterministic code**,
because every downstream rule depends on them. Extraction confidence describes
reading accuracy and is never used as evidence.

**2. Evidence Verifier** (`src/modules/evidenceVerifier.ts`) builds a per-claim
plan from the source hierarchy (issuing authority → official site → authorised
representative → signed record → independent reporting → applicant-provided →
informal), runs the adapters the policy approves, and records URL, retrieval
time, excerpt, authority level, and result for every check. It refuses to touch
an external source without a recorded consent record, and cannot assign
`VERIFIED`, `CORROBORATED`, or `CONFLICTING_INFORMATION`.

**3. Consistency & Document Integrity Analyst** (`src/domain/consistency.ts`)
compares claims across documents and against sources: conflicting dates,
overlapping full-time commitments, title and organisation mismatches, award-level
inconsistencies, publication authorship differences, claims unsupported by
recommendation letters, divergent research descriptions, arithmetic that does not
fit the stated period, duplicate documents, and observable file anomalies. Every
rule states what was observed, why it merits a look, and the ordinary
explanations that produce it. False-positive suppression is explicit and tested.

**4. Case Reviewer** (`src/modules/caseReviewer.ts`) assembles progress, claims
grouped by status, the evidence matrix, a timeline, a relationship map,
unresolved questions, recommended next verification steps, clarification history,
reviewer notes, the audit log, and the exportable report. The report keeps
**confirmed facts, applicant statements, third-party statements, system
observations, inferences, and unresolved discrepancies** strictly apart.

---

## Design commitments

These are enforced mechanically. Each has a test that fails if someone removes
the guard.

**The pipeline cannot reach a conclusion.** It may assign only
`PENDING_VERIFICATION`, `PARTIALLY_CORROBORATED`, `UNABLE_TO_VERIFY`,
`HUMAN_REVIEW_REQUIRED`, and `APPLICANT_CLARIFICATION_REQUESTED`. `VERIFIED`,
`CORROBORATED`, and `CONFLICTING_INFORMATION` require a named human and a
written rationale. When evidence would support a conclusion, the system routes
the claim to a reviewer instead of drawing it.

**Absence is never evidence of falsity.** Adapters distinguish "this source holds
no record" (`RECORD_NOT_FOUND`) from "this source holds a record that says
something different" (`NO_MATCH`). Only the latter can become conflicting
evidence. A contract test enforces this for every adapter.

**The model cannot express a decision.** Output schemas contain no status,
decision, score, or recommendation field. A prompt-injected or hallucinated
response has nowhere to put one, and unknown keys are stripped before anything
is written.

**Nothing is terminal.** Every status can be revised when new evidence arrives,
every reviewer decision is reversible, and re-analysis never overwrites a human
decision.

**No consequential decision capability exists.** No role — including
administrator — holds a permission that produces an admissions, hiring, or
eligibility outcome. A test asserts the permission set never grows one.

**Protected characteristics are absent from the schema.** They are not stored,
so prioritisation cannot use them. Prioritisation takes a closed input set of
evidence gaps, unresolved differences, and due dates, and shows its working.

**The system never contacts anyone.** Outreach and clarification requests are
drafted, reviewed, and approved in-app. A human sends them and records that they
did. There is no mail transport in the codebase.

---

## Security

- **Authentication**: scrypt password hashing; httpOnly, SameSite=Lax session
  cookies; only a SHA-256 of the session token is stored; login is rate limited
  per email address; response timing does not reveal whether an account exists.
- **Tenant isolation**: organisation scope comes from the session, never from a
  request parameter, and is folded into every query through loaders in
  `src/lib/auth/tenant.ts`. A cross-tenant read returns **404**, indistinguishable
  from a missing record, so error codes cannot be used to enumerate.
- **RBAC**: four roles over a closed permission set. Permissions are derived from
  code, not from the stored column, so a tampered database row cannot widen
  access.
- **CSRF**: double-submit token bound to a per-session secret for API routes;
  origin checks plus SameSite for server actions.
- **Uploads**: type allow-list, magic-byte verification against the declared
  type, size limit, content hashing, malware-scanner interface (which never
  reports "clean" when no scanner is configured), and AES-256-GCM encryption at
  rest.
- **Safe rendering**: originals are served only as `Content-Disposition:
attachment` with `application/octet-stream`, `nosniff`, and a sandboxed CSP.
  The document preview renders extracted text as escaped React text, never HTML.
- **Prompt injection**: untrusted content is fenced with a per-request random
  delimiter, and the real defence is the schema boundary above. Injection
  patterns are surfaced to a human as observations, never used as a filter or a
  finding.
- **Audit**: append-only, hash-chained per organisation, verifiable on demand
  from the UI. Detects both modification and deletion.
- **Headers**: strict CSP, `frame-ancestors 'none'`, `nosniff`, no referrer,
  COOP, restrictive Permissions-Policy.

Known gaps are in [`LIMITATIONS.md` §7](./LIMITATIONS.md).

---

## Data protection and retention

- **Consent is a gate in code.** External verification throws
  `ConsentRequiredError` until a `ConsentRecord` for the relevant scope exists.
  Blocked jobs are parked and resume when consent is recorded.
- **Originals are separated from extracted data.** Files live encrypted in object
  storage; claims and evidence live in the database. Retention can delete the
  originals while the decision record survives.
- **Government identifiers are redacted before storage.** SSN/ITIN, passport and
  national-id numbers, payment cards (Luhn-checked to avoid destroying student
  and grant numbers), bank details, and labelled dates of birth are masked from
  extracted text. The encrypted original still contains them.
- **No protected characteristic is modelled anywhere**, and none is inferred.
- **Everything consequential is logged**: views, edits, exports, outreach,
  status changes, downloads.
- **Applicants get scoped access only.** A clarification link is
  single-purpose, expiring, and revocable, and exposes one request — never the
  case, other claims, reviewer notes, referee replies, or tips.
- **Retention rules are configurable per policy but not yet auto-enforced.** See
  [`LIMITATIONS.md` §8](./LIMITATIONS.md).

---

## Adding a verification adapter

Two steps, and no domain code changes.

```ts
// src/adapters/myRegistry.ts
import { AuthorityLevel, ClaimCategory } from '@prisma/client';
import { FixtureBackedAdapter } from './base';
import type { IntegrationStatus, SourceCheckOutcome, SourceQuery } from './types';

export class MyRegistryAdapter extends FixtureBackedAdapter {
  readonly key = 'my-registry';
  readonly name = 'My Registry';
  readonly authorityLevel = AuthorityLevel.L1_ISSUING_AUTHORITY;
  readonly supportedCategories = [ClaimCategory.CERTIFICATION_LICENSE];
  readonly integrationStatus: IntegrationStatus = 'PLACEHOLDER';
  readonly integrationNote = 'What production access actually requires — be specific.';

  // Optional: implement only if the API is open and permits automation.
  protected override async checkLive(query: SourceQuery): Promise<SourceCheckOutcome | null> {
    if (!liveSourcesEnabled()) return null; // fixtures handle the rest
    // ...
  }
}
```

Then register it in `src/adapters/registry.ts` and add fixtures in
`src/adapters/fixtures.ts`.

The shared contract test in `tests/adapters/contract.test.ts` picks it up
automatically. It will fail unless your adapter returns `RECORD_NOT_FOUND` — not
`NO_MATCH` — when the source holds nothing. That distinction is the difference
between an unanswered question and an accusation; treat a failure there as a
design bug, not a test to adjust.

Only implement `checkLive` for sources that are open, free, and permit automated
access. Do not scrape sites that prohibit it, and do not evade authentication,
rate limits, or robots directives.

## Adding an LLM provider

Implement `LlmProvider` from `src/providers/llm/types.ts` and add one line to
`factory.ts`. The domain calls `runStructured()` with a Zod schema and never
knows which provider answered.

Respect `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`, and `LLM_MAX_OUTPUT_TOKENS`; never
log prompt bodies or key material; never add a fallback to a paid provider.

---

## Testing

```bash
npm test           # 235 unit + integration tests
npm run test:e2e   # 29 browser tests, desktop and tablet viewports
npm run verify     # what CI runs
```

Both suites run with **no API keys and no network access**. `NODE_ENV=test`
forces the mock provider and hard-disables live sources regardless of `.env`.

Coverage includes claim normalisation and status transitions, cross-document
consistency, date and timeline arithmetic, authorisation and tenant isolation,
prompt injection, the adapter contract, upload security, audit integrity, and
end-to-end university and job-application flows.

**False positives are tested explicitly**, because a verification tool that
cries wolf harms people: a summer job during a degree, part-time work alongside
a full-time role, a coarse-precision date overlap, a renamed or translated
organisation, an equivalent job title, an ambiguous "J. Smith", and an obscure
award with no online record must all produce no finding — and an obscure
achievement must still be able to reach `VERIFIED` once authoritative evidence
arrives.

CI (`.github/workflows/ci.yml`) runs the full chain plus browser tests against a
PostgreSQL service container, with no secrets. A pull request that needs a secret
to go green has broken that property.

---

## Troubleshooting

**`Can't reach database server at 127.0.0.1:5432`**
The database is not running. `docker compose up -d db`, or start your local
PostgreSQL. Check `docker compose ps` and `docker compose logs db`.

**`TEST_DATABASE_URL must differ from DATABASE_URL`**
`npm test` truncates its database. Point it at a separate one — the guard exists
so you do not lose your seeded cases.

**`Invalid environment configuration`**
`getEnv()` validates at startup and lists exactly which variables are wrong. The
usual cause is a missing `APP_SECRET` (needs 32+ characters) after copying
`.env.example`.

**`LLM_PROVIDER=openai requires OPENAI_API_KEY`**
Deliberate: selecting a paid provider without configuring it fails loudly rather
than silently falling back. Set the key, or return to `LLM_PROVIDER=mock`.

**`ENABLE_LIVE_SOURCES=true requires LIVE_SOURCE_CONTACT_EMAIL`**
Crossref and PubMed ask callers to identify themselves. Set a real address.

**Claims are not extracted from a document**
Check the document's status on the case page. Images and scanned PDFs are
recorded as requiring manual review — OCR is not implemented. For text and PDFs,
open the parsed preview and compare against the original: the mock extractor is
rule-based and handles conventional layouts best.

**Source checks are parked as "blocked awaiting consent"**
Working as intended. Record a consent record for _checking official and public
sources_ on the case; parked tasks resume automatically.

**Playwright: `Executable doesn't exist`**
Run `npx playwright install chromium`. If your environment preinstalls a
different Chromium build, set `PLAYWRIGHT_CHROMIUM_PATH` to its binary instead.

**Browser tests fail on the login step**
Login is rate limited to ten attempts per email per fifteen minutes. The suite
signs in once per role and reuses the session; if you have been testing manually,
wait for the window or clear `RateLimitCounter`.

**Port 3200 already in use**
A dev server is already running. `lsof -i :3200`.

---

## Licence

Apache-2.0. See [`LICENSE`](./LICENSE).

Engineering conventions for humans and coding agents alike live in
[`AGENTS.md`](./AGENTS.md).
