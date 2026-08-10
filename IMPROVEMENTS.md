# Improvement backlog

Working state for the improvement loop. Ordered by value, highest first.

**Working agreement for each item:** implement it, add tests that would fail
without it, run `npm run verify` and the Playwright suite, then commit and push.
Move the item to _Done_ with a one-line note on what was actually verified. If an
item turns out to be a bad idea on closer inspection, move it to _Rejected_ with
the reason — an honest "no" is a valid outcome and better than a low-value
feature.

**Never** implement anything that crosses the product boundaries in `AGENTS.md`
§1, however convenient it looks: no risk scores, no automated conclusions, no
inference about a person, no treating absence of evidence as evidence.

---

## Now

### 1. Interview workspace UI — closes a spec gap

`src/modules/interviews.ts` generates questions and records scorecards, and the
seed creates an interview, but there is **no reviewer screen**. The feature is
unreachable in the product.

- Route `cases/[id]/interviews`: list, generate for a claim, conduct, score.
- Scorecard: per question, one of `CORROBORATES` / `PARTIALLY_CORROBORATES` /
  `DOES_NOT_ADDRESS` / `NOT_ASKED`, plus notes.
- Must show the "what a corroborating answer shows" text — the point is to help
  a reviewer judge substance, not to score the person.
- Conclusion is required before `humanReviewed` can be set. No aggregate score:
  a number invites treating a conversation as a verdict.
- Surface interviews in the report.

### 2. Reviewer notes UI — closes a spec gap

`ReviewerNote` is modelled and required by the spec but never surfaced. Add
per-case notes with author and timestamp, visible on the case overview, included
in the report, and audited on create.

### 3. Automated accessibility audit

The README claims WCAG 2.1 AA. That claim is currently unverified by any tool.
Add `@axe-core/playwright`, assert zero serious/critical violations across
login, dashboard, case overview, claims, report, and the applicant portal, and
fix whatever it finds. If a violation cannot be fixed, document it rather than
weakening the assertion.

### 4. Retention enforcement job

Rules are stored and displayed but never applied — the strongest data-protection
claim in the README is currently aspirational. Implement a job that, for closed
cases past their window, deletes original documents (keeping claims, evidence,
and audit) or anonymises the applicant. Dry-run mode, audit every action, tests
for each rule type.

## Next

### 5. Rule calibration telemetry

Track how often each `ruleKey` is resolved as `DISMISSED_NOT_AN_ISSUE` vs
`RESOLVED`/`EXPLAINED`, and surface per-rule false-positive rates in admin. Lets
an organisation see which detection rules misfire on _their_ population. Feeds
the fairness audit that production use will require.

### 6. Source-coverage fairness metrics

Per-case and per-organisation: what share of claims reached `UNABLE_TO_VERIFY`
purely because no adapter covered them. Makes the coverage gap described in
`LIMITATIONS.md` §1 measurable instead of merely acknowledged.

### 7. Continuous worker process

`npm run worker` running `drainQueue` on an interval with graceful shutdown, so
verification does not depend on someone clicking a button.

### 8. Applicant appeal channel

Distinct from clarification: an applicant-initiated request to revisit a
recorded outcome, routed to a reviewer who did not make the original decision.

## Later

### 9. OCR via local Tesseract

Keeps applicant documents on-host, unlike a cloud document-AI service. Currently
a scanned transcript silently yields no claims.

### 10. Extraction quality for awkward layouts

Multi-column CVs, tables, and free-form prose extract poorly under the
deterministic mock. Improve the rule-based extractor and add fixtures.

### 11. MFA for reviewers

TOTP enrolment and verification.

### 12. Live ORCID behind applicant-authenticated iD

Only meaningful with an OAuth step that has the applicant supply their own iD;
name matching alone risks attaching the wrong person's record.

---

## Done

_(nothing yet)_

## Rejected

_(nothing yet)_
