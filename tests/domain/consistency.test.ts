import { describe, expect, it } from 'vitest';
import { ClaimCategory, DiscrepancyKind, SourceCheckResult } from '@prisma/client';
import {
  analyzeConsistency,
  detectArithmeticInconsistencies,
  detectAwardLevelInconsistencies,
  detectDateConflicts,
  detectDocumentAnomalies,
  detectDuplicateDocuments,
  detectFullTimeOverlaps,
  detectSourceConflicts,
  detectTitleMismatches,
  type AnalyzableClaim,
  type AnalyzableDocument,
} from '@/domain/consistency';

const AS_OF = new Date('2026-01-01T00:00:00Z');

function claim(overrides: Partial<AnalyzableClaim> & { id: string }): AnalyzableClaim {
  return {
    documentId: 'doc-a',
    documentName: 'resume.txt',
    documentKind: 'RESUME_CV',
    pageNumber: 1,
    category: ClaimCategory.EMPLOYMENT,
    normalizedText: 'A role at an organisation',
    sourcePassage: 'A role at an organisation',
    organizationName: 'Northwind Analytics',
    title: 'Software Engineer',
    startDate: new Date('2022-01-01'),
    endDate: new Date('2022-12-31'),
    datePrecision: 'DAY',
    isFullTimeCommitment: true,
    amountValue: null,
    amountUnit: null,
    ...overrides,
  };
}

function doc(overrides: Partial<AnalyzableDocument> & { id: string }): AnalyzableDocument {
  return { filename: 'f.txt', kind: 'RESUME_CV', sha256: 'hash', text: '', metadata: {}, ...overrides };
}

// ---------------------------------------------------------------- true positives

describe('genuine inconsistencies are surfaced', () => {
  it('flags conflicting start dates across two documents', () => {
    const findings = detectDateConflicts([
      claim({ id: 'a', documentId: 'doc-a', startDate: new Date('2021-03-15'), datePrecision: 'MONTH' }),
      claim({ id: 'b', documentId: 'doc-b', startDate: new Date('2021-06-14'), datePrecision: 'MONTH' }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe(DiscrepancyKind.CONFLICTING_DATES);
    // The description must offer benign explanations, not imply concealment.
    expect(findings[0]!.description).toMatch(/contract-to-permanent conversion/i);
  });

  it('flags differing job titles for the same employer', () => {
    const findings = detectTitleMismatches([
      claim({ id: 'a', documentId: 'doc-a', title: 'Senior Software Engineer' }),
      claim({ id: 'b', documentId: 'doc-b', title: 'Software Engineer' }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe(DiscrepancyKind.TITLE_MISMATCH);
    expect(findings[0]!.description).toMatch(/promotion/i);
  });

  it('flags two overlapping full-time roles at different employers', () => {
    const findings = detectFullTimeOverlaps(
      [
        claim({
          id: 'a',
          organizationName: 'Northwind Analytics',
          startDate: new Date('2022-01-01'),
          endDate: new Date('2022-12-31'),
        }),
        claim({
          id: 'b',
          organizationName: 'Helios Robotics',
          startDate: new Date('2022-03-01'),
          endDate: new Date('2022-11-30'),
        }),
      ],
      AS_OF,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe(DiscrepancyKind.OVERLAPPING_FULL_TIME_COMMITMENT);
  });

  it('flags the same award described at two different levels', () => {
    const findings = detectAwardLevelInconsistencies([
      claim({
        id: 'a',
        documentId: 'doc-a',
        category: ClaimCategory.AWARD_COMPETITION,
        organizationName: 'International Robotics Challenge',
        normalizedText: 'First Place at International Robotics Challenge',
      }),
      claim({
        id: 'b',
        documentId: 'doc-b',
        category: ClaimCategory.AWARD_COMPETITION,
        organizationName: 'International Robotics Challenge',
        normalizedText: 'Finalist at International Robotics Challenge',
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe(DiscrepancyKind.AWARD_LEVEL_INCONSISTENCY);
  });

  it('flags an hour total that cannot fit in the stated period', () => {
    const findings = detectArithmeticInconsistencies(
      [
        claim({
          id: 'a',
          category: ClaimCategory.QUANTITATIVE_METRIC,
          amountValue: 5000,
          amountUnit: 'hours',
          startDate: new Date('2024-01-01'),
          endDate: new Date('2024-02-01'),
        }),
      ],
      AS_OF,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.description).toMatch(/typo/i);
  });

  it('flags byte-identical duplicate uploads', () => {
    const findings = detectDuplicateDocuments([
      doc({ id: 'd1', filename: 'cv.txt', sha256: 'same' }),
      doc({ id: 'd2', filename: 'cv-copy.txt', sha256: 'same' }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe(DiscrepancyKind.DUPLICATE_DOCUMENT);
  });
});

// ---------------------------------------------------------------- false positives

describe('legitimate situations are NOT flagged', () => {
  it('does not flag a summer job during a degree programme', () => {
    // The single most common false positive in credential screening.
    const findings = detectFullTimeOverlaps(
      [
        claim({
          id: 'degree',
          category: ClaimCategory.EDUCATION_ENROLLMENT,
          organizationName: 'Riverton State University',
          startDate: new Date('2016-08-01'),
          endDate: new Date('2020-05-31'),
        }),
        claim({
          id: 'internship',
          organizationName: 'Northwind Analytics',
          startDate: new Date('2019-06-01'),
          endDate: new Date('2019-08-31'),
        }),
      ],
      AS_OF,
    );
    expect(findings).toHaveLength(0);
  });

  it('does not flag part-time or advisory work alongside a full-time role', () => {
    const findings = detectFullTimeOverlaps(
      [
        claim({ id: 'a', organizationName: 'Northwind Analytics' }),
        claim({ id: 'b', organizationName: 'Helios Robotics', isFullTimeCommitment: false }),
      ],
      AS_OF,
    );
    expect(findings).toHaveLength(0);
  });

  it('does not flag an overlap that is an artefact of month-only precision', () => {
    const findings = detectFullTimeOverlaps(
      [
        claim({
          id: 'a',
          organizationName: 'Northwind Analytics',
          startDate: new Date('2022-01-01'),
          endDate: new Date('2022-06-30T23:59:59Z'),
          datePrecision: 'MONTH',
        }),
        claim({
          id: 'b',
          organizationName: 'Helios Robotics',
          startDate: new Date('2022-06-01'),
          endDate: new Date('2022-12-31T23:59:59Z'),
          datePrecision: 'MONTH',
        }),
      ],
      AS_OF,
    );
    expect(findings).toHaveLength(0);
  });

  it('does not flag the same employment described twice at one organisation', () => {
    const findings = detectFullTimeOverlaps(
      [
        claim({ id: 'a', documentId: 'doc-a', organizationName: 'Meta Platforms' }),
        claim({ id: 'b', documentId: 'doc-b', organizationName: 'Facebook, Inc.' }),
      ],
      AS_OF,
    );
    expect(findings).toHaveLength(0);
  });

  it('does not flag a year-precision date difference as a date conflict', () => {
    const findings = detectDateConflicts([
      claim({ id: 'a', documentId: 'doc-a', startDate: new Date('2021-01-01'), datePrecision: 'YEAR' }),
      claim({ id: 'b', documentId: 'doc-b', startDate: new Date('2021-09-01'), datePrecision: 'YEAR' }),
    ]);
    expect(findings).toHaveLength(0);
  });

  it('does not flag a rounded month difference as a date conflict', () => {
    const findings = detectDateConflicts([
      claim({ id: 'a', documentId: 'doc-a', startDate: new Date('2022-01-01'), datePrecision: 'MONTH' }),
      claim({ id: 'b', documentId: 'doc-b', startDate: new Date('2022-01-28'), datePrecision: 'MONTH' }),
    ]);
    expect(findings).toHaveLength(0);
  });

  it('does not flag equivalent titles at the same employer', () => {
    const findings = detectTitleMismatches([
      claim({ id: 'a', documentId: 'doc-a', title: 'Software Engineer' }),
      claim({ id: 'b', documentId: 'doc-b', title: 'Software Developer' }),
    ]);
    expect(findings).toHaveLength(0);
  });

  it('does not create a discrepancy when a source simply holds no record', () => {
    // An obscure award, an old competition whose site is gone, a private
    // company's internal recognition — none of these are inconsistencies.
    for (const result of [
      SourceCheckResult.RECORD_NOT_FOUND,
      SourceCheckResult.SOURCE_UNAVAILABLE,
      SourceCheckResult.INCONCLUSIVE,
      SourceCheckResult.ERROR,
    ]) {
      const findings = detectSourceConflicts(
        [claim({ id: 'a', category: ClaimCategory.AWARD_COMPETITION })],
        [{ claimId: 'a', adapterKey: 'award-database', result, excerpt: null, detail: 'no record' }],
      );
      expect(findings, `result ${result} must not create a discrepancy`).toHaveLength(0);
    }
  });

  it('creates a discrepancy only when a held record actually differs', () => {
    const findings = detectSourceConflicts(
      [claim({ id: 'a', category: ClaimCategory.AWARD_COMPETITION })],
      [
        {
          claimId: 'a',
          adapterKey: 'award-database',
          result: SourceCheckResult.NO_MATCH,
          excerpt: 'Fourth place',
          detail: 'The published results list a different placement.',
        },
      ],
    );
    expect(findings).toHaveLength(1);
    // Even here, the wording must not assert why the difference exists.
    expect(findings[0]!.description).toMatch(/published records do contain errors/i);
  });
});

// ---------------------------------------------------------------- framing

describe('document anomalies never conclude forgery', () => {
  it('describes metadata oddities as file properties, not findings', () => {
    const findings = detectDocumentAnomalies([
      doc({
        id: 'd1',
        filename: 'transcript.pdf',
        kind: 'TRANSCRIPT',
        metadata: { creationDate: 'D:20240101', modificationDate: 'D:20240202', producer: 'Microsoft Word' },
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('INFORMATIONAL');
    expect(findings[0]!.description).toMatch(/can establish that a document was altered/i);
    expect(findings[0]!.description).toMatch(/properties of the file, not findings/i);
    expect(findings[0]!.description).not.toMatch(/forged|fake|altered by|tampered/i);
  });

  it('produces no finding for an unremarkable file', () => {
    expect(detectDocumentAnomalies([doc({ id: 'd1', metadata: { hasTextLayer: true } })])).toHaveLength(0);
  });
});

describe('no finding anywhere accuses a person', () => {
  it('keeps every generated description free of accusatory language', () => {
    const findings = analyzeConsistency({
      claims: [
        claim({ id: 'a', documentId: 'doc-a', title: 'Senior Software Engineer' }),
        claim({
          id: 'b',
          documentId: 'doc-b',
          title: 'Software Engineer',
          startDate: new Date('2021-06-14'),
          datePrecision: 'MONTH',
        }),
        claim({
          id: 'c',
          documentId: 'doc-a',
          category: ClaimCategory.AWARD_COMPETITION,
          organizationName: 'Example Olympiad',
          normalizedText: 'First Place at Example Olympiad',
        }),
      ],
      documents: [doc({ id: 'doc-a', sha256: 'h1' }), doc({ id: 'doc-b', sha256: 'h2' })],
      sourceChecks: [],
      asOf: AS_OF,
    });

    const accusatory = /\b(lied|lying|liar|fraud|fraudulent|fabricated|falsified|forged|dishonest|deceptive)\b/i;
    for (const finding of findings) {
      expect(finding.title, finding.ruleKey).not.toMatch(accusatory);
      expect(finding.description, finding.ruleKey).not.toMatch(accusatory);
    }
  });

  it('produces stable rule keys so re-analysis does not duplicate findings', () => {
    const input = {
      claims: [
        claim({ id: 'a', documentId: 'doc-a', title: 'Senior Software Engineer' }),
        claim({ id: 'b', documentId: 'doc-b', title: 'Software Engineer' }),
      ],
      documents: [doc({ id: 'doc-a', sha256: 'h1' }), doc({ id: 'doc-b', sha256: 'h2' })],
      sourceChecks: [],
      asOf: AS_OF,
    };
    const first = analyzeConsistency(input).map((f) => f.ruleKey);
    const second = analyzeConsistency(input).map((f) => f.ruleKey);
    expect(first).toEqual(second);
  });
});
