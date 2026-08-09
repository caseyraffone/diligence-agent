import { prisma } from '@/lib/prisma';
import { NotFoundError } from '@/lib/errors';
import type { Actor } from './session';

/**
 * Tenant isolation.
 *
 * Every read of a case-scoped entity goes through a loader here. The loaders
 * take the organization id from the *session*, never from the request body or
 * query string, and fold it into the `where` clause. A row belonging to another
 * tenant is indistinguishable from a row that does not exist.
 *
 * The rule the tests enforce: no route may call `prisma.<caseEntity>.findUnique`
 * with only an id.
 */

export interface TenantScope {
  organizationId: string;
}

export function scopeOf(actor: Actor): TenantScope {
  return { organizationId: actor.organizationId };
}

export async function loadCase(actor: Actor, caseId: string) {
  const found = await prisma.case.findFirst({
    where: { id: caseId, organizationId: actor.organizationId },
    include: {
      applicant: true,
      policyTemplate: true,
      assignedReviewer: { select: { id: true, name: true, email: true } },
    },
  });
  if (!found) throw new NotFoundError(`Case ${caseId} not visible to organization ${actor.organizationId}`);
  return found;
}

export async function loadDocument(actor: Actor, documentId: string) {
  const found = await prisma.applicationDocument.findFirst({
    where: { id: documentId, organizationId: actor.organizationId },
  });
  if (!found) throw new NotFoundError(`Document ${documentId} not visible to this organization`);
  return found;
}

export async function loadClaim(actor: Actor, claimId: string) {
  const found = await prisma.extractedClaim.findFirst({
    where: { id: claimId, organizationId: actor.organizationId },
  });
  if (!found) throw new NotFoundError(`Claim ${claimId} not visible to this organization`);
  return found;
}

export async function loadDiscrepancy(actor: Actor, discrepancyId: string) {
  const found = await prisma.discrepancy.findFirst({
    where: { id: discrepancyId, organizationId: actor.organizationId },
  });
  if (!found) throw new NotFoundError(`Discrepancy ${discrepancyId} not visible to this organization`);
  return found;
}

export async function loadOutreach(actor: Actor, outreachId: string) {
  const found = await prisma.outreachRequest.findFirst({
    where: { id: outreachId, organizationId: actor.organizationId },
  });
  if (!found) throw new NotFoundError(`Outreach ${outreachId} not visible to this organization`);
  return found;
}

export async function loadClarification(actor: Actor, clarificationId: string) {
  const found = await prisma.clarificationRequest.findFirst({
    where: { id: clarificationId, organizationId: actor.organizationId },
  });
  if (!found) throw new NotFoundError(`Clarification ${clarificationId} not visible to this organization`);
  return found;
}

export async function loadInterview(actor: Actor, interviewId: string) {
  const found = await prisma.interview.findFirst({
    where: { id: interviewId, organizationId: actor.organizationId },
  });
  if (!found) throw new NotFoundError(`Interview ${interviewId} not visible to this organization`);
  return found;
}

export async function loadTip(actor: Actor, tipId: string) {
  const found = await prisma.anonymousTip.findFirst({
    where: { id: tipId, organizationId: actor.organizationId },
  });
  if (!found) throw new NotFoundError(`Tip ${tipId} not visible to this organization`);
  return found;
}
