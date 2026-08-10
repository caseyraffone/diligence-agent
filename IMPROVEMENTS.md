# Improvement backlog

Working state for the improvement loop, ordered by what actually blocks an
institutional buyer.

**Working agreement:** implement the item, add tests that would fail without it,
run `npm run verify` and the Playwright suite, then move it to _Done_ with a note
on what was verified, commit, and push. If an item turns out to be a bad idea on
closer inspection, move it to _Rejected_ with the reason — an honest "no" beats a
low-value feature.

**Never** cross the product boundaries in `AGENTS.md` §1, however commercially
tempting: no risk scores, no automated conclusions, no inference about a person,
no treating absence of evidence as evidence. A buyer who wants those wants a
different product, and selling it to them is how this becomes the thing it was
built not to be.

---

## Now — blocks a serious pilot

### 1. FCRA adverse-action workflow

**The single biggest legal gap for employment use.** In the US, where a
third-party report informs a hiring decision, the Fair Credit Reporting Act
requires a specific sequence: pre-adverse-action notice with a copy of the
report and a summary of rights, a waiting period for the applicant to dispute,
then an adverse-action notice. Reasonable procedures to assure maximum possible
accuracy (§607(b)) and a dispute-and-reinvestigation path (§611) are also
mandatory.

No US employer's counsel will approve a pilot without this. It is also entirely
on-mission — it is an applicant-protection mechanism, and the dispute path is a
stronger version of the appeal channel already contemplated below.

Build: notice templates per jurisdiction, enforced waiting period with a clock,
dispute intake, reinvestigation workflow that re-opens claims, and an audit
trail proving the sequence was followed.

### 2. SSO and directory integration

No institution provisions local passwords for a vendor tool. SAML 2.0 and OIDC
for login; SCIM for provisioning and — more importantly — **deprovisioning**,
which is what security review actually asks about. Keep local auth for
development and small tenants.

### 3. Reviewer notes UI — closes a spec gap

`ReviewerNote` is modelled and required by the spec but never surfaced. Add
per-case notes with author and timestamp, on the case overview, in the report,
audited on create.

### 4. Automated accessibility audit, then a VPAT

Harvard and most public institutions require a **VPAT / Accessibility
Conformance Report** at procurement. The README claims WCAG 2.1 AA and nothing
currently verifies it. Add `@axe-core/playwright`, assert zero serious/critical
violations across login, dashboard, case, claims, report, interviews, and the
applicant portal, fix what it finds, then draft the VPAT from real results.

### 5. Retention enforcement job

Rules are stored and displayed but never applied, which makes the strongest
data-protection claim in the README aspirational. Implement enforcement for
closed cases past their window: delete originals (keeping claims, evidence, and
audit) or anonymise the applicant. Dry-run mode, audit every action, tests per
rule type.

## Next — needed at institutional scale

### 6. Throughput and bulk intake

Harvard receives tens of thousands of applications per cycle; a large bank
receives hundreds of thousands. The current worker drains on demand from a
button. Needs: a long-running worker process with bounded concurrency, batch
case creation from CSV/JSONL, per-tenant rate control on outbound source calls,
backpressure, and a load test that establishes an honest cases-per-hour figure.

### 7. Data-subject rights endpoints

GDPR/UK GDPR access, rectification, erasure, and portability; CCPA equivalents.
Export a complete applicant record as JSON, and support erasure that preserves
the audit chain's integrity while removing personal data.

### 8. Rule calibration telemetry

Track how often each `ruleKey` is resolved as `DISMISSED_NOT_AN_ISSUE` versus
`RESOLVED`/`EXPLAINED`, and surface per-rule false-positive rates in admin. Lets
an institution see which rules misfire on _their_ population rather than on the
evaluation corpus.

### 9. Source-coverage fairness reporting

Per-organisation: what share of claims reached `UNABLE_TO_VERIFY` purely because
no adapter covered them, broken down by claim category and institution country.
Makes the coverage gap in `LIMITATIONS.md` §1 measurable. This is the metric a
disparate-impact review will ask for, and the one most likely to be
uncomfortable — which is exactly why it should exist.

### 10. Observability

Structured request logs with correlation ids, Prometheus-style metrics
(queue depth, adapter latency and error rate, time-to-verify), and an error
reporting hook. Security review asks how you would detect a breach; the honest
answer today is "you would not".

### 11. Applicant appeal channel

Distinct from clarification: an applicant-initiated request to revisit a
recorded outcome, routed to a reviewer who did not make the original decision.
Overlaps with the FCRA dispute path — build them together.

## Later

### 12. Expand the evaluation corpus to 50+ labelled cases

Twelve cases is enough to catch regressions, not enough to quote a
false-positive rate at a procurement committee. Add non-Latin scripts, name
changes, patronymics, non-US date formats, military service, caring gaps,
apprenticeships, and community-college transfers — the shapes most likely to
trip naive matching, and most likely to correlate with protected
characteristics.

### 13. ATS and SIS integrations

Slate (dominant in US admissions), Common App, Workday, Greenhouse, Lever. Each
is a connector plus a field-mapping UI. This is what makes the product
adoptable rather than another system to copy-paste into.

### 14. OCR via local Tesseract

Keeps documents on-host, unlike a cloud document-AI service. A scanned
transcript currently yields no claims.

### 15. Extraction quality for awkward layouts

Multi-column CVs, tables, and free-form prose extract poorly under the
deterministic mock. Improve the rule-based extractor and add corpus fixtures.

### 16. MFA for local accounts

TOTP enrolment and verification, for tenants not using SSO.

### 17. Live ORCID behind applicant-authenticated iD

Only meaningful with an OAuth step where the applicant supplies their own iD;
name matching alone risks attaching the wrong person's record.

---

## Cannot be solved by writing code

Listed so nobody mistakes a green test suite for commercial readiness:

- **SOC 2 Type II** — an audit over an observation window, with evidence
  collection, access reviews, and change management. Months, and an auditor.
- **Independent penetration test** and remediation.
- **Legal opinions** on FCRA (employment), FERPA (education records), and
  GDPR/UK GDPR, per jurisdiction of operation.
- **A signed VPAT**, typically from an accessibility firm rather than self-assessed.
- **Data-processing agreements** with every sub-processor, and cyber liability
  insurance.
- **Source agreements**: registrars, licensing boards, employers, competition
  organisers. Commercial negotiation, not engineering.
- **A fairness audit on real applicant populations**, which requires real data,
  a lawful basis, and an outside reviewer.

---

## Done

### 2. Labelled accuracy evaluation — done

12-case corpus with ground-truth labels and a harness reporting precision,
recall, and false-positive rate. Eight cases describe ordinary lives and carry a
`mustNotFlag` list, so a finding on them is scored as harm to an innocent
applicant. Thresholds are asymmetric: zero tolerance on false positives, 90%
floor on recall.

It found a real bug on first run: year-precision ranges like `(2020 - 2022)` and
`(2022 - 2024)` were flagged as 364 days of dual full-time employment. The
ambiguity guard now compares overlap against the measurement uncertainty of the
coarser range instead of a flat 31 days.

**Verified:** recall 100%, precision 100%, false-positive rate 0% over 12 cases;
251 tests total.

### 1. Interview workspace UI — done

Route `cases/[id]/interviews` with a case-nav tab: prepare a conversation for a
contribution claim, see all ten question areas alongside what a corroborating
answer would demonstrate, rate each answer, record a written conclusion.
Interviews now appear in the report.

Building it exposed a defect the module had hidden: questions interpolated the
stored claim verbatim, producing `What problem was Publication: "…" (DOI …)
trying to solve?`. `conversationSubject()` now strips the category prefix and
identifier parenthetical.

**Verified:** 10 integration tests (all ten areas covered, short conclusions
refused, no aggregate score field, audit names the reviewer, an interview alone
never moves a claim status) plus a browser test asserting the rating options
carry no credibility language.

## Rejected

### Scraping public résumés for testing

Proposed as a way to test against real data. Rejected on two grounds.

**It would not work.** Evaluating a verification system requires ground truth.
For a real person's résumé you do not know whether "Senior Engineer, 2019–2022"
is accurate, so nothing the system flags can be scored as a true or false
positive. You would produce anecdotes, not a measurement.

**It is the thing this product exists to refuse.** Collecting a real person's
career history without their knowledge or consent, to test software that judges
career histories, contradicts the consent gate the codebase enforces in code. It
would also breach the terms of every major professional network.

The labelled corpus is the correct instrument, and a stronger one.
