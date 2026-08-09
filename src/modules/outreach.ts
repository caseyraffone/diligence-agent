import { AuthorityLevel, ConsentScope, EvidenceRelation, OutreachStatus, StatementType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recordAudit } from '@/lib/audit/audit';
import { ConflictError, ConsentRequiredError } from '@/lib/errors';
import { recomputeClaimProposal } from './evidenceVerifier';

/**
 * OUTREACH TO ISSUING ORGANIZATIONS AND REFERENCES
 *
 * The system drafts. A human approves. A human sends. A human records the reply.
 *
 * There is no transport here — no SMTP, no mail API, no webhook. That is a
 * deliberate design decision, not an unfinished feature: automated contact with
 * a third party about a named individual is the highest-risk action this
 * product could take, and it should not be one configuration mistake away.
 *
 * Consent is checked before approval, and the required scope differs for an
 * issuing organisation versus a personal reference.
 */

export interface DraftOutreachInput {
  caseId: string;
  organizationId: string;
  claimId?: string;
  recipientOrgName: string;
  recipientEmail?: string;
  recipientNote?: string;
  requiredConsent?: ConsentScope;
  userId: string;
}

export async function draftOutreach(input: DraftOutreachInput): Promise<string> {
  const claim = input.claimId
    ? await prisma.extractedClaim.findFirstOrThrow({
        where: { id: input.claimId, organizationId: input.organizationId },
      })
    : null;

  const record = await prisma.case.findFirstOrThrow({
    where: { id: input.caseId, organizationId: input.organizationId },
    include: { applicant: true, organization: true },
  });

  const subject = claim
    ? `Verification request: ${claim.title ?? claim.category.toLowerCase().replace(/_/g, ' ')}`
    : 'Verification request';

  // Deterministic template rather than a model call. Outreach text is
  // externally visible correspondence; predictable wording is worth more than
  // fluency, and it keeps this path working with no provider configured.
  const body = [
    `To: ${input.recipientOrgName}`,
    '',
    `We are ${record.organization.name}. With the individual's documented authorisation, we are verifying`,
    'information supplied to us in an application, and would be grateful for your confirmation of the following.',
    '',
    `Individual named in the application: ${record.applicant.displayName}`,
    claim ? `Item to confirm: ${claim.normalizedText}` : 'Item to confirm: (specify)',
    claim?.startDate ? `Period stated: ${formatDate(claim.startDate)} to ${claim.endDate ? formatDate(claim.endDate) : 'present'}` : '',
    '',
    'We are asking only whether your records are consistent with the statement above, and if not, what your records',
    'show. We are not asking for any assessment of the individual, nor for any information beyond this item.',
    '',
    'If you are not the right person for this request, we would appreciate a pointer to the correct office rather',
    'than any further detail.',
    '',
    `Our reference: ${record.reference}`,
    'A copy of the individual\'s authorisation is available on request.',
    '',
    'Thank you for your time.',
  ]
    .filter((l) => l !== '')
    .join('\n');

  const created = await prisma.outreachRequest.create({
    data: {
      organizationId: input.organizationId,
      caseId: input.caseId,
      claimId: input.claimId ?? null,
      recipientOrgName: input.recipientOrgName,
      recipientEmail: input.recipientEmail ?? null,
      recipientNote: input.recipientNote ?? null,
      subject,
      body,
      status: OutreachStatus.PENDING_APPROVAL,
      requiredConsent: input.requiredConsent ?? ConsentScope.ISSUING_ORGANIZATION_OUTREACH,
    },
  });

  await recordAudit({
    organizationId: input.organizationId,
    caseId: input.caseId,
    actorType: 'USER',
    actorUserId: input.userId,
    action: 'OUTREACH_DRAFTED',
    entityType: 'OutreachRequest',
    entityId: created.id,
    metadata: { recipient: input.recipientOrgName, claimId: input.claimId ?? null },
  });

  return created.id;
}

/**
 * Approves a draft for sending. Verifies the consent scope the draft declared.
 * Approval does not transmit anything.
 */
export async function approveOutreach(input: {
  outreachId: string;
  organizationId: string;
  userId: string;
  editedSubject?: string;
  editedBody?: string;
}): Promise<void> {
  const request = await prisma.outreachRequest.findFirstOrThrow({
    where: { id: input.outreachId, organizationId: input.organizationId },
  });

  if (request.status === OutreachStatus.APPROVED_FOR_SENDING || request.status === OutreachStatus.SENT_RECORDED_MANUALLY) {
    throw new ConflictError('This outreach request has already been approved.');
  }

  const consent = await prisma.consentRecord.findFirst({
    where: { caseId: request.caseId, scope: request.requiredConsent, revokedAt: null },
  });
  if (!consent) throw new ConsentRequiredError(request.requiredConsent);

  await prisma.outreachRequest.update({
    where: { id: request.id },
    data: {
      subject: input.editedSubject ?? request.subject,
      body: input.editedBody ?? request.body,
      status: OutreachStatus.APPROVED_FOR_SENDING,
      approvedByUserId: input.userId,
      approvedAt: new Date(),
    },
  });

  await recordAudit({
    organizationId: input.organizationId,
    caseId: request.caseId,
    actorType: 'USER',
    actorUserId: input.userId,
    action: 'OUTREACH_APPROVED',
    entityType: 'OutreachRequest',
    entityId: request.id,
    metadata: { edited: Boolean(input.editedBody), consentRecordId: consent.id },
  });
}

export async function declineOutreach(input: {
  outreachId: string;
  organizationId: string;
  userId: string;
  reason: string;
}): Promise<void> {
  const request = await prisma.outreachRequest.findFirstOrThrow({
    where: { id: input.outreachId, organizationId: input.organizationId },
  });

  await prisma.outreachRequest.update({
    where: { id: request.id },
    data: { status: OutreachStatus.DECLINED_BY_REVIEWER, declineReason: input.reason },
  });

  await recordAudit({
    organizationId: input.organizationId,
    caseId: request.caseId,
    actorType: 'USER',
    actorUserId: input.userId,
    action: 'OUTREACH_DECLINED',
    entityType: 'OutreachRequest',
    entityId: request.id,
    metadata: { reason: input.reason },
  });
}

/** A reviewer records that they sent the approved request through their own channel. */
export async function recordOutreachSent(input: {
  outreachId: string;
  organizationId: string;
  userId: string;
}): Promise<void> {
  const request = await prisma.outreachRequest.findFirstOrThrow({
    where: { id: input.outreachId, organizationId: input.organizationId },
  });

  if (request.status !== OutreachStatus.APPROVED_FOR_SENDING) {
    throw new ConflictError('Only an approved request can be recorded as sent.');
  }

  await prisma.outreachRequest.update({
    where: { id: request.id },
    data: { status: OutreachStatus.SENT_RECORDED_MANUALLY, sentRecordedAt: new Date() },
  });

  await recordAudit({
    organizationId: input.organizationId,
    caseId: request.caseId,
    actorType: 'USER',
    actorUserId: input.userId,
    action: 'OUTREACH_SEND_RECORDED',
    entityType: 'OutreachRequest',
    entityId: request.id,
  });
}

/**
 * Records a reply from the organisation and turns it into evidence at authority
 * level 3 (an authorized representative), which is strong enough to support a
 * reviewer recording "verified".
 *
 * Replies are confidential by default and are never rendered in the applicant
 * portal.
 */
export async function recordOutreachResponse(input: {
  outreachId: string;
  organizationId: string;
  userId: string;
  respondentName: string;
  respondentRole?: string;
  content: string;
  receivedAt?: Date;
  relation?: EvidenceRelation;
  isConfidential?: boolean;
}): Promise<string> {
  const request = await prisma.outreachRequest.findFirstOrThrow({
    where: { id: input.outreachId, organizationId: input.organizationId },
  });

  const response = await prisma.$transaction(async (tx) => {
    const created = await tx.outreachResponse.create({
      data: {
        outreachRequestId: request.id,
        receivedAt: input.receivedAt ?? new Date(),
        respondentName: input.respondentName,
        respondentRole: input.respondentRole ?? null,
        content: input.content.slice(0, 20_000),
        authorityLevel: AuthorityLevel.L3_AUTHORIZED_REPRESENTATIVE,
        isConfidential: input.isConfidential ?? true,
        recordedByUserId: input.userId,
      },
    });

    await tx.outreachRequest.update({ where: { id: request.id }, data: { status: OutreachStatus.RESPONSE_RECEIVED } });

    if (request.claimId) {
      await tx.evidenceItem.create({
        data: {
          organizationId: input.organizationId,
          caseId: request.caseId,
          claimId: request.claimId,
          relation: input.relation ?? EvidenceRelation.SUPPORTING,
          statementType: StatementType.THIRD_PARTY_STATEMENT,
          authorityLevel: AuthorityLevel.L3_AUTHORIZED_REPRESENTATIVE,
          summary: `${request.recipientOrgName} replied to a verification request.`,
          detail: input.content.slice(0, 4000),
          outreachResponseId: created.id,
          createdByUserId: input.userId,
        },
      });
    }

    await recordAudit(
      {
        organizationId: input.organizationId,
        caseId: request.caseId,
        actorType: 'USER',
        actorUserId: input.userId,
        action: 'OUTREACH_RESPONSE_RECORDED',
        entityType: 'OutreachRequest',
        entityId: request.id,
        metadata: { responseId: created.id, respondent: input.respondentName },
      },
      tx,
    );

    return created;
  });

  if (request.claimId) await recomputeClaimProposal(request.claimId, input.organizationId);
  return response.id;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
