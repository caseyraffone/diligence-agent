import { ClaimStatus, ClarificationStatus, ConsentScope, EvidenceRelation, AuthorityLevel, StatementType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recordAudit } from '@/lib/audit/audit';
import { getEnv } from '@/lib/env';
import { issuePortalToken } from '@/lib/auth/portalToken';
import { ConflictError, ValidationError } from '@/lib/errors';
import { runStructured } from '@/providers/llm/client';
import { ClarificationDraftResponseSchema, CLARIFICATION_DRAFT_HINT, findProhibitedCharacterizations } from '@/providers/llm/schemas';
import { recomputeClaimProposal } from './evidenceVerifier';

/**
 * APPLICANT CLARIFICATION WORKFLOW
 *
 * The fairness path. A person gets to see the specific claim, the specific
 * concern, and what would resolve it, in neutral language, before anyone
 * records a conclusion about them.
 *
 * The sequence is enforced by status, not by convention:
 *   DRAFT → PENDING_APPROVAL → APPROVED → SENT → RESPONDED → CLOSED
 *
 * Two things the system will not do:
 *  - send anything itself (a reviewer sends it and records that they did);
 *  - reveal confidential referee replies or anonymous tips to the applicant.
 *    The portal only ever renders the request and the applicant's own responses.
 */

export interface DraftClarificationInput {
  caseId: string;
  organizationId: string;
  claimId?: string;
  discrepancyId?: string;
  userId: string;
}

export async function draftClarification(input: DraftClarificationInput): Promise<string> {
  const [claim, discrepancy] = await Promise.all([
    input.claimId
      ? prisma.extractedClaim.findFirstOrThrow({ where: { id: input.claimId, organizationId: input.organizationId } })
      : null,
    input.discrepancyId
      ? prisma.discrepancy.findFirstOrThrow({ where: { id: input.discrepancyId, organizationId: input.organizationId } })
      : null,
  ]);

  if (!claim && !discrepancy) {
    throw new ValidationError('A clarification request must reference a claim or a discrepancy.');
  }

  const claimText = claim?.normalizedText ?? 'the item under review';
  const issueText =
    discrepancy?.description ??
    'We were not able to confirm this item through the sources available to us, and would like your help.';

  const drafted = await runStructured({
    task: 'DRAFT_CLARIFICATION',
    instruction:
      'Draft a neutral, respectful request asking the applicant to clarify or provide evidence for one item. ' +
      'State the item and the specific point needing clarification. Do not accuse, do not imply dishonesty, do not ' +
      'suggest any consequence, and do not state or imply that the item is false. Acknowledge that there may be an ' +
      'ordinary explanation. List concrete forms of evidence that would help.',
    untrusted: [
      { label: 'claim under review', content: claimText },
      { label: 'observation requiring clarification', content: issueText },
    ],
    schema: ClarificationDraftResponseSchema,
    schemaName: 'ClarificationDraftResponse',
    schemaHint: CLARIFICATION_DRAFT_HINT,
  });

  // Reviewer-facing and applicant-facing language is part of the safety design.
  // A draft that characterises the person is rejected rather than shown.
  const prohibited = findProhibitedCharacterizations(`${drafted.data.subject} ${drafted.data.body}`);
  if (prohibited.length > 0) {
    throw new ConflictError(
      `The generated draft used language that characterises the applicant (${prohibited.join(', ')}) and was rejected. ` +
        'Write the request manually, or regenerate it.',
    );
  }

  const created = await prisma.clarificationRequest.create({
    data: {
      organizationId: input.organizationId,
      caseId: input.caseId,
      claimId: input.claimId ?? null,
      discrepancyId: input.discrepancyId ?? null,
      status: ClarificationStatus.DRAFT,
      subject: drafted.data.subject,
      body: drafted.data.body,
      acceptableEvidence: drafted.data.acceptableEvidence,
      dueDate: new Date(Date.now() + 14 * 86_400_000),
    },
  });

  await recordAudit({
    organizationId: input.organizationId,
    caseId: input.caseId,
    actorType: 'USER',
    actorUserId: input.userId,
    action: 'CLARIFICATION_DRAFTED',
    entityType: 'ClarificationRequest',
    entityId: created.id,
    metadata: { claimId: input.claimId ?? null, discrepancyId: input.discrepancyId ?? null },
  });

  return created.id;
}

/** Reviewer edits before approval. The draft is theirs to change. */
export async function editClarification(input: {
  clarificationId: string;
  organizationId: string;
  userId: string;
  subject: string;
  body: string;
  acceptableEvidence: string[];
  dueDate?: Date | null;
}): Promise<void> {
  const request = await prisma.clarificationRequest.findFirstOrThrow({
    where: { id: input.clarificationId, organizationId: input.organizationId },
  });
  if (request.status !== ClarificationStatus.DRAFT && request.status !== ClarificationStatus.PENDING_APPROVAL) {
    throw new ConflictError('Only a draft or pending request can be edited.');
  }

  await prisma.clarificationRequest.update({
    where: { id: request.id },
    data: {
      subject: input.subject,
      body: input.body,
      acceptableEvidence: input.acceptableEvidence,
      dueDate: input.dueDate ?? request.dueDate,
      status: ClarificationStatus.PENDING_APPROVAL,
    },
  });

  await recordAudit({
    organizationId: input.organizationId,
    caseId: request.caseId,
    actorType: 'USER',
    actorUserId: input.userId,
    action: 'CLARIFICATION_EDITED',
    entityType: 'ClarificationRequest',
    entityId: request.id,
  });
}

export interface ApproveClarificationResult {
  portalUrl: string;
  expiresAt: Date;
}

/**
 * Approves a request and mints the applicant's single-purpose link.
 *
 * The URL is returned exactly once, to the approving reviewer, who sends it
 * through their own channel. Only its hash is stored.
 */
export async function approveAndSendClarification(input: {
  clarificationId: string;
  organizationId: string;
  userId: string;
}): Promise<ApproveClarificationResult> {
  const request = await prisma.clarificationRequest.findFirstOrThrow({
    where: { id: input.clarificationId, organizationId: input.organizationId },
  });

  if (request.status === ClarificationStatus.SENT || request.status === ClarificationStatus.RESPONDED) {
    throw new ConflictError('This clarification request has already been sent.');
  }

  const grant = issuePortalToken(getEnv().APP_BASE_URL);

  await prisma.$transaction(async (tx) => {
    await tx.clarificationRequest.update({
      where: { id: request.id },
      data: {
        status: ClarificationStatus.SENT,
        approvedByUserId: input.userId,
        approvedAt: new Date(),
        sentRecordedAt: new Date(),
        tokenHash: grant.tokenHash,
        tokenExpiresAt: grant.expiresAt,
      },
    });

    // The claim moves to "clarification requested" — an evidence state that
    // records we are waiting, not a judgement.
    if (request.claimId) {
      await tx.extractedClaim.update({
        where: { id: request.claimId },
        data: { status: ClaimStatus.APPLICANT_CLARIFICATION_REQUESTED },
      });
    }

    await recordAudit(
      {
        organizationId: input.organizationId,
        caseId: request.caseId,
        actorType: 'USER',
        actorUserId: input.userId,
        action: 'CLARIFICATION_APPROVED_AND_LINK_ISSUED',
        entityType: 'ClarificationRequest',
        entityId: request.id,
        // The token itself is never audited — only that a link was issued.
        metadata: { expiresAt: grant.expiresAt.toISOString() },
      },
      tx,
    );
  });

  return { portalUrl: grant.url, expiresAt: grant.expiresAt };
}

/**
 * Records an applicant's response.
 *
 * The original claim, the original extraction, and the prior evidence are all
 * preserved — the response is added alongside them. Nothing in the history is
 * rewritten by a later explanation.
 */
export async function submitClarificationResponse(input: {
  clarificationId: string;
  organizationId: string;
  caseId: string;
  message: string;
  documentIds?: string[];
}): Promise<string> {
  const request = await prisma.clarificationRequest.findFirstOrThrow({
    where: { id: input.clarificationId, organizationId: input.organizationId },
  });

  if (request.status !== ClarificationStatus.SENT && request.status !== ClarificationStatus.RESPONDED) {
    throw new ConflictError('This request is not open for a response.');
  }
  if (input.message.trim().length < 2) {
    throw new ValidationError('Please include a short explanation with your response.');
  }

  const response = await prisma.$transaction(async (tx) => {
    const created = await tx.clarificationResponse.create({
      data: {
        clarificationRequestId: request.id,
        message: input.message.slice(0, 20_000),
        documentIds: input.documentIds ?? [],
      },
    });

    await tx.clarificationRequest.update({
      where: { id: request.id },
      data: { status: ClarificationStatus.RESPONDED },
    });

    // The applicant's explanation becomes evidence in its own right — typed as
    // an applicant statement at authority level 6, so it can support a claim
    // but cannot by itself carry it to "verified".
    if (request.claimId) {
      await tx.evidenceItem.create({
        data: {
          organizationId: input.organizationId,
          caseId: request.caseId,
          claimId: request.claimId,
          relation: EvidenceRelation.SUPPORTING,
          statementType: StatementType.APPLICANT_STATEMENT,
          authorityLevel: AuthorityLevel.L6_APPLICANT_PROVIDED,
          summary: 'The applicant responded to a clarification request.',
          detail: input.message.slice(0, 4000),
          clarificationResponseId: created.id,
        },
      });
    }

    await recordAudit(
      {
        organizationId: input.organizationId,
        caseId: request.caseId,
        actorType: 'APPLICANT',
        action: 'CLARIFICATION_RESPONSE_RECEIVED',
        entityType: 'ClarificationRequest',
        entityId: request.id,
        metadata: { responseId: created.id, attachments: (input.documentIds ?? []).length },
      },
      tx,
    );

    return created;
  });

  // Re-evaluate, but never to a conclusion: the reviewer still records the
  // final status. This only refreshes the system's proposal.
  if (request.claimId) {
    await recomputeClaimProposal(request.claimId, input.organizationId);
    await prisma.extractedClaim.update({
      where: { id: request.claimId },
      data: { status: ClaimStatus.HUMAN_REVIEW_REQUIRED },
    });
  }

  return response.id;
}

export async function closeClarification(input: {
  clarificationId: string;
  organizationId: string;
  userId: string;
}): Promise<void> {
  const request = await prisma.clarificationRequest.findFirstOrThrow({
    where: { id: input.clarificationId, organizationId: input.organizationId },
  });

  await prisma.clarificationRequest.update({
    where: { id: request.id },
    data: {
      status: ClarificationStatus.CLOSED,
      closedAt: new Date(),
      // Revoke the applicant's link when the exchange is finished.
      tokenHash: null,
      tokenExpiresAt: null,
    },
  });

  await recordAudit({
    organizationId: input.organizationId,
    caseId: request.caseId,
    actorType: 'USER',
    actorUserId: input.userId,
    action: 'CLARIFICATION_CLOSED',
    entityType: 'ClarificationRequest',
    entityId: request.id,
  });
}

export async function hasApplicantContactConsent(caseId: string): Promise<boolean> {
  const consent = await prisma.consentRecord.findFirst({
    where: { caseId, scope: ConsentScope.INTERNAL_REVIEW_ONLY, revokedAt: null },
  });
  return Boolean(consent);
}
