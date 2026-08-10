import { beforeAll, describe, expect, it } from 'vitest';
import { ClaimStatus, ConsentScope } from '@prisma/client';
import { createCase, createTenant, prisma, resetDatabase, uploadText, type TestTenant } from '../helpers/db';
import { enqueueVerificationForCase } from '@/modules/orchestrator';
import { drainQueue, unblockConsentTasks } from '@/queue/worker';
import { analyzeCase } from '@/modules/consistencyAnalyst';
import { buildCaseReport, buildCaseWorkspace, recordReviewerDecision } from '@/modules/caseReviewer';
import { runSourceCheck } from '@/modules/evidenceVerifier';
import { ConsentRequiredError } from '@/lib/errors';

/**
 * End-to-end: a university application case.
 *
 * Exercises upload → extraction → verification planning → source checks →
 * consistency analysis → human decisions → report, and asserts the consent gate
 * and the human-review boundary along the way.
 */

const CV = `EDUCATION
Diploma Programme, Lagos International College (Sep 2021 - Jun 2025)

RESEARCH
Summer Research Assistant, University of Lagos (Jun 2024 - Aug 2024)

AWARDS
National Finalist, Nigerian Mathematics Olympiad (2024)

PUBLICATIONS
Okonkwo, A.; Adeyemi, T. "Low-cost spectrometry for classroom physics: a field trial in three Lagos schools." Journal of Undergraduate Physics Education, 2024. doi:10.5281/zenodo.7654321
`;

const OBSCURE = `AWARDS
Regional Winner, Nowhere Valley Junior Science Fair (2022)
`;

let tenant: TestTenant;
let caseId: string;

beforeAll(async () => {
  await resetDatabase();
  tenant = await createTenant('university', 'university-application');
});

describe('consent gate', () => {
  it('refuses to contact any external source before consent is recorded', async () => {
    const noConsent = await createCase(tenant, { reference: 'UNI-NOCONSENT', withConsent: false });
    const documentId = await uploadText(tenant, noConsent.caseId, 'cv.txt', CV);
    await drainQueue({ caseId: noConsent.caseId, maxTasks: 50 });

    const claim = await prisma.extractedClaim.findFirstOrThrow({ where: { documentId } });

    await expect(
      runSourceCheck({
        claimId: claim.id,
        organizationId: tenant.organizationId,
        adapterKey: 'crossref',
        actorUserId: null,
        actorType: 'SYSTEM',
      }),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it('parks consent-blocked work instead of failing it, and resumes on consent', async () => {
    const blocked = await createCase(tenant, { reference: 'UNI-BLOCKED', withConsent: false });
    await uploadText(tenant, blocked.caseId, 'cv.txt', CV);
    await drainQueue({ caseId: blocked.caseId, maxTasks: 50 });
    await enqueueVerificationForCase({
      caseId: blocked.caseId,
      organizationId: tenant.organizationId,
      actorUserId: null,
    });

    const first = await drainQueue({ caseId: blocked.caseId, maxTasks: 100 });
    expect(first.blocked).toBeGreaterThan(0);
    expect(first.failed).toBe(0);

    await prisma.consentRecord.create({
      data: {
        caseId: blocked.caseId,
        scope: ConsentScope.EXTERNAL_PUBLIC_SOURCES,
        grantedAt: new Date(),
        grantedVia: 'Signed authorisation',
      },
    });
    const requeued = await unblockConsentTasks(blocked.caseId);
    expect(requeued).toBeGreaterThan(0);

    const second = await drainQueue({ caseId: blocked.caseId, maxTasks: 200 });
    expect(second.succeeded).toBeGreaterThan(0);
  });
});

describe('university case end to end', () => {
  beforeAll(async () => {
    caseId = (await createCase(tenant, { reference: 'UNI-1' })).caseId;
    await uploadText(tenant, caseId, 'okonkwo-cv.txt', CV);
    await drainQueue({ caseId, maxTasks: 100 });
    await enqueueVerificationForCase({ caseId, organizationId: tenant.organizationId, actorUserId: null });
    await drainQueue({ caseId, maxTasks: 400 });
    await analyzeCase({ caseId, organizationId: tenant.organizationId, actorUserId: null });
  });

  it('extracts claims that cite their document and page', async () => {
    const claims = await prisma.extractedClaim.findMany({ where: { caseId }, include: { document: true } });
    expect(claims.length).toBeGreaterThan(3);
    for (const claim of claims) {
      expect(claim.pageNumber).toBeGreaterThan(0);
      expect(claim.document.filename).toBe('okonkwo-cv.txt');
      expect(claim.sourcePassage.length).toBeGreaterThan(0);
    }
  });

  it('categorises the publication and links it to the DOI registry', async () => {
    const publication = await prisma.extractedClaim.findFirstOrThrow({ where: { caseId, category: 'PUBLICATION' } });
    const checks = await prisma.sourceCheck.findMany({ where: { claimId: publication.id } });
    expect(checks.some((c) => c.adapterKey === 'crossref' && c.result === 'MATCH')).toBe(true);
  });

  it('never lets the pipeline mark anything verified on its own', async () => {
    const claims = await prisma.extractedClaim.findMany({ where: { caseId } });
    for (const claim of claims) {
      expect(claim.status).not.toBe(ClaimStatus.VERIFIED);
      expect(claim.status).not.toBe(ClaimStatus.CORROBORATED);
      expect(claim.status).not.toBe(ClaimStatus.CONFLICTING_INFORMATION);
    }
    // Strong evidence routes to a human instead.
    expect(claims.some((c) => c.status === ClaimStatus.HUMAN_REVIEW_REQUIRED)).toBe(true);
  });

  it('records every source check with a retrievable evidence trail', async () => {
    const checks = await prisma.sourceCheck.findMany({ where: { caseId } });
    expect(checks.length).toBeGreaterThan(0);
    for (const check of checks) {
      expect(check.retrievedAt).toBeInstanceOf(Date);
      expect(check.authorityLevel).toBeTruthy();
      expect(check.adapterKey).toBeTruthy();
    }
    const evidence = await prisma.evidenceItem.findMany({ where: { caseId } });
    expect(evidence.length).toBeGreaterThan(0);
  });

  it('lets a reviewer record verified, with an audit entry', async () => {
    const claim = await prisma.extractedClaim.findFirstOrThrow({
      where: { caseId, status: ClaimStatus.HUMAN_REVIEW_REQUIRED },
      include: { evidenceItems: true },
    });

    await recordReviewerDecision({
      claimId: claim.id,
      organizationId: tenant.organizationId,
      userId: tenant.users.LEAD_REVIEWER.id,
      newStatus: ClaimStatus.VERIFIED,
      rationale:
        'The DOI resolves to a registered work listing the applicant as an author. Confirmed against Crossref.',
      evidenceItemIds: claim.evidenceItems.filter((e) => e.relation === 'SUPPORTING').map((e) => e.id),
    });

    const updated = await prisma.extractedClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(updated.status).toBe(ClaimStatus.VERIFIED);

    const audit = await prisma.auditEvent.findFirst({
      where: { caseId, action: 'CLAIM_STATUS_CHANGED', entityId: claim.id },
    });
    expect(audit).not.toBeNull();
  });

  it('keeps a reviewer decision from being overwritten by re-analysis', async () => {
    const decided = await prisma.extractedClaim.findFirstOrThrow({ where: { caseId, status: ClaimStatus.VERIFIED } });
    const { recomputeClaimProposal } = await import('@/modules/evidenceVerifier');
    await recomputeClaimProposal(decided.id, tenant.organizationId);
    const after = await prisma.extractedClaim.findUniqueOrThrow({ where: { id: decided.id } });
    expect(after.status).toBe(ClaimStatus.VERIFIED);
  });

  it('produces a report that separates the categories of information', async () => {
    const report = await buildCaseReport(caseId, tenant.organizationId);

    expect(report.notice).toMatch(/does not determine whether any statement is true/i);
    expect(report.notice).toMatch(/not evidence that a claim is inaccurate/i);
    expect(report.claims.length).toBeGreaterThan(0);
    expect(report.auditIntegrity.valid).toBe(true);

    // The five buckets exist and are distinct arrays.
    expect(Array.isArray(report.confirmedFacts)).toBe(true);
    expect(Array.isArray(report.applicantStatements)).toBe(true);
    expect(Array.isArray(report.thirdPartyStatements)).toBe(true);
    expect(Array.isArray(report.systemObservations)).toBe(true);
    expect(Array.isArray(report.inferences)).toBe(true);

    // No recommendation anywhere in the report.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/\b(recommend admit|recommend reject|do not hire|should be admitted)\b/i);
  });

  it('summarises progress without scoring the applicant', async () => {
    const workspace = await buildCaseWorkspace(caseId, tenant.organizationId);
    expect(workspace.progress.totalClaims).toBeGreaterThan(0);
    expect(workspace.priority.score).toBeGreaterThanOrEqual(0);
    // Priority factors are about evidence, never about the person.
    for (const contribution of workspace.priority.contributions) {
      expect(contribution.factor).toMatch(/claims|discrepanc|clarification|due|checks|severity/i);
    }
  });
});

describe('an obscure but legitimate achievement', () => {
  it('reaches "unable to verify" — never a negative finding — and can still be verified later', async () => {
    const obscure = await createCase(tenant, { reference: 'UNI-OBSCURE' });
    await uploadText(tenant, obscure.caseId, 'obscure.txt', OBSCURE);
    await drainQueue({ caseId: obscure.caseId, maxTasks: 50 });
    await enqueueVerificationForCase({
      caseId: obscure.caseId,
      organizationId: tenant.organizationId,
      actorUserId: null,
    });
    await drainQueue({ caseId: obscure.caseId, maxTasks: 200 });
    await analyzeCase({ caseId: obscure.caseId, organizationId: tenant.organizationId, actorUserId: null });

    const claim = await prisma.extractedClaim.findFirstOrThrow({
      where: { caseId: obscure.caseId, category: 'AWARD_COMPETITION' },
    });
    expect(claim.status).toBe(ClaimStatus.UNABLE_TO_VERIFY);

    // No source held a record, so no discrepancy may have been raised.
    const discrepancies = await prisma.discrepancy.findMany({
      where: { caseId: obscure.caseId, kind: { in: ['CLAIM_SOURCE_CONFLICT', 'AWARD_LEVEL_INCONSISTENCY'] } },
    });
    expect(discrepancies).toHaveLength(0);

    // And the path to "verified" remains open once the organiser confirms it.
    const evidence = await prisma.evidenceItem.create({
      data: {
        organizationId: tenant.organizationId,
        caseId: obscure.caseId,
        claimId: claim.id,
        relation: 'SUPPORTING',
        statementType: 'THIRD_PARTY_STATEMENT',
        authorityLevel: 'L3_AUTHORIZED_REPRESENTATIVE',
        summary: 'The fair organiser confirmed the placement by email.',
      },
    });

    await recordReviewerDecision({
      claimId: claim.id,
      organizationId: tenant.organizationId,
      userId: tenant.users.LEAD_REVIEWER.id,
      newStatus: ClaimStatus.VERIFIED,
      rationale: 'The organiser confirmed the result directly by email from an official address on 2026-02-10.',
      evidenceItemIds: [evidence.id],
    });

    const after = await prisma.extractedClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(after.status).toBe(ClaimStatus.VERIFIED);
  });
});
