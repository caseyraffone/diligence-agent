# CLAUDE.md

**Read [`AGENTS.md`](./AGENTS.md) first and follow it.** It is the canonical
engineering document for this repository and is shared with OpenAI Codex and any
other coding agent. Everything about architecture, commands, testing, migrations,
security, human-review boundaries, adapter conventions, PR expectations, and the
definition of done lives there — not here.

This file holds only Claude Code operational notes that do not belong in the
shared document.

## Operational notes

- **Verify before claiming done.** Run `npm run verify`. Report the actual
  output. If a step fails, say so with the error rather than describing the
  change as complete.
- **The database is real.** `npm test` truncates `TEST_DATABASE_URL`. Confirm it
  points at a throwaway database before running the suite against an unfamiliar
  environment.
- **Never run `prisma migrate reset` against `DATABASE_URL`** without asking —
  it destroys seeded demonstration cases the user may be mid-review on.
- **Do not edit files under `prisma/migrations/`.** Generate a new migration.
- **`npm run dev` occupies port 3200.** Check for an existing dev server before
  starting another; two instances against one database produce confusing audit
  chains.
- When Playwright is needed, Chromium is preinstalled — do not run
  `playwright install`.

## Working style for this repository

- Prefer editing `domain/` and adding a unit test over adding logic to a route
  handler. If a rule cannot be unit-tested without a database, it is in the
  wrong layer.
- When a request would cross one of the product boundaries in `AGENTS.md`
  section 1 — a risk score, a recommendation, an automated status conclusion,
  an inference about a person — **stop and raise it** instead of implementing a
  softened version. Those boundaries are the product's reason for existing, not
  preferences to negotiate.
- Copy shown to reviewers is part of the safety design. Keep generated and
  static language neutral: describe what a source said, never what it proves
  about someone.
