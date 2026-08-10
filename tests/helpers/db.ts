import { PrismaClient } from '@prisma/client';
import { hashPassword } from '@/lib/crypto';
import { ROLE_DEFINITIONS, ROLE_KEYS, type RoleKey } from '@/lib/auth/permissions';
import { POLICY_TEMPLATES } from '../../prisma/seed/policies';

export const prisma = new PrismaClient();

/** Wipes every table. Only ever runs against TEST_DATABASE_URL. */
export async function resetDatabase(): Promise<void> {
  if (!process.env['DATABASE_URL']?.includes('test')) {
    throw new Error(
      `Refusing to truncate a database whose URL does not contain "test": ${process.env['DATABASE_URL']}`,
    );
  }
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditEvent", "AnonymousTip", "RateLimitCounter", "RetentionRule", "Session",
      "ClarificationResponse", "ClarificationRequest", "OutreachResponse", "OutreachRequest",
      "Interview", "ReviewerDecision", "ReviewerNote", "Discrepancy", "VerificationTask",
      "EvidenceItem", "SourceCheck", "ClaimRevision", "ExtractedClaim", "DocumentPage",
      "ApplicationDocument", "ConsentRecord", "Case", "Applicant", "PolicyTemplate",
      "User", "Role", "Organization"
    RESTART IDENTITY CASCADE
  `);
}

export interface TestTenant {
  organizationId: string;
  policyId: string;
  users: Record<RoleKey, { id: string; email: string }>;
}

export async function seedRoles(): Promise<Record<RoleKey, string>> {
  const map = {} as Record<RoleKey, string>;
  for (const key of ROLE_KEYS) {
    const existing = await prisma.role.findUnique({ where: { key } });
    if (existing) {
      map[key] = existing.id;
      continue;
    }
    const definition = ROLE_DEFINITIONS[key];
    const role = await prisma.role.create({
      data: { key, name: definition.name, description: definition.description, permissions: definition.permissions },
    });
    map[key] = role.id;
  }
  return map;
}

export const TEST_PASSWORD = 'TestReviewer!2026';

/** Creates a fully-formed tenant: org, one user per role, and a policy. */
export async function createTenant(slug: string, policyKey = 'university-application'): Promise<TestTenant> {
  const roles = await seedRoles();

  const organization = await prisma.organization.create({
    data: { name: `Org ${slug}`, slug },
  });

  const template = POLICY_TEMPLATES.find((p) => p.key === policyKey)!;
  const policy = await prisma.policyTemplate.create({
    data: {
      organizationId: organization.id,
      key: template.key,
      name: template.name,
      useCase: template.useCase,
      description: template.description,
      relevantClaimCategories: template.relevantClaimCategories,
      approvedSourceKeys: template.approvedSourceKeys,
      evidenceRequirements: template.evidenceRequirements,
      retentionDays: template.retentionDays,
      escalationRules: template.escalationRules,
      reportLanguage: template.reportLanguage,
    },
  });

  const passwordHash = await hashPassword(TEST_PASSWORD);
  const users = {} as TestTenant['users'];

  for (const key of ROLE_KEYS) {
    const email = `${key.toLowerCase()}@${slug}.example`;
    const user = await prisma.user.create({
      data: { organizationId: organization.id, email, name: `${key} user`, roleId: roles[key], passwordHash },
    });
    users[key] = { id: user.id, email };
  }

  return { organizationId: organization.id, policyId: policy.id, users };
}

export interface TestCase {
  caseId: string;
  applicantId: string;
}

export async function createCase(
  tenant: TestTenant,
  options: { reference?: string; withConsent?: boolean } = {},
): Promise<TestCase> {
  const applicant = await prisma.applicant.create({
    data: { organizationId: tenant.organizationId, displayName: 'Test Applicant' },
  });

  const record = await prisma.case.create({
    data: {
      organizationId: tenant.organizationId,
      applicantId: applicant.id,
      policyTemplateId: tenant.policyId,
      reference: options.reference ?? `REF-${Math.random().toString(36).slice(2, 10)}`,
      title: 'Test case',
      assignedReviewerId: tenant.users.LEAD_REVIEWER.id,
    },
  });

  if (options.withConsent !== false) {
    await prisma.consentRecord.createMany({
      data: [
        {
          caseId: record.id,
          scope: 'EXTERNAL_PUBLIC_SOURCES',
          grantedAt: new Date(),
          grantedVia: 'Test consent',
        },
        {
          caseId: record.id,
          scope: 'ISSUING_ORGANIZATION_OUTREACH',
          grantedAt: new Date(),
          grantedVia: 'Test consent',
        },
      ],
    });
  }

  return { caseId: record.id, applicantId: applicant.id };
}

export async function uploadText(
  tenant: TestTenant,
  caseId: string,
  filename: string,
  content: string,
  kind: 'RESUME_CV' | 'APPLICATION' | 'RECOMMENDATION_LETTER' | 'TRANSCRIPT' | 'SUPPORTING_EVIDENCE' = 'RESUME_CV',
): Promise<string> {
  const { ingestDocument } = await import('@/modules/orchestrator');
  const result = await ingestDocument({
    caseId,
    organizationId: tenant.organizationId,
    filename,
    declaredMimeType: 'text/plain',
    bytes: Buffer.from(content, 'utf8'),
    kind,
    uploadedByUserId: tenant.users.LEAD_REVIEWER.id,
  });
  return result.documentId;
}
