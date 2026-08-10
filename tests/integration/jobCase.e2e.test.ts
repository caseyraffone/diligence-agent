import { beforeAll, describe, expect, it } from 'vitest';
import { ClaimStatus, DiscrepancyStatus, TipStatus } from '@prisma/client';
import { createCase, createTenant, prisma, resetDatabase, uploadText, type TestTenant } from '../helpers/db';
import { enqueueVerificationForCase } from '@/modules/orchestrator';
import { drainQueue } from '@/queue/worker';
import { analyzeCase } from '@/modules/consistencyAnalyst';
import { recordReviewerDecision } from '@/modules/caseReviewer';
import { approveAndSendClarification, draftClarification, submitClarificationResponse } from '@/modules/clarification';
import { approveOutreach, draftOutreach, recordOutreachResponse, recordOutreachSent } from '@/modules/outreach';
import { submitAnonymousTip, triageTip } from '@/modules/tips';
import { resolvePortalToken } from '@/lib/auth/portalToken';
import { ValidationError } from '@/lib/errors';

/**
 * End-to-end: a job application where an innocent title/date difference is
 * resolved through the clarification workflow.
 */

const RESUME = `EXPERIENCE
Senior Software Engineer, Northwind Analytics (Mar 2021 - Present)

EDUCATION
B.S. Computer Science, Riverton State University (Aug 2016 - May 2020)
`;

const FORM = `EXPERIENCE
Software Engineer, Northwind Analytics (Jun 2021 - Present)

EDUCATION
B.S. Computer Science, Riverton State University (Aug 2016 - May 2020)
`;

let tenant: TestTenant;
let caseId: string;

beforeAll(async () => {
  await resetDatabase();
  tenant = await createTenant('employer', 'job-application');
  caseId = (await createCase(tenant, { reference: 'JOB-1' })).caseId;

  await uploadText(tenant, caseId, 'resume.txt', RESUME, 'RESUME_CV');
  await uploadText(tenant, caseId, 'application-form.txt', FORM, 'APPLICATION');
  await drainQueue({ caseId, maxTasks: 100 });
  await enqueueVerificationForCase({ caseId, organizationId: tenant.organizationId, actorUserId: null });
  await drainQueue({ caseId, maxTasks: 300 });
  await analyzeCase({ caseId, organizationId: tenant.organizationId, actorUserId: null });
});

describe('cross-document comparison', () => {
  it('notices the differing title and start date', async () => {
    const discrepancies = await prisma.discrepancy.findMany({ where: { caseId } });
    const kinds = discrepancies.map((d) => d.kind);
    expect(kinds).toContain('TITLE_MISMATCH');
    expect(kinds).toContain('CONFLICTING_DATES');
  });

  it('phrases the observation without implying concealment', async () => {
    const discrepancies = await prisma.discrepancy.findMany({ where: { caseId } });
    for (const d of discrepancies) {
      expect(d.description).not.toMatch(/\b(lied|lying|fraud|fraudulent|dishonest|concealed|hid)\b/i);
    }
    const title = discrepancies.find((d) => d.kind === 'TITLE_MISMATCH');
    expect(title?.description).toMatch(/promotion|internal title/i);
  });

  it('does not flag the degree as overlapping employment', async () => {
    const overlaps = await prisma.discrepancy.findMany({
      where: { caseId, kind: 'OVERLAPPING_FULL_TIME_COMMITMENT' },
    });
    expect(overlaps).toHaveLength(0);
  });
});

describe('clarification workflow', () => {
  let clarificationId: string;
  let portalUrl: string;

  it('drafts a neutral request a reviewer can approve', async () => {
    const discrepancy = await prisma.discrepancy.findFirstOrThrow({ where: { caseId, kind: 'TITLE_MISMATCH' } });
    const claim = await prisma.extractedClaim.findFirstOrThrow({ where: { caseId, category: 'EMPLOYMENT' } });

    clarificationId = await draftClarification({
      caseId,
      organizationId: tenant.organizationId,
      claimId: claim.id,
      discrepancyId: discrepancy.id,
      userId: tenant.users.LEAD_REVIEWER.id,
    });

    const request = await prisma.clarificationRequest.findUniqueOrThrow({ where: { id: clarificationId } });
    expect(request.status).toBe('DRAFT');
    expect(request.acceptableEvidence.length).toBeGreaterThan(0);
    // The applicant-facing text must never characterise them.
    expect(request.body).not.toMatch(/\b(fraud|lied|dishonest|discrepancy in your honesty)\b/i);
    expect(request.body).toMatch(/there may be a straightforward explanation|ordinary explanation|opportunity/i);
  });

  it('issues a single-purpose applicant link on approval', async () => {
    const result = await approveAndSendClarification({
      clarificationId,
      organizationId: tenant.organizationId,
      userId: tenant.users.LEAD_REVIEWER.id,
    });
    portalUrl = result.portalUrl;
    expect(portalUrl).toContain('/portal/');

    const request = await prisma.clarificationRequest.findUniqueOrThrow({ where: { id: clarificationId } });
    expect(request.status).toBe('SENT');
    // Only a hash is stored; the raw token never persists.
    const rawToken = portalUrl.split('/portal/')[1]!;
    expect(request.tokenHash).not.toBe(rawToken);
  });

  it('moves the claim to "clarification requested", not to a conclusion', async () => {
    const request = await prisma.clarificationRequest.findUniqueOrThrow({ where: { id: clarificationId } });
    const claim = await prisma.extractedClaim.findUniqueOrThrow({ where: { id: request.claimId! } });
    expect(claim.status).toBe(ClaimStatus.APPLICANT_CLARIFICATION_REQUESTED);
  });

  it('shows the applicant only their own request', async () => {
    const token = portalUrl.split('/portal/')[1]!;
    const context = await resolvePortalToken(token);
    expect(context).not.toBeNull();
    expect(context!.clarificationId).toBe(clarificationId);

    // The portal context exposes no reviewer notes, no other claims, no tips.
    const keys = Object.keys(context!);
    expect(keys).not.toContain('reviewerNotes');
    expect(keys).not.toContain('tips');
    expect(keys).not.toContain('outreachResponses');
    expect(keys).not.toContain('discrepancies');
  });

  it('rejects an unknown or expired token', async () => {
    expect(await resolvePortalToken('clearly-not-a-valid-token-value')).toBeNull();
    await prisma.clarificationRequest.update({
      where: { id: clarificationId },
      data: { tokenExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(await resolvePortalToken(portalUrl.split('/portal/')[1]!)).toBeNull();
    await prisma.clarificationRequest.update({
      where: { id: clarificationId },
      data: { tokenExpiresAt: new Date(Date.now() + 86_400_000) },
    });
  });

  it('records the applicant response without erasing the original claim', async () => {
    const request = await prisma.clarificationRequest.findUniqueOrThrow({ where: { id: clarificationId } });
    const before = await prisma.extractedClaim.findUniqueOrThrow({ where: { id: request.claimId! } });

    await submitClarificationResponse({
      clarificationId,
      organizationId: tenant.organizationId,
      caseId,
      message:
        'I joined in March 2021 on a contract-to-hire basis and converted to permanent in June 2021. I was promoted ' +
        'from Software Engineer to Senior Software Engineer in January 2023.',
    });

    const after = await prisma.extractedClaim.findUniqueOrThrow({ where: { id: request.claimId! } });
    // The original extraction is untouched; only the status moved to human review.
    expect(after.sourcePassage).toBe(before.sourcePassage);
    expect(after.normalizedText).toBe(before.normalizedText);
    expect(after.status).toBe(ClaimStatus.HUMAN_REVIEW_REQUIRED);

    const evidence = await prisma.evidenceItem.findFirst({
      where: { claimId: request.claimId!, statementType: 'APPLICANT_STATEMENT' },
    });
    expect(evidence).not.toBeNull();
    expect(evidence!.authorityLevel).toBe('L6_APPLICANT_PROVIDED');
  });
});

describe('employer confirmation resolves it', () => {
  it('drafts, approves, and records a reply without ever sending anything', async () => {
    const claim = await prisma.extractedClaim.findFirstOrThrow({ where: { caseId, category: 'EMPLOYMENT' } });

    const outreachId = await draftOutreach({
      caseId,
      organizationId: tenant.organizationId,
      claimId: claim.id,
      recipientOrgName: 'Northwind Analytics',
      userId: tenant.users.LEAD_REVIEWER.id,
    });

    let request = await prisma.outreachRequest.findUniqueOrThrow({ where: { id: outreachId } });
    expect(request.status).toBe('PENDING_APPROVAL');
    // Nothing is transmitted; there is no "sentAt" until a human records it.
    expect(request.sentRecordedAt).toBeNull();

    await approveOutreach({ outreachId, organizationId: tenant.organizationId, userId: tenant.users.LEAD_REVIEWER.id });
    await recordOutreachSent({
      outreachId,
      organizationId: tenant.organizationId,
      userId: tenant.users.LEAD_REVIEWER.id,
    });

    await recordOutreachResponse({
      outreachId,
      organizationId: tenant.organizationId,
      userId: tenant.users.LEAD_REVIEWER.id,
      respondentName: 'H. Okafor',
      respondentRole: 'People Operations',
      content:
        'Continuous engagement 15 March 2021 to date. Contract-to-hire until 14 June 2021. Title Software Engineer ' +
        'to 31 January 2023, Senior Software Engineer thereafter.',
    });

    request = await prisma.outreachRequest.findUniqueOrThrow({ where: { id: outreachId } });
    expect(request.status).toBe('RESPONSE_RECEIVED');

    const evidence = await prisma.evidenceItem.findFirst({
      where: { claimId: claim.id, statementType: 'THIRD_PARTY_STATEMENT' },
    });
    expect(evidence?.authorityLevel).toBe('L3_AUTHORIZED_REPRESENTATIVE');
  });

  it('lets a reviewer verify the claim and mark the observation explained', async () => {
    const claim = await prisma.extractedClaim.findFirstOrThrow({
      where: { caseId, category: 'EMPLOYMENT' },
      include: { evidenceItems: true },
    });

    await recordReviewerDecision({
      claimId: claim.id,
      organizationId: tenant.organizationId,
      userId: tenant.users.LEAD_REVIEWER.id,
      newStatus: ClaimStatus.VERIFIED,
      rationale:
        'Northwind confirmed both titles and both dates. The two documents each described a different point in the ' +
        'same employment history; both were accurate.',
      evidenceItemIds: claim.evidenceItems.filter((e) => e.relation === 'SUPPORTING').map((e) => e.id),
    });

    await prisma.discrepancy.updateMany({
      where: { caseId, status: DiscrepancyStatus.OPEN },
      data: {
        status: DiscrepancyStatus.EXPLAINED,
        resolutionNote: 'Contract-to-permanent conversion and a promotion account for both differences.',
        resolvedByUserId: tenant.users.LEAD_REVIEWER.id,
        resolvedAt: new Date(),
      },
    });

    const updated = await prisma.extractedClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(updated.status).toBe(ClaimStatus.VERIFIED);

    const open = await prisma.discrepancy.count({ where: { caseId, status: DiscrepancyStatus.OPEN } });
    expect(open).toBe(0);
  });

  it('does not resurrect an explained observation on re-analysis', async () => {
    await analyzeCase({ caseId, organizationId: tenant.organizationId, actorUserId: null });
    const open = await prisma.discrepancy.count({ where: { caseId, status: DiscrepancyStatus.OPEN } });
    expect(open).toBe(0);
  });
});

describe('anonymous tips cannot move a claim', () => {
  it('records a tip without touching any claim status', async () => {
    const before = await prisma.extractedClaim.findMany({ where: { caseId }, select: { id: true, status: true } });

    const result = await submitAnonymousTip({
      organizationId: tenant.organizationId,
      caseId,
      allegationText: 'I do not believe this person held the senior title they claim on their resume document.',
      submissionSignal: 'test-signal',
    });
    expect(result.status).toBe(TipStatus.RECEIVED);

    const after = await prisma.extractedClaim.findMany({ where: { caseId }, select: { id: true, status: true } });
    expect(after).toEqual(before);
  });

  it('suppresses a duplicate allegation', async () => {
    const text = 'A second identical submission about the same matter that should be suppressed on repeat.';
    await submitAnonymousTip({
      organizationId: tenant.organizationId,
      caseId,
      allegationText: text,
      submissionSignal: 's',
    });
    const repeat = await submitAnonymousTip({
      organizationId: tenant.organizationId,
      caseId,
      allegationText: text,
      submissionSignal: 's',
    });
    expect(repeat.status).toBe(TipStatus.DUPLICATE_SUPPRESSED);
    expect(repeat.tipId).toBeNull();
  });

  it('closes an allegation that turns on a protected characteristic', async () => {
    const result = await submitAnonymousTip({
      organizationId: tenant.organizationId,
      allegationText:
        'You should look closely at this applicant because of their religion and immigration status, which I doubt.',
      submissionSignal: 'x',
    });
    expect(result.status).toBe(TipStatus.CLOSED_OUT_OF_SCOPE);
  });

  it('refuses to mark a tip corroborated by itself', async () => {
    const fresh = await createTenant('tips-only');
    const tip = await submitAnonymousTip({
      organizationId: fresh.organizationId,
      allegationText: 'An allegation on a case that holds no independent evidence at all right now.',
      submissionSignal: 'y',
    });

    await expect(
      triageTip({
        tipId: tip.tipId!,
        organizationId: fresh.organizationId,
        userId: fresh.users.LEAD_REVIEWER.id,
        status: 'INDEPENDENTLY_CORROBORATED',
        reviewNote: 'Trying to corroborate with nothing behind it.',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
