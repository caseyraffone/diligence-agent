# LIMITATIONS

Read this before using Credential Integrity Agent on a real application. It is
not a disclaimer appended for form's sake — it describes what this software
cannot do, and the specific ways a reasonable person could misread its output to
someone's serious detriment.

The system's purpose is to help a trained reviewer look in the right places. It
is not an oracle, and several of the things it surfaces look far more conclusive
than they are.

---

## 1. Why missing evidence cannot establish that a claim is false

This is the single most important limitation in the product.

When the system reports **Unable to verify**, it means: _we queried the sources
available to us and none of them held a record._ That is a statement about our
search, not about the applicant.

Records are legitimately absent for many reasons:

- **Most achievements are not in any queryable database.** School prizes, local
  competitions, internal recognition at a company, volunteer coordination, most
  student research — none of this has a registry.
- **Older records go offline.** Competition results pages are taken down at the
  end of a season. Small organisations fold, rebrand, or lose their archives.
  Sports rosters are routinely replaced each year.
- **Many registries are closed.** Registrars, licensing boards, and employers
  answer authorised requests, not automated queries. Their silence to a machine
  is not silence to a person with a signed authorisation.
- **Coverage is geographically and linguistically uneven.** A verification stack
  built around English-language, US and EU sources will fail more often for
  applicants from elsewhere. That failure is a property of our source list, and
  it does not fall evenly across applicants — which makes treating absence as
  signal actively discriminatory in effect, whatever the intent.
- **Names do not match cleanly.** Transliteration, name changes, patronymics,
  ordering conventions, and diacritics all break naive matching.
- **The record exists but is not indexed.** Publications outside Crossref/PubMed,
  patents within the 18-month pre-publication window, and paywalled or
  print-only sources are all invisible to us.

The software enforces this distinction structurally rather than trusting anyone
to remember it:

- Adapters return `RECORD_NOT_FOUND` when a source holds nothing, and `NO_MATCH`
  only when a source holds a record that says something different. Only
  `NO_MATCH` can become conflicting evidence. A shared contract test asserts
  this for every adapter, including any added later.
- Absence results become **neutral system observations**, never conflicting
  evidence.
- `UNABLE_TO_VERIFY` is not terminal — a claim can move from it to `VERIFIED`
  the moment authoritative evidence arrives, and there is a test proving an
  obscure achievement can make exactly that journey.

**What this means for you:** a case full of "unable to verify" claims tells you
your source coverage is poor for this applicant. It tells you nothing about
their honesty. Treating it as a negative signal will systematically penalise
applicants from under-covered backgrounds.

---

## 2. Why document "anomalies" cannot establish forgery

The system reports observable properties of uploaded files: differing creation
and modification timestamps, a producer string naming word-processing software,
the absence of a text layer, byte-identical duplicates.

**None of these can establish that a document was altered or fabricated.**

Every one has ordinary causes that are overwhelmingly more common than forgery:

- Documents are re-saved, re-exported, converted between formats, compressed,
  watermarked, redacted, and re-issued as a matter of routine administration.
- Scanning or photographing a paper document removes the text layer and rewrites
  every timestamp. Applicants without a scanner photograph documents with a
  phone — which is a proxy for resources, not for honesty.
- Plenty of legitimate institutions genuinely produce letters and even
  transcripts in Microsoft Word.
- A document emailed, downloaded, and re-uploaded may pass through several
  systems that each touch its metadata.
- Timestamps are trivially editable, so their _absence_ of oddity proves nothing
  either. A competent forger would produce clean metadata; the signals here are
  the ones a careless person leaves, not the ones a determined one does.

Accordingly, every document observation in this system is `INFORMATIONAL`
severity, is worded as a property of the file rather than a finding about its
contents, and states its benign explanations inline. A test asserts that no
generated description contains accusatory language.

**Deliberately not implemented:** pixel-level image forensics, error-level
analysis, font-consistency scoring, signature comparison, and any "document
authenticity score". These techniques have high false-positive rates on ordinary
documents, are not robust to routine processing, and produce numbers that read as
authoritative to a reviewer who cannot evaluate them. If document authenticity is
genuinely in question, the answer is to ask the issuing organisation.

---

## 3. Why AI-detection output is not admissible as evidence here

There is no AI-writing detector in this product, and one should not be added.

Current detectors have false-positive rates that make them unusable for
consequential decisions, and — critically — those errors are **not randomly
distributed**. Published evaluations have repeatedly found that text by non-native
English writers is flagged at substantially higher rates than text by native
writers. Deploying such a detector in admissions or hiring would build a
disparate-impact problem directly into the workflow.

Beyond accuracy: a personal statement written with a spell-checker, a grammar
assistant, a writing centre tutor, or a parent's editing help is not
misconduct, and no detector can distinguish those cases from the one you might
care about. There is no threshold at which a probability score from such a tool
becomes fair grounds for an adverse inference about a specific person.

If authorship of written work matters to your process, ask about the work
directly. The interview module exists for exactly this: questions about the
problem, the decisions, the failures, and the tradeoffs are answerable by
someone who did the work and are not answerable from a summary.

---

## 4. Why model confidence is not evidence

Every extracted claim carries an `extractionConfidence` value. It means: _how
confident the extractor is that it read and structured this passage correctly._

It is **not**:

- a probability that the claim is true,
- a measure of the applicant's honesty,
- a risk score,
- an input to any status, priority, or ranking.

A low value means the text was hard to parse — an unusual layout, an OCR
failure, an ambiguous line — and that a human should check the extraction
against the original page. Nothing more.

More generally, language models produce fluent, confident text regardless of
whether they are correct. A model's certainty about a statement carries no
information about the world. That is why, in this system, the model can never
write a verification status: its output schemas contain no field for one, so an
invalid, hallucinated, or prompt-injected response has nowhere to put a
conclusion. Only authoritative evidence and a named human reviewer can establish
a status.

---

## 5. Why an anonymous tip is never evidence

Tips are recorded as **unverified allegations** and cannot change any claim's
status. There is no code path from a tip to a `ClaimStatus`, by construction.

The reason is asymmetry: the subject of an allegation cannot answer something
they will never see, and cannot rebut a source that does not exist. Anonymous
channels attract malicious, competitive, retaliatory, and simply mistaken
submissions along with genuine ones, and nothing in the submission itself
distinguishes them.

Protections implemented:

- A tip cannot be marked "independently corroborated" unless the case already
  holds confirmed or third-party evidence — the allegation can never be its own
  corroboration.
- Duplicate submissions are suppressed by content hash, so repetition cannot
  manufacture the appearance of multiple sources.
- Rate limiting blunts campaigns against an individual.
- Submissions turning on a protected characteristic are closed as out of scope.
- Access is restricted to roles holding `tip:read`; tips are never shown to the
  applicant, and no submitter identity is collected at all.

**Residual risk:** a tip still directs reviewer attention, and attention is not
neutral. A reviewer who reads an allegation and then reviews a case will not
review it the same way. This product cannot fix that; your process needs to.

---

## 6. Fairness limitations

- **Source coverage is uneven and that unevenness is not random.** See §1. This
  is the most likely route to disparate impact in this system, and it operates
  even though no protected characteristic is stored or used anywhere.
- **Name matching is harder for some naming conventions than others.** The
  matcher is deliberately conservative and reports ambiguity as ambiguity, but
  "we could not confirm this is the same person" will occur more often for some
  applicants than others.
- **Prioritisation uses a closed input set** (evidence gaps, unresolved
  differences, due dates) and no protected characteristic or proxy is modelled
  anywhere in the schema. This prevents direct use. It does not prevent
  correlation: cases with poor source coverage will surface higher, and source
  coverage correlates with geography.
- **No fairness audit has been performed.** Before production use, measure
  outcome rates across applicant populations. The system cannot do this for you,
  and deliberately does not collect the demographic data that such an audit
  would require — that data collection is a separate, consciously-designed
  exercise with its own lawful basis, not something to bolt onto a case file.

---

## 7. Security limitations

- **The audit log makes tampering detectable, not impossible.** Events are
  hash-chained per organisation, so altering or deleting a row breaks
  verification. Someone with database write access could still rewrite the
  entire chain. Production needs append-only storage, off-host log shipping, or
  periodic external anchoring of the chain head.
- **No malware scanning by default.** `MALWARE_SCANNER=noop` does not scan and
  never reports a file as clean — it reports `UNSUPPORTED`. Configure a real
  scanner before accepting uploads from outside your organisation.
- **Password hashing uses scrypt**, not Argon2id. Both are memory-hard and
  appropriate; scrypt is built into Node and avoids a native dependency.
  Argon2id is marginally preferable if you are willing to add the module.
- **Rate limiting uses fixed windows**, which permit a burst at a window
  boundary. Adequate for login, tips, and portal submissions; not a substitute
  for an edge WAF.
- **Prompt-injection defence is layered, and the outermost layer is weak.** The
  structural defence — output schemas with no status, decision, or tool field —
  is strong and is what the tests actually rely on. The prompt instructions and
  the injection-pattern scan are supporting layers and can be evaded. Never add
  a capability that lets model output flow into a status, a policy, or a tool
  call.
- **The S3 storage driver is not implemented.** The local driver encrypts with
  AES-256-GCM using a single key from the environment; there is no key rotation,
  no per-tenant key separation, and no HSM/KMS integration.
- **Session management is single-factor.** No MFA, no device binding, no
  step-up authentication for high-impact actions such as report export.

---

## 8. Functional limitations of this MVP

- **Retention rules are stored and displayed but not enforced.** There is no
  scheduled job applying them. Deletion and anonymisation must currently be
  performed manually.
- **OCR is not implemented.** Images and scanned PDFs are accepted and recorded
  as requiring manual review; no claims are extracted from them. A scanned
  transcript will silently yield nothing without this being flagged as a
  verification gap in the report.
- **The background worker runs on demand**, triggered from the UI or a script,
  rather than continuously in a separate process.
- **No email transport exists anywhere**, by design. Outreach and clarification
  requests are drafted and approved in-app; a human sends them.
- **Only eight of the ten adapters are simulated.** Crossref and PubMed can run
  live; the rest serve recorded fixtures. See §9.
- **The deterministic mock extractor is rule-based** and handles conventional
  résumé structures well. Unusual layouts, tables, multi-column CVs, and
  free-form prose will extract poorly. This is what a real LLM provider is for —
  but it is also why every claim is editable and cites its source page.
- **No appeal workflow beyond correction.** Reviewers can revise any status and
  every decision is reversible, but there is no separate applicant-initiated
  appeal channel with its own reviewer assignment.

---

## 9. Integrations requiring agreements, credentials, or legal review

| Source                     | What production access actually requires                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Crossref**               | Nothing. Open API; send a contact address in the User-Agent. **Live-capable today.**                                                                                                                                                                    |
| **PubMed / NCBI**          | Nothing at low volume; an API key raises rate limits. Biomedical literature only. **Live-capable today.**                                                                                                                                               |
| **ORCID**                  | Applicant-authenticated ORCID iD via OAuth. Name-based matching is unreliable and risks attaching another person's record. Member API needs a client id/secret.                                                                                         |
| **University registrars**  | Per-institution agreement or a clearinghouse contract, plus documented consent for education-record disclosure. FERPA-governed in the US; needs an Article 6 basis in the EU/UK. No general public API exists.                                          |
| **Employers**              | A commercial verification service under contract, or direct human outreach. In the US, where this informs an employment decision it is likely a consumer report under the **FCRA**, bringing disclosure, authorisation, and adverse-action obligations. |
| **Licensing boards**       | Per-jurisdiction, per-profession. Many are HTML-only; some prohibit automated querying in their terms; a few charge. Check each board's terms individually.                                                                                             |
| **Patent offices**         | USPTO PatentsView (free key), EPO OPS (registration + key), WIPO. Inventor-name matching is genuinely hard. Applications are unpublished for ~18 months.                                                                                                |
| **Competition organisers** | No unified database. Per-organiser work, only where terms permit automated access. Do not build a generic scraper.                                                                                                                                      |
| **Athletic rosters**       | School, club, and federation sites; historical rosters are routinely deleted. Governing-body APIs generally require membership.                                                                                                                         |
| **Web archives**           | Wayback Machine has a public API. Coverage is uneven; a missing capture means nothing. Never use archives to reach content that was behind authentication.                                                                                              |
| **OCR**                    | A cloud document-AI service sends applicant documents to a third party: needs a data-processing agreement, a lawful basis, and disclosure in your privacy notice. Local Tesseract avoids this.                                                          |
| **Paid LLM providers**     | OpenAI/Anthropic receive applicant document text. Needs a DPA, a lawful basis, disclosure to applicants, and a decision about training-data usage. The `ollama` provider avoids sending data off-host entirely.                                         |

---

## 10. Legal and compliance review is required before production use

This software processes sensitive personal information and may inform decisions
with serious consequences for individuals. Before any real applicant's data
enters it, obtain review covering at least:

- **Lawful basis and consent** for each verification channel, per jurisdiction.
- **FCRA / background-screening law** where this informs employment decisions in
  the US — including the disclosure, authorisation, and adverse-action process.
- **FERPA** or the local equivalent for education records.
- **GDPR / UK GDPR**: lawful basis, data-protection impact assessment,
  international transfer mechanism, retention schedule, and the data-subject
  rights of access, rectification, erasure, and objection.
- **Automated decision-making rules.** This system is designed as
  decision-support specifically so that Article 22-type restrictions are not
  engaged — but that depends on your _process_ keeping a human meaningfully in
  the loop, not merely on this software's design. A reviewer who rubber-stamps
  every proposal has recreated the automated decision the design avoids.
- **Records-retention obligations** that may conflict with deletion rights.
- **Fairness testing** across applicant populations before and during use.

Nothing in this repository constitutes legal advice.
