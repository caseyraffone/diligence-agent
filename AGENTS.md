# AGENTS.md — Diligence Agent

Canonical engineering instructions for this repository. Claude Code, OpenAI
Codex, and any other coding agent must read and follow this file. Human
contributors should too.

If anything in this document conflicts with a request, raise the conflict rather
than silently resolving it.

---

## 1. What this product is, and what it must never become

Diligence Agent is **investigative decision-support** for authorized
reviewers verifying factual claims in applications, résumés, and supporting
documents.

It is **not** an admissions system, a hiring system, an eligibility system, or a
fraud detector. It gathers evidence and organizes it for a trained human.

**Hard product boundaries. Do not implement, and reject changes that add:**

- Any output that says a person lied, committed fraud, or falsified a document.
- Any admit/reject, hire/do-not-hire, approve/deny, or equivalent recommendation
  or score.
- Facial recognition, biometric identity matching, covert surveillance, or
  automated personality/integrity/trustworthiness scoring.
- Any inference about race, ethnicity, religion, disability, medical status,
  sex, gender identity, sexual orientation, age, family status, or
  socioeconomic status — or any proxy for them.
- Any treatment of missing evidence as evidence of falsity.
- Any scraping that evades authentication, rate limits, robots directives, or
  terms of service; any purchase of breached data; any contact with third
  parties without recorded applicant consent.

Neutral statuses are the only vocabulary: `PENDING_VERIFICATION`, `VERIFIED`,
`CORROBORATED`, `PARTIALLY_CORROBORATED`, `UNABLE_TO_VERIFY`,
`CONFLICTING_INFORMATION`, `APPLICANT_CLARIFICATION_REQUESTED`,
`HUMAN_REVIEW_REQUIRED`. Do not add a status that implies dishonesty.

`UNABLE_TO_VERIFY` means "we did not find a record". It never means "this is
false". Any code or copy that blurs this is a bug.

---

## 2. Architecture

```
src/
  app/                Next.js App Router — reviewer UI, applicant portal, API routes
  components/         Shared React components (server-first; client only when needed)
  domain/             Deterministic business rules. NO model calls, NO I/O.
    claimStatus.ts      status state machine + who may assign what
    authority.ts        source hierarchy, evidence → status *proposal*
    prioritize.ts       queue ordering (closed input set, no protected traits)
  lib/                Cross-cutting infrastructure
    auth/               sessions, RBAC, tenant scoping, applicant portal tokens
    audit/              hash-chained append-only audit log
    crypto, dates, text, redaction, ratelimit, env, errors
  modules/            The four specialists + orchestrator
    claimMapper.ts, evidenceVerifier.ts, consistencyAnalyst.ts,
    caseReviewer.ts, orchestrator.ts
  providers/          Swappable infrastructure behind interfaces
    llm/                mock (default) | openai | anthropic | ollama
    documents/          text | pdf | mock-ocr
    storage/            local | s3 (stub)
    malware/            noop | clamav-http
  adapters/           External source adapters (fixtures by default)
  queue/              Durable job worker backed by VerificationTask rows
prisma/               Schema, migrations, seed
tests/                Vitest unit + integration; Playwright e2e
```

**Layering rule:** `domain/` may not import from `lib/prisma`, `providers/`, or
`adapters/`. It is pure and synchronously testable. Everything consequential —
status transitions, date math, authority ranking, prioritization, access
control — lives there so it can be tested without a database or a model.

**The LLM is confined to language work.** It may extract, normalize, classify
categories, summarize, generate interview questions, and draft clarification
text. It may not decide anything. This is enforced structurally: the Zod output
schemas in `src/providers/llm/schemas.ts` contain no status, decision, score, or
tool field, so an invalid or injected response cannot express one.

---

## 3. Development commands

Requires **Node 22 LTS** (`>=22.11 <23`) and **PostgreSQL 16**.

```bash
npm install
cp .env.example .env          # defaults run everything with zero API keys
docker compose up -d db       # or use the non-Docker path in the README
npm run setup                 # migrate + generate + seed, one command
npm run dev                   # http://localhost:3200

npm test                      # unit + integration (auto-migrates the test DB)
npm run test:e2e              # Playwright, needs a built or running app
npm run verify                # format:check + lint + typecheck + prisma validate + test + build
```

`npm run verify` is what CI runs. Run it before proposing any change.

---

## 4. Testing expectations

- **`domain/` changes require unit tests.** These are the rules that decide what
  a reviewer sees; they are not allowed to be untested.
- **Every new source adapter must pass the shared contract test** in
  `tests/adapters/contract.test.ts`. Register it in the suite; do not write a
  bespoke test that skips the contract.
- **Authorization and tenant isolation changes require a test** proving a user
  in organization A cannot read, mutate, or enumerate organization B's rows —
  and that the failure is indistinguishable from "not found".
- **Prompt-injection fixtures live in `tests/fixtures/`.** When you touch
  extraction, add a fixture with the hostile text embedded and assert that no
  status changed and no policy was altered.
- **Test false positives explicitly.** A legitimate but unusual achievement
  must be able to reach `VERIFIED` after authoritative evidence or clarification.
  A legitimate date overlap (a summer job during a degree) must not raise a
  discrepancy. Adding a new detection rule means adding its false-positive test.
- Tests must pass with **no API keys and no network**. `NODE_ENV=test` forces
  the mock provider and disables live sources; do not add a test that depends on
  a third party.

---

## 5. Database and migrations

- Schema changes go through Prisma migrations: `npm run prisma:migrate -- --name <change>`.
- **Never edit an applied migration.** Add a new one.
- Every case-scoped table carries `organizationId`. New tables holding case data
  must carry it too, and their loaders belong in `src/lib/auth/tenant.ts`.
- Do not add a column that stores a protected characteristic or a government
  identifier. Identifiers are redacted before extracted text is written; see
  `src/lib/redaction.ts`.
- Original document bytes never go in the database — only in object storage,
  encrypted, referenced by `storageKey`, so retention can delete originals while
  preserving the audit trail.

---

## 6. Security requirements

- Tenant scope comes from the **session**, never from a request parameter. Load
  case-scoped rows through the helpers in `src/lib/auth/tenant.ts`. Do not call
  `prisma.<caseEntity>.findUnique({ where: { id } })` in a route.
- Every mutating route calls `requireMutation(permission)` — it checks the
  permission, the CSRF token, and the request origin together.
- Forbidden renders as **404**, so an unauthorized caller cannot enumerate what
  exists.
- Uploads: validate declared and sniffed type, enforce `MAX_UPLOAD_BYTES`, hash
  the content, run the malware-scanner interface, and store encrypted. Originals
  are served only as `Content-Disposition: attachment` under a sandboxed CSP —
  never rendered inline in the app origin.
- Secrets come from validated env only (`src/lib/env.ts`). Never log a key, a
  prompt body, or document text. `LLM_LOG_PROMPTS` is off by default.
- Treat every uploaded document and fetched webpage as hostile input. Fence it
  as untrusted (`src/providers/llm/prompt.ts`) and rely on the schema boundary,
  not on prompt wording.
- The audit log is append-only and hash-chained. Never add an update or delete
  path for `AuditEvent`.

---

## 7. Human-review boundaries

The single most important invariant in the codebase:

> The automated pipeline may assign only `PENDING_VERIFICATION`,
> `PARTIALLY_CORROBORATED`, `UNABLE_TO_VERIFY`, `HUMAN_REVIEW_REQUIRED`, and
> `APPLICANT_CLARIFICATION_REQUESTED`. `VERIFIED`, `CORROBORATED`, and
> `CONFLICTING_INFORMATION` may only be recorded by an authorized human, with a
> written rationale.

Enforced by `assertActorMayAssign` in `src/domain/claimStatus.ts`. Do not add a
bypass, a "system user", or an auto-approve flag.

Also required:

- Every human status change writes a `ReviewerDecision` with a rationale.
- Every decision is reversible. Nothing is terminal.
- Outreach and clarification requests are **drafted only**. The system never
  transmits. A reviewer approves, sends through their own channel, and records
  that they did.
- Anonymous tips never change a claim's status. They are unverified allegations
  requiring independent corroboration, visible only to roles holding `tip:read`.
- Interview conclusions require human review before they carry weight.

---

## 8. Provider-adapter conventions (LLM)

- Implement `LlmProvider` from `src/providers/llm/types.ts`; register it in
  `factory.ts`. That is the whole integration — no domain code changes.
- `mock` is the default and must stay fully functional and deterministic. It is
  what dev, seed demos, and CI use.
- **Never add a fallback from mock to a paid provider**, and never construct a
  paid provider because a key happens to be present. Selection is explicit via
  `LLM_PROVIDER` only.
- Respect `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`, `LLM_MAX_OUTPUT_TOKENS`.
- All output passes through `runStructured()` and a Zod schema. Never persist an
  unvalidated model response.
- Record provider, model, latency, request id. Never record prompt contents by
  default.
- Paid providers must surface a warning in the administration screen.

## 9. Source-adapter conventions

- Implement `SourceAdapter` from `src/adapters/types.ts` and register it in
  `src/adapters/registry.ts`.
- Ship a **deterministic fixture implementation**. Fixtures are the default and
  the only thing tests use.
- A live implementation is permitted **only** for stable, open APIs that need no
  institutional agreement — currently Crossref and PubMed. Everything else
  (ORCID, patents, licensing boards, registrars, employers, competition
  organizers) ships as interface + fixture + a documented integration
  placeholder describing what production access requires.
- Gate live calls behind `ENABLE_LIVE_SOURCES` and send the configured contact
  address in the User-Agent. Cache per `LIVE_SOURCE_CACHE_TTL_SECONDS` and
  respect published rate limits.
- Adapters return `RECORD_NOT_FOUND` when a source holds no record and
  `NO_MATCH` only when the source holds a record that says something different.
  Conflating these is a serious bug: only `NO_MATCH` may become conflicting
  evidence.
- Adapters never assign statuses. They return `SourceCheckResult` plus an
  excerpt, URL, retrieval time, and authority level.

---

## 10. Pull-request expectations

- One coherent change per PR. Migrations, domain rules, and UI for a single
  feature may travel together; unrelated refactors may not.
- `npm run verify` passes locally before opening.
- The PR body states: what changed, why, which invariants in this file the
  change touches, and how a reviewer can exercise it.
- Any change to status transitions, prioritization inputs, RBAC, redaction,
  adapter result semantics, or the human-review boundary must call that out
  explicitly and include tests.
- No secrets, no real personal data, no real applicant documents — fixtures are
  fictional and must stay fictional.
- Update `README.md` when setup changes and `LIMITATIONS.md` when a new
  limitation, heuristic, or failure mode is introduced.

---

## 11. Definition of done

A change is done when all of the following hold:

1. `npm run verify` passes: format, lint, strict typecheck, Prisma validate,
   unit + integration tests, production build.
2. Migrations apply cleanly to an empty database, and `npm run db:seed`
   succeeds.
3. New domain rules have unit tests, including a false-positive case.
4. New adapters pass the shared contract test.
5. Authorization changes have a tenant-isolation test.
6. The app runs with `LLM_PROVIDER=mock` and no API keys.
7. The reviewer flow and, when touched, the applicant portal flow are exercised
   in a browser.
8. Nothing in the diff produces or implies a consequential decision about a
   person.
9. Documentation reflects reality — including what does not work yet.

---

## 12. Before production use

This is an MVP. Legal, privacy, security, and fairness review are required
before it touches a real applicant. Integrations with registrars, employers,
licensing boards, and competition organizers require written agreements,
credentials, and jurisdiction-specific data-protection analysis. See
`LIMITATIONS.md`, which is not optional reading.
