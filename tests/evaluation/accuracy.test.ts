import { beforeAll, describe, expect, it } from 'vitest';
import { createCase, createTenant, prisma, resetDatabase, uploadText, type TestTenant } from '../helpers/db';
import { enqueueVerificationForCase } from '@/modules/orchestrator';
import { drainQueue } from '@/queue/worker';
import { analyzeCase } from '@/modules/consistencyAnalyst';
import { CORPUS, NEGATIVE_CASES, POSITIVE_CASES, type CorpusCase } from '../fixtures/corpus';

/**
 * ACCURACY EVALUATION
 *
 * Runs the whole pipeline over a labelled corpus and computes detection
 * precision, recall, and — the number that matters most here — the
 * false-positive rate on cases describing ordinary, legitimate lives.
 *
 * Why this exists: any institution buying a verification tool will ask "how
 * often is it wrong, and in which direction?". Without labelled data that
 * question has no answer, and "we have lots of tests" is not an answer. This
 * turns the claim into a measurement that regressions can break.
 *
 * The asymmetry is deliberate. A missed inconsistency costs a reviewer some
 * thoroughness. A false positive puts an innocent person under suspicion. The
 * thresholds below reflect that: zero tolerance on the negative cases, and a
 * lower bar on recall.
 */

interface CaseResult {
  key: string;
  scenario: string;
  expected: string[];
  mustNotFlag: string[];
  actual: string[];
  claimsExtracted: number;
  missingClaims: string[];
  truePositives: string[];
  falseNegatives: string[];
  falsePositives: string[];
}

const results: CaseResult[] = [];
let tenants: Record<string, TestTenant>;

async function runCase(corpusCase: CorpusCase): Promise<CaseResult> {
  const tenant = tenants[corpusCase.policyKey]!;
  const created = await createCase(tenant, { reference: `EVAL-${corpusCase.key}` });

  for (const doc of corpusCase.documents) {
    await uploadText(tenant, created.caseId, doc.filename, doc.content, doc.kind);
  }

  await drainQueue({ caseId: created.caseId, maxTasks: 200 });
  await enqueueVerificationForCase({
    caseId: created.caseId,
    organizationId: tenant.organizationId,
    actorUserId: null,
  });
  await drainQueue({ caseId: created.caseId, maxTasks: 400 });
  await analyzeCase({
    caseId: created.caseId,
    organizationId: tenant.organizationId,
    actorUserId: null,
    // Fixed evaluation date so results do not drift as time passes.
    asOf: new Date('2026-01-01T00:00:00Z'),
  });

  const [discrepancies, claims] = await Promise.all([
    prisma.discrepancy.findMany({ where: { caseId: created.caseId } }),
    prisma.extractedClaim.findMany({ where: { caseId: created.caseId } }),
  ]);

  const actual = [...new Set(discrepancies.map((d) => d.kind as string))];
  const claimText = claims
    .map((c) => `${c.normalizedText} ${c.organizationName ?? ''}`)
    .join(' | ')
    .toLowerCase();

  return {
    key: corpusCase.key,
    scenario: corpusCase.scenario,
    expected: corpusCase.expectedFindings,
    mustNotFlag: corpusCase.mustNotFlag,
    actual,
    claimsExtracted: claims.length,
    missingClaims: corpusCase.expectedClaimSubstrings.filter((s) => !claimText.includes(s.toLowerCase())),
    truePositives: corpusCase.expectedFindings.filter((f) => actual.includes(f)),
    falseNegatives: corpusCase.expectedFindings.filter((f) => !actual.includes(f)),
    // A false positive is anything the labels say must not be raised.
    falsePositives: corpusCase.mustNotFlag.filter((f) => actual.includes(f)),
  };
}

beforeAll(async () => {
  await resetDatabase();
  tenants = {
    'university-application': await createTenant('eval-university', 'university-application'),
    'job-application': await createTenant('eval-employer', 'job-application'),
  };

  for (const corpusCase of CORPUS) {
    results.push(await runCase(corpusCase));
  }
}, 300_000);

describe('claim extraction', () => {
  it('finds every organisation the corpus says is present', () => {
    const failures = results.filter((r) => r.missingClaims.length > 0);
    const detail = failures.map((f) => `${f.key}: missing ${f.missingClaims.join(', ')}`).join('\n');
    expect(failures, `extraction gaps:\n${detail}`).toHaveLength(0);
  });

  it('extracts at least one claim from every case', () => {
    for (const r of results) {
      expect(r.claimsExtracted, `${r.key} produced no claims`).toBeGreaterThan(0);
    }
  });
});

describe('detection accuracy', () => {
  it('raises no finding on any case describing an ordinary, legitimate life', () => {
    // The load-bearing assertion. A failure here means a real person would have
    // been put under suspicion for a summer job, a company rename, a career
    // break, or a translated institution name.
    const harmed = results.filter((r) => r.falsePositives.length > 0);
    const detail = harmed
      .map((h) => `${h.key} (${h.scenario})\n    falsely flagged: ${h.falsePositives.join(', ')}`)
      .join('\n  ');
    expect(harmed, `FALSE POSITIVES on legitimate applicants:\n  ${detail}`).toHaveLength(0);
  });

  it('raises nothing at all on the true-negative cases', () => {
    for (const negative of NEGATIVE_CASES) {
      const result = results.find((r) => r.key === negative.key)!;
      // Informational document observations are permitted; substantive
      // inconsistency findings are not.
      const substantive = result.actual.filter(
        (k) => k !== 'DOCUMENT_ANOMALY' && k !== 'UNSUPPORTED_BY_RECOMMENDATION',
      );
      expect(substantive, `${negative.key} raised ${substantive.join(', ')}`).toHaveLength(0);
    }
  });

  it('detects the inconsistencies it is supposed to detect', () => {
    const missed = results.filter((r) => r.falseNegatives.length > 0);
    const detail = missed.map((m) => `${m.key}: missed ${m.falseNegatives.join(', ')}`).join('\n');
    expect(missed, `missed detections:\n${detail}`).toHaveLength(0);
  });
});

describe('aggregate metrics', () => {
  it('reports precision, recall, and false-positive rate', () => {
    const tp = results.reduce((n, r) => n + r.truePositives.length, 0);
    const fn = results.reduce((n, r) => n + r.falseNegatives.length, 0);
    const fp = results.reduce((n, r) => n + r.falsePositives.length, 0);

    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const casesWithFalsePositives = results.filter((r) => r.falsePositives.length > 0).length;
    const falsePositiveRate = casesWithFalsePositives / results.length;

    // Printed so the numbers land in CI output and can be pasted into a
    // procurement questionnaire.
    console.log(
      [
        '',
        '  ── Detection accuracy over the labelled corpus ──',
        `  cases evaluated          ${results.length} (${POSITIVE_CASES.length} with a real inconsistency, ${NEGATIVE_CASES.length} entirely legitimate)`,
        `  true positives           ${tp}`,
        `  false negatives          ${fn}`,
        `  false positives          ${fp}`,
        `  recall                   ${(recall * 100).toFixed(1)}%`,
        `  precision                ${(precision * 100).toFixed(1)}%`,
        `  false-positive rate      ${(falsePositiveRate * 100).toFixed(1)}% of cases`,
        '',
      ].join('\n'),
    );

    // A missed inconsistency costs thoroughness; a false positive costs a person.
    expect(falsePositiveRate).toBe(0);
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(precision).toBeGreaterThanOrEqual(0.9);
  });
});
