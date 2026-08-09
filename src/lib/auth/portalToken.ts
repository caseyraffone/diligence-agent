import { prisma } from '@/lib/prisma';
import { randomToken, sha256 } from '@/lib/crypto';
import { NotFoundError } from '@/lib/errors';

/**
 * Applicant portal access.
 *
 * Applicants never receive an account. Each clarification request carries one
 * single-purpose, expiring, revocable token. The token grants visibility of
 * exactly one clarification request — its claim, the stated issue, and the
 * acceptable evidence — and the ability to respond to it. It does not grant
 * access to the case, to other claims, to reviewer notes, to third-party
 * responses, or to anonymous tips.
 *
 * Only the SHA-256 of the token is stored. A database reader cannot mint a
 * working link from the stored value.
 */

const DEFAULT_TTL_DAYS = 21;

export interface IssuedPortalToken {
  token: string;
  expiresAt: Date;
  /** Full URL to hand to the applicant. Shown to the reviewer exactly once. */
  url: string;
}

export function issuePortalToken(baseUrl: string, ttlDays: number = DEFAULT_TTL_DAYS): IssuedPortalToken & { tokenHash: string } {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  return {
    token,
    tokenHash: sha256(token),
    expiresAt,
    url: `${baseUrl.replace(/\/$/, '')}/portal/${token}`,
  };
}

export interface PortalContext {
  clarificationId: string;
  caseId: string;
  organizationId: string;
  subject: string;
  body: string;
  acceptableEvidence: string[];
  dueDate: Date | null;
  status: string;
  /** The specific claim under discussion, or null for a case-level question. */
  claim: {
    id: string;
    normalizedText: string;
    category: string;
    organizationName: string | null;
    title: string | null;
  } | null;
  responses: Array<{ id: string; submittedAt: Date; message: string; documentIds: string[] }>;
}

/**
 * Resolves a raw portal token. Returns null for unknown, expired, or
 * not-yet-sent requests without distinguishing between them.
 */
export async function resolvePortalToken(token: string): Promise<PortalContext | null> {
  if (!token || token.length < 20) return null;

  const request = await prisma.clarificationRequest.findUnique({
    where: { tokenHash: sha256(token) },
    include: {
      claim: {
        select: { id: true, normalizedText: true, category: true, organizationName: true, title: true },
      },
      responses: {
        orderBy: { submittedAt: 'asc' },
        select: { id: true, submittedAt: true, message: true, documentIds: true },
      },
    },
  });

  if (!request) return null;
  if (!request.tokenExpiresAt || request.tokenExpiresAt.getTime() <= Date.now()) return null;
  // A draft or unapproved request is not yet visible to the applicant.
  if (request.status !== 'SENT' && request.status !== 'RESPONDED') return null;

  return {
    clarificationId: request.id,
    caseId: request.caseId,
    organizationId: request.organizationId,
    subject: request.subject,
    body: request.body,
    acceptableEvidence: request.acceptableEvidence,
    dueDate: request.dueDate,
    status: request.status,
    claim: request.claim
      ? {
          id: request.claim.id,
          normalizedText: request.claim.normalizedText,
          category: request.claim.category,
          organizationName: request.claim.organizationName,
          title: request.claim.title,
        }
      : null,
    responses: request.responses,
  };
}

export async function requirePortalContext(token: string): Promise<PortalContext> {
  const context = await resolvePortalToken(token);
  if (!context) throw new NotFoundError('This link is not valid, has expired, or has been withdrawn.');
  return context;
}

/** Invalidates a link without deleting the clarification history. */
export async function revokePortalToken(clarificationId: string): Promise<void> {
  await prisma.clarificationRequest.update({
    where: { id: clarificationId },
    data: { tokenHash: null, tokenExpiresAt: null },
  });
}
