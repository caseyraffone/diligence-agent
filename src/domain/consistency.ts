import { ClaimCategory, DiscrepancyKind, DiscrepancySeverity, SourceCheckResult } from '@prisma/client';
import { rangeOverlap, toRange, type DateRange, type Precision, formatRange } from '@/lib/dates';
import { organizationsMatch, titlesMatch, normalizeText, similarity, organizationKey } from '@/lib/text';

/**
 * MODULE 3 (rules) — CONSISTENCY AND DOCUMENT INTEGRITY ANALYST
 *
 * Pure, deterministic detection. No database, no model, no I/O — so every rule
 * is unit-testable and every finding is explainable by pointing at the rule.
 *
 * The governing principle is that a finding is an OBSERVATION, phrased as
 * "these two documents say different things", never "the applicant lied". Each
 * rule states what was observed, why it merits a look, and what benign
 * explanations exist. The benign explanations are not decoration: they are the
 * difference between a tool that helps a reviewer think and one that primes
 * them to convict.
 *
 * False-positive suppression is a first-class concern and is tested:
 *  - coarse date precision never produces an overlap finding;
 *  - a student working during a degree is not an overlap;
 *  - a renamed or translated organisation is not a mismatch;
 *  - an award with no online record is not an inconsistency.
 */

export interface AnalyzableClaim {
  id: string;
  documentId: string;
  documentName: string;
  documentKind: string;
  pageNumber: number;
  category: ClaimCategory;
  normalizedText: string;
  sourcePassage: string;
  organizationName: string | null;
  title: string | null;
  startDate: Date | null;
  endDate: Date | null;
  datePrecision: Precision;
  isFullTimeCommitment: boolean;
  amountValue: number | null;
  amountUnit: string | null;
}

export interface AnalyzableDocument {
  id: string;
  filename: string;
  kind: string;
  sha256: string;
  /** Full text, used for the recommendation-letter support rule. */
  text: string;
  metadata: Record<string, unknown>;
}

export interface AnalyzableSourceCheck {
  claimId: string;
  adapterKey: string;
  result: SourceCheckResult;
  excerpt: string | null;
  detail: string;
}

export interface ConsistencyInput {
  claims: AnalyzableClaim[];
  documents: AnalyzableDocument[];
  sourceChecks: AnalyzableSourceCheck[];
  /** Evaluation date, injected so tests are stable. */
  asOf?: Date;
}

export interface Finding {
  ruleKey: string;
  kind: DiscrepancyKind;
  severity: DiscrepancySeverity;
  title: string;
  /** Neutral: what was observed, why it merits review, benign explanations. */
  description: string;
  claimIds: string[];
  documentIds: string[];
}

/** Overlap shorter than this is treated as rounding, not a conflict. */
const MIN_OVERLAP_DAYS = 45;

export function analyzeConsistency(input: ConsistencyInput): Finding[] {
  const asOf = input.asOf ?? new Date();
  return [
    ...detectDuplicateDocuments(input.documents),
    ...detectDateConflicts(input.claims),
    ...detectTitleMismatches(input.claims),
    ...detectFullTimeOverlaps(input.claims, asOf),
    ...detectAwardLevelInconsistencies(input.claims),
    ...detectResearchDivergence(input.claims),
    ...detectArithmeticInconsistencies(input.claims, asOf),
    ...detectUnsupportedByRecommendation(input.claims, input.documents),
    ...detectSourceConflicts(input.claims, input.sourceChecks),
    ...detectDocumentAnomalies(input.documents),
  ];
}

// ---------------------------------------------------------------- helpers

function rangeOf(claim: AnalyzableClaim): DateRange {
  return toRange(claim.startDate, claim.endDate, claim.datePrecision);
}

/** Groups claims that plausibly describe the same engagement. */
function groupByOrganization(claims: AnalyzableClaim[]): Map<string, AnalyzableClaim[]> {
  const groups = new Map<string, AnalyzableClaim[]>();
  for (const claim of claims) {
    if (!claim.organizationName) continue;
    const key = organizationKey(claim.organizationName);
    const list = groups.get(key);
    if (list) list.push(claim);
    else groups.set(key, [claim]);
  }
  return groups;
}

const BENIGN_DATE_EXPLANATIONS =
  'Differences of this kind commonly arise from a contract-to-permanent conversion, an offer date versus a start ' +
  'date, a rounded month, an academic term versus a calendar period, or one document being written later than the ' +
  'other.';

// ---------------------------------------------------------------- rules

export function detectDuplicateDocuments(documents: AnalyzableDocument[]): Finding[] {
  const byHash = new Map<string, AnalyzableDocument[]>();
  for (const doc of documents) {
    const list = byHash.get(doc.sha256);
    if (list) list.push(doc);
    else byHash.set(doc.sha256, [doc]);
  }

  const findings: Finding[] = [];
  for (const [hash, docs] of byHash) {
    if (docs.length < 2) continue;
    findings.push({
      ruleKey: `duplicate-document:${hash.slice(0, 12)}`,
      kind: DiscrepancyKind.DUPLICATE_DOCUMENT,
      severity: DiscrepancySeverity.INFORMATIONAL,
      title: `${docs.length} uploaded files have identical contents`,
      description:
        `These files are byte-for-byte identical: ${docs.map((d) => d.filename).join(', ')}. ` +
        'This is usually an accidental re-upload or the same document submitted through two channels. ' +
        'It is recorded so claims are not double-counted, and needs no action beyond noting it.',
      claimIds: [],
      documentIds: docs.map((d) => d.id),
    });
  }
  return findings;
}

export function detectDateConflicts(claims: AnalyzableClaim[]): Finding[] {
  const findings: Finding[] = [];

  for (const [, group] of groupByOrganization(claims)) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;

        // Only compare claims that describe the same kind of engagement and
        // came from different documents — one document restating itself is not
        // a cross-document inconsistency.
        if (a.category !== b.category) continue;
        if (a.documentId === b.documentId) continue;
        if (!a.startDate || !b.startDate) continue;

        // Coarse precision cannot support a date-conflict finding.
        if (a.datePrecision === 'YEAR' || b.datePrecision === 'YEAR') continue;
        if (a.datePrecision === 'UNKNOWN' || b.datePrecision === 'UNKNOWN') continue;

        const deltaDays = Math.abs(a.startDate.getTime() - b.startDate.getTime()) / 86_400_000;
        if (deltaDays <= 31) continue;

        findings.push({
          ruleKey: `date-conflict:${[a.id, b.id].sort().join(':')}`,
          kind: DiscrepancyKind.CONFLICTING_DATES,
          severity: DiscrepancySeverity.REVIEW_SUGGESTED,
          title: `Different start dates for ${a.organizationName} across two documents`,
          description:
            `"${a.documentName}" (page ${a.pageNumber}) states ${formatRange(rangeOf(a))}, while ` +
            `"${b.documentName}" (page ${b.pageNumber}) states ${formatRange(rangeOf(b))}. ` +
            `The stated start dates differ by about ${Math.round(deltaDays)} days. ${BENIGN_DATE_EXPLANATIONS} ` +
            'Asking the applicant is usually the fastest way to resolve it.',
          claimIds: [a.id, b.id],
          documentIds: [a.documentId, b.documentId],
        });
      }
    }
  }
  return findings;
}

export function detectTitleMismatches(claims: AnalyzableClaim[]): Finding[] {
  const findings: Finding[] = [];

  for (const [, group] of groupByOrganization(claims)) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        if (a.documentId === b.documentId) continue;
        if (a.category !== ClaimCategory.EMPLOYMENT || b.category !== ClaimCategory.EMPLOYMENT) continue;
        if (!a.title || !b.title) continue;
        if (titlesMatch(a.title, b.title)) continue;

        findings.push({
          ruleKey: `title-mismatch:${[a.id, b.id].sort().join(':')}`,
          kind: DiscrepancyKind.TITLE_MISMATCH,
          severity: DiscrepancySeverity.REVIEW_SUGGESTED,
          title: `Different job titles for ${a.organizationName} across two documents`,
          description:
            `"${a.documentName}" states the title "${a.title}"; "${b.documentName}" states "${b.title}". ` +
            'A promotion, an internal title differing from the external one, a team rename, or simply describing a ' +
            'role in everyday language rather than its formal title all produce this. Confirming the title history ' +
            'with the employer, or asking the applicant, normally settles it.',
          claimIds: [a.id, b.id],
          documentIds: [a.documentId, b.documentId],
        });
      }
    }
  }
  return findings;
}

/**
 * Two simultaneous full-time commitments.
 *
 * Heavily guarded against false positives, because this rule is the one most
 * likely to punish an ordinary life:
 *  - education never counts, since working while studying is normal;
 *  - anything marked part-time, advisory, or volunteer is excluded upstream;
 *  - month-or-coarser ranges that overlap only briefly are ambiguous, not
 *    conflicting;
 *  - the overlap must exceed 45 days.
 */
export function detectFullTimeOverlaps(claims: AnalyzableClaim[], asOf: Date): Finding[] {
  const eligible = claims.filter(
    (c) =>
      c.isFullTimeCommitment &&
      (c.category === ClaimCategory.EMPLOYMENT || c.category === ClaimCategory.RESEARCH_POSITION) &&
      c.startDate !== null,
  );

  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i]!;
      const b = eligible[j]!;

      // The same engagement described in two documents is not an overlap.
      if (a.organizationName && b.organizationName && organizationsMatch(a.organizationName, b.organizationName)) {
        continue;
      }

      const overlap = rangeOverlap(rangeOf(a), rangeOf(b), asOf);
      if (!overlap.overlaps) continue;
      if (overlap.ambiguousDueToPrecision) continue;
      if (overlap.days < MIN_OVERLAP_DAYS) continue;

      const key = [a.id, b.id].sort().join(':');
      if (seen.has(key)) continue;
      seen.add(key);

      findings.push({
        ruleKey: `full-time-overlap:${key}`,
        kind: DiscrepancyKind.OVERLAPPING_FULL_TIME_COMMITMENT,
        severity: DiscrepancySeverity.REVIEW_SUGGESTED,
        title: `Two full-time commitments appear to overlap by about ${overlap.days} days`,
        description:
          `"${a.title ?? 'Role'}" at ${a.organizationName ?? 'an unnamed organisation'} (${formatRange(rangeOf(a))}) ` +
          `and "${b.title ?? 'Role'}" at ${b.organizationName ?? 'an unnamed organisation'} (${formatRange(rangeOf(b))}) ` +
          'were both described in terms that suggest a full-time commitment. Overlaps like this are frequently ' +
          'legitimate: notice periods, gardening leave, part-time or reduced hours that the document did not spell ' +
          'out, consulting alongside a main role, or a role that was remote and flexible. The dates may also simply ' +
          'be rounded. This is a question to ask, not a conclusion.',
        claimIds: [a.id, b.id],
        documentIds: [a.documentId, b.documentId],
      });
    }
  }
  return findings;
}

const AWARD_LEVELS: Array<{ re: RegExp; rank: number; label: string }> = [
  { re: /\b(first place|1st place|winner|champion|gold)\b/i, rank: 1, label: 'first place' },
  { re: /\b(second place|2nd place|runner[- ]up|silver)\b/i, rank: 2, label: 'second place' },
  { re: /\b(third place|3rd place|bronze)\b/i, rank: 3, label: 'third place' },
  { re: /\b(finalist|national finalist)\b/i, rank: 4, label: 'finalist' },
  { re: /\b(semi-?finalist)\b/i, rank: 5, label: 'semi-finalist' },
  { re: /\b(honou?rable mention|participant|competitor)\b/i, rank: 6, label: 'honourable mention or participant' },
];

function awardLevel(text: string): { rank: number; label: string } | null {
  for (const level of AWARD_LEVELS) {
    if (level.re.test(text)) return { rank: level.rank, label: level.label };
  }
  return null;
}

export function detectAwardLevelInconsistencies(claims: AnalyzableClaim[]): Finding[] {
  const awards = claims.filter((c) => c.category === ClaimCategory.AWARD_COMPETITION);
  const findings: Finding[] = [];

  for (const [, group] of groupByOrganization(awards)) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        if (a.documentId === b.documentId) continue;

        const la = awardLevel(`${a.normalizedText} ${a.sourcePassage}`);
        const lb = awardLevel(`${b.normalizedText} ${b.sourcePassage}`);
        if (!la || !lb || la.rank === lb.rank) continue;

        findings.push({
          ruleKey: `award-level:${[a.id, b.id].sort().join(':')}`,
          kind: DiscrepancyKind.AWARD_LEVEL_INCONSISTENCY,
          severity: DiscrepancySeverity.REVIEW_REQUIRED,
          title: `The same award is described at two different levels`,
          description:
            `"${a.documentName}" describes this as ${la.label}; "${b.documentName}" describes it as ${lb.label}. ` +
            'Competitions often have several tiers — a regional round and a national final, a team result and an ' +
            'individual one — and a document may be describing a different tier rather than the same one differently. ' +
            'The organiser’s published results are the authoritative source here.',
          claimIds: [a.id, b.id],
          documentIds: [a.documentId, b.documentId],
        });
      }
    }
  }
  return findings;
}

export function detectResearchDivergence(claims: AnalyzableClaim[]): Finding[] {
  const research = claims.filter((c) => c.category === ClaimCategory.RESEARCH_POSITION);
  const findings: Finding[] = [];

  for (const [, group] of groupByOrganization(research)) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        if (a.documentId === b.documentId) continue;

        const sim = similarity(normalizeText(a.sourcePassage), normalizeText(b.sourcePassage));
        // Only flag when the two descriptions share almost nothing. Summaries
        // written for different audiences legitimately differ a great deal.
        if (sim >= 0.25) continue;

        findings.push({
          ruleKey: `research-divergence:${[a.id, b.id].sort().join(':')}`,
          kind: DiscrepancyKind.RESEARCH_DESCRIPTION_DIVERGENCE,
          severity: DiscrepancySeverity.INFORMATIONAL,
          title: `The same research position is described very differently in two documents`,
          description:
            `"${a.documentName}" describes it as: "${truncate(a.sourcePassage, 220)}". ` +
            `"${b.documentName}" describes it as: "${truncate(b.sourcePassage, 220)}". ` +
            'Descriptions written for different audiences, or at different times as a project evolved, routinely ' +
            'diverge. A structured conversation about the work is a better way to understand the contribution than ' +
            'comparing summaries.',
          claimIds: [a.id, b.id],
          documentIds: [a.documentId, b.documentId],
        });
      }
    }
  }
  return findings;
}

/**
 * Arithmetic that does not fit the stated period — e.g. more volunteer hours
 * than there are hours in the range.
 */
export function detectArithmeticInconsistencies(claims: AnalyzableClaim[], asOf: Date): Finding[] {
  const findings: Finding[] = [];

  for (const claim of claims) {
    if (claim.amountValue === null || !claim.amountUnit) continue;
    if (!/hours?/.test(claim.amountUnit)) continue;
    if (!claim.startDate) continue;

    const end = claim.endDate ?? asOf;
    const days = Math.max(1, (end.getTime() - claim.startDate.getTime()) / 86_400_000);
    // A generous ceiling: 16 waking hours every single day of the period.
    const maxPlausible = days * 16;
    if (claim.amountValue <= maxPlausible) continue;

    findings.push({
      ruleKey: `arithmetic:${claim.id}`,
      kind: DiscrepancyKind.ARITHMETIC_INCONSISTENCY,
      severity: DiscrepancySeverity.REVIEW_SUGGESTED,
      title: 'A stated hour total exceeds the hours available in the stated period',
      description:
        `The claim states ${claim.amountValue.toLocaleString('en-US')} ${claim.amountUnit} over a period of about ` +
        `${Math.round(days)} days, which allows at most ${Math.round(maxPlausible).toLocaleString('en-US')} hours ` +
        'even at 16 hours every day. The most common causes are a typo, hours recorded for a whole team rather than ' +
        'one person, or a date range that was stated more narrowly than the actual activity. Worth confirming the ' +
        'basis of the figure.',
      claimIds: [claim.id],
      documentIds: [claim.documentId],
    });
  }
  return findings;
}

/**
 * A significant claim that a recommendation letter, which plausibly would have
 * mentioned it, does not.
 *
 * Severity is INFORMATIONAL by design. Letter writers omit things constantly —
 * they write about what they personally observed, and they have a word limit.
 * Absence from a letter is weak signal and is presented that way.
 */
export function detectUnsupportedByRecommendation(
  claims: AnalyzableClaim[],
  documents: AnalyzableDocument[],
): Finding[] {
  const letters = documents.filter((d) => d.kind === 'RECOMMENDATION_LETTER');
  if (letters.length === 0) return [];

  const corpus = normalizeText(letters.map((l) => l.text).join('\n'));
  const findings: Finding[] = [];

  const notable = claims.filter(
    (c) =>
      (c.category === ClaimCategory.RESEARCH_POSITION || c.category === ClaimCategory.AWARD_COMPETITION) &&
      c.organizationName !== null,
  );

  for (const claim of notable) {
    const org = normalizeText(claim.organizationName!);
    if (!org) continue;
    // Match on any distinctive word from the organisation name.
    const tokens = org.split(' ').filter((t) => t.length >= 5);
    const mentioned = tokens.some((t) => corpus.includes(t));
    if (mentioned) continue;

    findings.push({
      ruleKey: `unsupported-by-letter:${claim.id}`,
      kind: DiscrepancyKind.UNSUPPORTED_BY_RECOMMENDATION,
      severity: DiscrepancySeverity.INFORMATIONAL,
      title: `Recommendation letters do not mention ${claim.organizationName}`,
      description:
        `The claim "${truncate(claim.normalizedText, 200)}" is not referred to in any recommendation letter on file. ` +
        'This is very weak signal and is shown only for completeness. Referees write about what they personally ' +
        'saw, often within a length limit, and a referee from a different context would have no reason to mention ' +
        'this at all. It should not be treated as an inconsistency.',
      claimIds: [claim.id],
      documentIds: letters.map((l) => l.id),
    });
  }
  return findings;
}

/** A source that holds a record stating something different. */
export function detectSourceConflicts(claims: AnalyzableClaim[], checks: AnalyzableSourceCheck[]): Finding[] {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const findings: Finding[] = [];

  for (const check of checks) {
    const claim = byId.get(check.claimId);
    if (!claim) continue;

    // ONLY NO_MATCH. RECORD_NOT_FOUND, SOURCE_UNAVAILABLE, INCONCLUSIVE, and
    // ERROR are evidence gaps and must never create a discrepancy.
    if (check.result !== SourceCheckResult.NO_MATCH) continue;

    const isPublication = claim.category === ClaimCategory.PUBLICATION;
    findings.push({
      ruleKey: `source-conflict:${claim.id}:${check.adapterKey}`,
      kind: isPublication ? DiscrepancyKind.PUBLICATION_AUTHORSHIP_DISCREPANCY : DiscrepancyKind.CLAIM_SOURCE_CONFLICT,
      severity: DiscrepancySeverity.REVIEW_REQUIRED,
      title: `A source record differs from the claim`,
      description:
        `The claim states: "${truncate(claim.normalizedText, 200)}". ` +
        `${check.adapterKey} holds a record that says something different. ${check.detail}` +
        (check.excerpt ? ` Quoted from the source: "${truncate(check.excerpt, 300)}"` : '') +
        ' Before drawing any conclusion, confirm that the record refers to the same person and the same event, and ' +
        'give the applicant an opportunity to respond — published records do contain errors, and are sometimes ' +
        'corrected after the fact.',
      claimIds: [claim.id],
      documentIds: [claim.documentId],
    });
  }
  return findings;
}

/**
 * Observable file/metadata oddities.
 *
 * This rule exists to route a human to look at the original document. It never
 * concludes anything. Fonts, spacing, producer strings, and modification dates
 * cannot establish that a document was altered — see LIMITATIONS.md.
 */
export function detectDocumentAnomalies(documents: AnalyzableDocument[]): Finding[] {
  const findings: Finding[] = [];

  for (const doc of documents) {
    const observations: string[] = [];

    const created = String(doc.metadata['creationDate'] ?? '');
    const modified = String(doc.metadata['modificationDate'] ?? '');
    if (created && modified && created !== modified) {
      observations.push(
        `The file records a creation timestamp (${created}) that differs from its modification timestamp (${modified}).`,
      );
    }

    const producer = String(doc.metadata['producer'] ?? '');
    if (producer && /(word|pages|docs|writer|libre)/i.test(producer) && doc.kind === 'TRANSCRIPT') {
      observations.push(
        `The file reports that it was produced by "${producer}", which is word-processing software rather than a ` +
          'records system.',
      );
    }

    if (doc.metadata['hasTextLayer'] === false) {
      observations.push('The file contains no extractable text layer, which is typical of a scan or a photograph.');
    }

    if (observations.length === 0) continue;

    findings.push({
      ruleKey: `document-anomaly:${doc.id}`,
      kind: DiscrepancyKind.DOCUMENT_ANOMALY,
      severity: DiscrepancySeverity.INFORMATIONAL,
      title: `Observations about the file "${doc.filename}"`,
      description:
        `${observations.join(' ')} ` +
        'These are properties of the file, not findings about its contents. Every one of them has ordinary causes: ' +
        'documents are re-saved, scanned, exported, converted, watermarked, and re-issued as a matter of routine, ' +
        'and many institutions genuinely produce letters in word processors. None of this can establish that a ' +
        'document was altered. It is recorded so a reviewer can open the original if they wish, and so that the ' +
        'basis for any concern is visible rather than implied.',
      claimIds: [],
      documentIds: [doc.id],
    });
  }
  return findings;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
