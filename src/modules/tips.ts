import { TipStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recordAudit } from '@/lib/audit/audit';
import { sha256, hmac } from '@/lib/crypto';
import { contentFingerprint } from '@/lib/text';
import { enforceRateLimit } from '@/lib/ratelimit';
import { getEnv } from '@/lib/env';
import { ValidationError } from '@/lib/errors';

/**
 * ANONYMOUS TIP INTAKE
 *
 * A tip is an ALLEGATION. It is never evidence, and it never changes a claim's
 * status — there is no code path from a tip to a ClaimStatus, by construction.
 *
 * The protections here are for the person being accused, who cannot defend
 * themselves against something they will never see:
 *
 *  - A tip cannot alter any claim. To matter, it must lead a reviewer to find
 *    independent corroboration, and that corroboration becomes the evidence.
 *  - Duplicates are suppressed so repeat submissions cannot manufacture the
 *    appearance of corroboration through volume.
 *  - Rate limiting blunts campaigns against an individual.
 *  - Access is restricted to roles holding `tip:read`.
 *  - Tips are never shown to the applicant, and tipster identity is not
 *    collected at all — there is nothing to leak.
 *
 * A tip alleging a protected characteristic, or containing only abuse, is
 * closed as out of scope rather than recorded against the person.
 */

const OUT_OF_SCOPE_PATTERNS = [
  // Allegations that turn on a protected characteristic are not verification
  // matters and must not become part of a case file.
  /\b(race|racial|ethnic|religion|religious|muslim|jewish|christian|hindu|disab(led|ility)|pregnan|gay|lesbian|transgender|sexual orientation|immigration status|undocumented|visa status|mental (health|illness)|medical condition)\b/i,
];

export interface SubmitTipInput {
  organizationId: string;
  caseId?: string;
  allegationText: string;
  claimedEvidence?: string;
  /** Coarse submitter signal for rate limiting only. Never an identity. */
  submissionSignal?: string;
}

export interface SubmitTipResult {
  tipId: string | null;
  status: TipStatus;
  message: string;
}

export async function submitAnonymousTip(input: SubmitTipInput): Promise<SubmitTipResult> {
  const text = input.allegationText.trim();
  if (text.length < 20) {
    throw new ValidationError('Please describe the concern in at least 20 characters so a reviewer can assess it.');
  }
  if (text.length > 10_000) {
    throw new ValidationError('Please keep the submission under 10,000 characters.');
  }

  await enforceRateLimit({
    scope: 'tip',
    identifier: input.submissionSignal ?? input.organizationId,
    limit: getEnv().TIP_RATE_LIMIT_PER_HOUR,
    windowSeconds: 3600,
  });

  const contentHash = sha256(contentFingerprint(text));

  const existing = await prisma.anonymousTip.findFirst({
    where: { organizationId: input.organizationId, contentHash },
  });

  if (existing) {
    // Recorded but suppressed. Submitting the same allegation ten times must
    // not make it ten times more persuasive.
    await recordAudit({
      organizationId: input.organizationId,
      caseId: existing.caseId,
      actorType: 'ANONYMOUS',
      action: 'TIP_DUPLICATE_SUPPRESSED',
      entityType: 'AnonymousTip',
      entityId: existing.id,
    });
    return {
      tipId: null,
      status: TipStatus.DUPLICATE_SUPPRESSED,
      message: 'Thank you. A submission with this content has already been received and is with a reviewer.',
    };
  }

  const outOfScope = OUT_OF_SCOPE_PATTERNS.some((p) => p.test(text));

  const tip = await prisma.anonymousTip.create({
    data: {
      organizationId: input.organizationId,
      caseId: input.caseId ?? null,
      allegationText: text,
      claimedEvidence: input.claimedEvidence?.slice(0, 5000) ?? null,
      contentHash,
      submissionFingerprint: input.submissionSignal ? hmac(input.submissionSignal, 'tip-fingerprint') : null,
      status: outOfScope ? TipStatus.CLOSED_OUT_OF_SCOPE : TipStatus.RECEIVED,
      reviewNote: outOfScope
        ? 'Automatically closed: the submission refers to a characteristic that is out of scope for credential ' +
          'verification and must not be used in any assessment. It is retained only so the closure is auditable.'
        : null,
    },
  });

  await recordAudit({
    organizationId: input.organizationId,
    caseId: input.caseId ?? null,
    actorType: 'ANONYMOUS',
    action: outOfScope ? 'TIP_CLOSED_OUT_OF_SCOPE' : 'TIP_RECEIVED',
    entityType: 'AnonymousTip',
    entityId: tip.id,
    metadata: { linkedToCase: Boolean(input.caseId) },
  });

  return {
    tipId: tip.id,
    status: tip.status,
    message:
      'Thank you. Your submission has been recorded as an unverified allegation. It will not change any ' +
      'assessment on its own — a reviewer will look for independent evidence before anything follows from it.',
  };
}

/**
 * Reviewer triage. Note what is absent: there is no parameter here that touches
 * a claim's status, and no way to promote a tip to evidence. A reviewer acting
 * on a tip does so by running source checks or drafting outreach, whose results
 * become evidence on their own merits.
 */
export async function triageTip(input: {
  tipId: string;
  organizationId: string;
  userId: string;
  status: Extract<
    TipStatus,
    | 'UNDER_REVIEW'
    | 'CORROBORATION_REQUIRED'
    | 'INDEPENDENTLY_CORROBORATED'
    | 'CLOSED_UNSUBSTANTIATED'
    | 'CLOSED_OUT_OF_SCOPE'
  >;
  reviewNote: string;
  caseId?: string;
}): Promise<void> {
  const tip = await prisma.anonymousTip.findFirstOrThrow({
    where: { id: input.tipId, organizationId: input.organizationId },
  });

  if (input.reviewNote.trim().length < 10) {
    throw new ValidationError('Record a short note explaining the triage decision.');
  }

  if (input.status === TipStatus.INDEPENDENTLY_CORROBORATED) {
    // "Corroborated" must mean corroborated by something other than the tip.
    const evidenceCount = tip.caseId
      ? await prisma.evidenceItem.count({
          where: {
            caseId: input.caseId ?? tip.caseId,
            statementType: { in: ['CONFIRMED_FACT', 'THIRD_PARTY_STATEMENT'] },
          },
        })
      : 0;
    if (evidenceCount === 0) {
      throw new ValidationError(
        'A tip cannot be marked independently corroborated while the case holds no confirmed or third-party ' +
          'evidence. Gather the corroborating evidence first; it, not the tip, is what supports a finding.',
      );
    }
  }

  await prisma.anonymousTip.update({
    where: { id: tip.id },
    data: {
      status: input.status,
      reviewNote: input.reviewNote,
      reviewedByUserId: input.userId,
      reviewedAt: new Date(),
      caseId: input.caseId ?? tip.caseId,
    },
  });

  await recordAudit({
    organizationId: input.organizationId,
    caseId: input.caseId ?? tip.caseId,
    actorType: 'USER',
    actorUserId: input.userId,
    action: 'TIP_TRIAGED',
    entityType: 'AnonymousTip',
    entityId: tip.id,
    metadata: { from: tip.status, to: input.status },
  });
}
