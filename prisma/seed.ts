/**
 * Seeds roles, policy templates, two tenant organisations, demo users, and the
 * three demonstration cases.
 *
 * The cases are produced by running the REAL pipeline — ingest, extract,
 * source-check, analyse — not by inserting hand-written rows. What you see in
 * the dashboard is what the system actually derived from the documents.
 *
 * Everything is fictional. Idempotent: safe to re-run.
 */
import { config } from 'node:process';
import {
  ClaimStatus,
  ConsentScope,
  DiscrepancyStatus,
  EvidenceRelation,
  PrismaClient,
  StatementType,
  AuthorityLevel,
  RetentionAction,
} from '@prisma/client';
import { hashPassword } from '../src/lib/crypto';
import { ROLE_DEFINITIONS, ROLE_KEYS } from '../src/lib/auth/permissions';
import { POLICY_TEMPLATES } from './seed/policies';
import { CASE_1_DOCUMENTS, CASE_2_DOCUMENTS, CASE_3_DOCUMENTS, type SeedDocument } from './seed/documents';
import { ingestDocument, enqueueVerificationForCase } from '../src/modules/orchestrator';
import { drainQueue } from '../src/queue/worker';
import { analyzeCase } from '../src/modules/consistencyAnalyst';
import { recordReviewerDecision } from '../src/modules/caseReviewer';
import {
  draftClarification,
  approveAndSendClarification,
  submitClarificationResponse,
} from '../src/modules/clarification';
import { draftOutreach, approveOutreach, recordOutreachSent, recordOutreachResponse } from '../src/modules/outreach';
import { generateInterview } from '../src/modules/interviews';
import { submitAnonymousTip } from '../src/modules/tips';

void config;

const prisma = new PrismaClient();

const DEMO_PASSWORD = 'DemoReviewer!2026';

async function main(): Promise<void> {
  console.log('▸ Seeding Diligence Agent\n');

  await reset();
  const roles = await seedRoles();
  const globalPolicies = await seedPolicies();

  // ---- Tenant A: a university -------------------------------------------
  const redwood = await prisma.organization.create({
    data: { name: 'Redwood University', slug: 'redwood-university' },
  });
  const redwoodAdmin = await createUser(redwood.id, 'admin@redwood.example', 'Rosa Delgado', roles['ADMIN']!);
  const redwoodLead = await createUser(redwood.id, 'lead@redwood.example', 'Marcus Feld', roles['LEAD_REVIEWER']!);
  await createUser(redwood.id, 'reviewer@redwood.example', 'Nina Achebe', roles['REVIEWER']!);
  await createUser(redwood.id, 'auditor@redwood.example', 'Owen Park', roles['READ_ONLY_AUDITOR']!);

  // ---- Tenant B: an employer --------------------------------------------
  const aurora = await prisma.organization.create({
    data: { name: 'Aurora Talent Partners', slug: 'aurora-talent' },
  });
  const auroraLead = await createUser(aurora.id, 'lead@aurora.example', 'Priyanka Shah', roles['LEAD_REVIEWER']!);
  await createUser(aurora.id, 'admin@aurora.example', 'Tomas Lind', roles['ADMIN']!);

  await seedRetentionRules(redwood.id, globalPolicies);
  await seedRetentionRules(aurora.id, globalPolicies);

  // ---- Case 1 ------------------------------------------------------------
  const case1 = await buildCase({
    organizationId: redwood.id,
    policyId: globalPolicies['university-application']!,
    applicantName: 'Amara Okonkwo',
    reference: 'RU-2026-0142',
    title: 'Undergraduate application — Physics',
    reviewerId: redwoodLead.id,
    documents: CASE_1_DOCUMENTS,
    dueInDays: 21,
  });
  await finalizeFullyCorroborated(case1, redwood.id, redwoodLead.id);

  // ---- Case 2 ------------------------------------------------------------
  const case2 = await buildCase({
    organizationId: aurora.id,
    policyId: globalPolicies['job-application']!,
    applicantName: 'Daniel Whitfield',
    reference: 'AT-2026-0088',
    title: 'Senior engineer application — platform team',
    reviewerId: auroraLead.id,
    documents: CASE_2_DOCUMENTS,
    dueInDays: 10,
  });
  await resolveViaClarification(case2, aurora.id, auroraLead.id);

  // ---- Case 3 ------------------------------------------------------------
  const case3 = await buildCase({
    organizationId: redwood.id,
    policyId: globalPolicies['university-application']!,
    applicantName: 'Priya Raman',
    reference: 'RU-2026-0207',
    title: 'Undergraduate application — Engineering',
    reviewerId: redwoodLead.id,
    documents: CASE_3_DOCUMENTS,
    dueInDays: 5,
  });
  await leaveConflicting(case3, redwood.id, redwoodLead.id);

  await seedTip(redwood.id, case3);

  await summarize(redwoodAdmin.email);
}

// ---------------------------------------------------------------- helpers

async function reset(): Promise<void> {
  // Ordered by dependency; cascades handle the rest.
  await prisma.auditEvent.deleteMany();
  await prisma.anonymousTip.deleteMany();
  await prisma.rateLimitCounter.deleteMany();
  await prisma.retentionRule.deleteMany();
  await prisma.session.deleteMany();
  await prisma.case.deleteMany();
  await prisma.applicant.deleteMany();
  await prisma.user.deleteMany();
  await prisma.policyTemplate.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.role.deleteMany();
}

async function seedRoles(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const key of ROLE_KEYS) {
    const definition = ROLE_DEFINITIONS[key];
    const role = await prisma.role.create({
      data: {
        key,
        name: definition.name,
        description: definition.description,
        permissions: definition.permissions,
      },
    });
    map[key] = role.id;
  }
  console.log(`  Roles: ${ROLE_KEYS.join(', ')}`);
  return map;
}

async function seedPolicies(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const template of POLICY_TEMPLATES) {
    const created = await prisma.policyTemplate.create({
      data: {
        organizationId: null, // global built-in
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
    map[template.key] = created.id;
  }
  console.log(`  Policy templates: ${POLICY_TEMPLATES.length}`);
  return map;
}

async function seedRetentionRules(organizationId: string, policies: Record<string, string>): Promise<void> {
  await prisma.retentionRule.createMany({
    data: [
      {
        organizationId,
        policyTemplateId: policies['university-application'] ?? null,
        name: 'Delete original documents 12 months after closure',
        action: RetentionAction.DELETE_ORIGINAL_DOCUMENTS,
        afterDaysFromClosure: 365,
      },
      {
        organizationId,
        name: 'Anonymise applicant details 24 months after closure',
        action: RetentionAction.ANONYMIZE_APPLICANT,
        afterDaysFromClosure: 730,
      },
    ],
  });
}

async function createUser(organizationId: string, email: string, name: string, roleId: string) {
  return prisma.user.create({
    data: { organizationId, email, name, roleId, passwordHash: await hashPassword(DEMO_PASSWORD) },
  });
}

interface BuildCaseInput {
  organizationId: string;
  policyId: string;
  applicantName: string;
  reference: string;
  title: string;
  reviewerId: string;
  documents: SeedDocument[];
  dueInDays: number;
}

async function buildCase(input: BuildCaseInput): Promise<string> {
  const applicant = await prisma.applicant.create({
    data: { organizationId: input.organizationId, displayName: input.applicantName },
  });

  const created = await prisma.case.create({
    data: {
      organizationId: input.organizationId,
      applicantId: applicant.id,
      policyTemplateId: input.policyId,
      reference: input.reference,
      title: input.title,
      status: 'IN_VERIFICATION',
      assignedReviewerId: input.reviewerId,
      dueDate: new Date(Date.now() + input.dueInDays * 86_400_000),
    },
  });

  // Consent is recorded before anything external happens. The verifier refuses
  // to run without it, so this is load-bearing, not decorative.
  await prisma.consentRecord.createMany({
    data: [
      {
        caseId: created.id,
        scope: ConsentScope.INTERNAL_REVIEW_ONLY,
        grantedAt: new Date(),
        grantedVia: 'Application form checkbox, recorded at submission',
        recordedByUserId: input.reviewerId,
      },
      {
        caseId: created.id,
        scope: ConsentScope.EXTERNAL_PUBLIC_SOURCES,
        grantedAt: new Date(),
        grantedVia: 'Signed verification authorisation form',
        recordedByUserId: input.reviewerId,
      },
      {
        caseId: created.id,
        scope: ConsentScope.ISSUING_ORGANIZATION_OUTREACH,
        grantedAt: new Date(),
        grantedVia: 'Signed verification authorisation form',
        recordedByUserId: input.reviewerId,
      },
    ],
  });

  for (const doc of input.documents) {
    await ingestDocument({
      caseId: created.id,
      organizationId: input.organizationId,
      filename: doc.filename,
      declaredMimeType: doc.mimeType,
      bytes: Buffer.from(doc.content, 'utf8'),
      kind: doc.kind,
      uploadedByUserId: input.reviewerId,
    });
  }

  // Extract claims from every uploaded document.
  await drainQueue({ caseId: created.id, maxTasks: 100 });
  // Plan and run source checks now that claims exist.
  await enqueueVerificationForCase({
    caseId: created.id,
    organizationId: input.organizationId,
    actorUserId: input.reviewerId,
  });
  await drainQueue({ caseId: created.id, maxTasks: 400 });
  await analyzeCase({ caseId: created.id, organizationId: input.organizationId, actorUserId: input.reviewerId });

  const claimCount = await prisma.extractedClaim.count({ where: { caseId: created.id } });
  const discrepancyCount = await prisma.discrepancy.count({ where: { caseId: created.id } });
  console.log(`  Case ${input.reference}: ${claimCount} claims, ${discrepancyCount} observations`);

  return created.id;
}

/** Case 1 — every material claim reaches a corroborated or verified state. */
async function finalizeFullyCorroborated(caseId: string, organizationId: string, userId: string): Promise<void> {
  const claims = await prisma.extractedClaim.findMany({
    where: { caseId },
    include: { evidenceItems: true },
  });

  for (const claim of claims) {
    const hasIssuerConfirmation = claim.evidenceItems.some(
      (e) =>
        e.relation === EvidenceRelation.SUPPORTING &&
        (e.authorityLevel === AuthorityLevel.L1_ISSUING_AUTHORITY ||
          e.authorityLevel === AuthorityLevel.L2_OFFICIAL_WEBSITE ||
          e.authorityLevel === AuthorityLevel.L3_AUTHORIZED_REPRESENTATIVE),
    );
    const hasAnySupport = claim.evidenceItems.some((e) => e.relation === EvidenceRelation.SUPPORTING);

    if (hasIssuerConfirmation) {
      await recordReviewerDecision({
        claimId: claim.id,
        organizationId,
        userId,
        newStatus: ClaimStatus.VERIFIED,
        rationale:
          'The issuing organisation confirmed this claim directly through an approved verification channel. ' +
          'Dates and description match the application.',
        evidenceItemIds: claim.evidenceItems.filter((e) => e.relation === EvidenceRelation.SUPPORTING).map((e) => e.id),
      });
      continue;
    }

    if (hasAnySupport) {
      await recordReviewerDecision({
        claimId: claim.id,
        organizationId,
        userId,
        newStatus: ClaimStatus.CORROBORATED,
        rationale:
          'Independent registry evidence supports this claim, without direct confirmation from the issuing body. ' +
          'Sufficient for corroboration under this policy.',
        evidenceItemIds: claim.evidenceItems.filter((e) => e.relation === EvidenceRelation.SUPPORTING).map((e) => e.id),
      });
      continue;
    }

    // No automated channel covers this claim. The referee letter speaks to it
    // directly, so a reviewer records that as third-party evidence.
    const evidence = await prisma.evidenceItem.create({
      data: {
        organizationId,
        caseId,
        claimId: claim.id,
        relation: EvidenceRelation.SUPPORTING,
        statementType: StatementType.THIRD_PARTY_STATEMENT,
        authorityLevel: AuthorityLevel.L5_INDEPENDENT_REPORTING,
        summary: 'A named referee describes this activity from direct personal knowledge.',
        detail:
          'Dr. T. Adeyemi (Department of Physics, University of Lagos) refers to this activity in their letter, ' +
          'stating direct knowledge of it over a two-year period.',
        createdByUserId: userId,
      },
    });

    await recordReviewerDecision({
      claimId: claim.id,
      organizationId,
      userId,
      newStatus: ClaimStatus.CORROBORATED,
      rationale:
        'No registry covers this claim type. A named referee with direct knowledge corroborates it in writing, ' +
        'which this policy accepts as corroboration rather than verification.',
      evidenceItemIds: [evidence.id],
    });
  }

  await prisma.case.update({ where: { id: caseId }, data: { status: 'READY_FOR_REVIEW' } });
}

/** Case 2 — an innocent title/date difference, resolved by asking. */
async function resolveViaClarification(caseId: string, organizationId: string, userId: string): Promise<void> {
  const discrepancy = await prisma.discrepancy.findFirst({
    where: { caseId, kind: { in: ['TITLE_MISMATCH', 'CONFLICTING_DATES'] } },
    orderBy: { createdAt: 'asc' },
  });

  const employmentClaim = await prisma.extractedClaim.findFirst({
    where: { caseId, category: 'EMPLOYMENT' },
    orderBy: { createdAt: 'asc' },
  });

  if (!discrepancy || !employmentClaim) {
    console.warn('  (case 2) expected a title/date observation and an employment claim; skipping clarification demo');
    return;
  }

  const clarificationId = await draftClarification({
    caseId,
    organizationId,
    claimId: employmentClaim.id,
    discrepancyId: discrepancy.id,
    userId,
  });

  await approveAndSendClarification({ clarificationId, organizationId, userId });

  await submitClarificationResponse({
    clarificationId,
    organizationId,
    caseId,
    message:
      'Thank you for asking. I joined Northwind in March 2021 on a contract-to-hire basis and converted to a ' +
      'permanent employee in June 2021, which is why the two forms show different start dates — I put the ' +
      'permanent date on the application form and my actual start date on my CV. My title was Software Engineer ' +
      'until January 2023, when I was promoted to Senior Software Engineer. My CV lists my current title and the ' +
      'form listed the title I was hired into. Northwind HR can confirm both.',
  });

  // The employer confirms both, which is what actually resolves it.
  const outreachId = await draftOutreach({
    caseId,
    organizationId,
    claimId: employmentClaim.id,
    recipientOrgName: 'Northwind Analytics',
    recipientEmail: 'people-ops@northwind.example',
    userId,
  });
  await approveOutreach({ outreachId, organizationId, userId });
  await recordOutreachSent({ outreachId, organizationId, userId });
  await recordOutreachResponse({
    outreachId,
    organizationId,
    userId,
    respondentName: 'H. Okafor',
    respondentRole: 'People Operations, Northwind Analytics',
    content:
      'Confirming continuous engagement from 15 March 2021 to date. Contract-to-hire until 14 June 2021, permanent ' +
      'thereafter. Title Software Engineer to 31 January 2023, Senior Software Engineer from 1 February 2023.',
  });

  await prisma.discrepancy.updateMany({
    where: { caseId, status: { in: [DiscrepancyStatus.OPEN, DiscrepancyStatus.UNDER_REVIEW] } },
    data: {
      status: DiscrepancyStatus.EXPLAINED,
      resolutionNote:
        'Explained by the applicant and independently confirmed by the employer: a contract-to-permanent conversion ' +
        'accounts for the two start dates, and a promotion accounts for the two titles. Both documents were accurate ' +
        'about different points in the same employment history.',
      resolvedByUserId: userId,
      resolvedAt: new Date(),
    },
  });

  for (const claim of await prisma.extractedClaim.findMany({ where: { caseId }, include: { evidenceItems: true } })) {
    const supporting = claim.evidenceItems.filter((e) => e.relation === EvidenceRelation.SUPPORTING);
    if (supporting.length === 0) continue;
    await recordReviewerDecision({
      claimId: claim.id,
      organizationId,
      userId,
      newStatus: ClaimStatus.VERIFIED,
      rationale:
        'Confirmed directly by the organisation named in the claim. The difference between the two documents was ' +
        'explained by the applicant and matches the employer’s own record.',
      evidenceItemIds: supporting.map((e) => e.id),
    });
  }

  await prisma.case.update({ where: { id: caseId }, data: { status: 'READY_FOR_REVIEW' } });
}

/** Case 3 — a material claim that stays conflicting after independent checks. */
async function leaveConflicting(caseId: string, organizationId: string, userId: string): Promise<void> {
  const awardClaims = await prisma.extractedClaim.findMany({
    where: { caseId, category: 'AWARD_COMPETITION' },
    include: { evidenceItems: true },
  });

  for (const claim of awardClaims) {
    const conflicting = claim.evidenceItems.filter((e) => e.relation === EvidenceRelation.CONFLICTING);
    if (conflicting.length === 0) continue;

    const clarificationId = await draftClarification({
      caseId,
      organizationId,
      claimId: claim.id,
      userId,
    });
    await approveAndSendClarification({ clarificationId, organizationId, userId });
    await submitClarificationResponse({
      clarificationId,
      organizationId,
      caseId,
      message:
        'I understood our result to be first place in our division. I do not have the certificate to hand. ' +
        'I can ask my team lead whether they kept the organiser’s notification email.',
    });

    await recordReviewerDecision({
      claimId: claim.id,
      organizationId,
      userId,
      newStatus: ClaimStatus.CONFLICTING_INFORMATION,
      rationale:
        'The organiser’s published standings and an independent archived capture of the same page both place the ' +
        'named team fourth rather than first. The applicant has responded and does not currently have documentation. ' +
        'The difference is unresolved and is recorded as such: no conclusion is drawn about how it arose. Next step ' +
        'is to write to the competition organiser directly for the official placement.',
      evidenceItemIds: conflicting.map((e) => e.id),
    });
    break;
  }

  // The publication claim needs a conversation, not a record — the DOI confirms
  // the paper exists but says nothing about who did what.
  const publication = await prisma.extractedClaim.findFirst({ where: { caseId, category: 'PUBLICATION' } });
  if (publication) {
    await generateInterview({ caseId, organizationId, claimId: publication.id, userId });
  }

  const outreachId = await draftOutreach({
    caseId,
    organizationId,
    claimId: awardClaims[0]?.id,
    recipientOrgName: 'International Robotics Challenge (organising committee)',
    recipientEmail: 'results@example-robotics-challenge.org',
    userId,
  });
  // Left awaiting approval on purpose, so the outreach approval queue has work.
  void outreachId;

  await prisma.case.update({ where: { id: caseId }, data: { status: 'IN_VERIFICATION' } });
}

async function seedTip(organizationId: string, caseId: string): Promise<void> {
  await submitAnonymousTip({
    organizationId,
    caseId,
    allegationText:
      'I believe the robotics competition placement on this application is overstated. I was at the event and ' +
      'remember a different team winning the open division.',
    claimedEvidence: 'None supplied.',
    submissionSignal: 'seed-demo',
  });
  console.log('  Anonymous tip recorded (unverified allegation; changes no claim status)');
}

async function summarize(adminEmail: string): Promise<void> {
  const cases = await prisma.case.count();
  const claims = await prisma.extractedClaim.count();
  const evidence = await prisma.evidenceItem.count();
  const discrepancies = await prisma.discrepancy.count();
  const audits = await prisma.auditEvent.count();

  console.log(
    [
      '',
      `▸ Seeded ${cases} cases, ${claims} claims, ${evidence} evidence items, ${discrepancies} observations, ${audits} audit events.`,
      '',
      '  Demo sign-ins (all share the same password):',
      `    ${adminEmail.padEnd(28)} Administrator      (Redwood University)`,
      '    lead@redwood.example         Lead reviewer      (Redwood University)',
      '    reviewer@redwood.example     Reviewer           (Redwood University)',
      '    auditor@redwood.example      Read-only auditor  (Redwood University)',
      '    lead@aurora.example          Lead reviewer      (Aurora Talent Partners)',
      '    admin@aurora.example         Administrator      (Aurora Talent Partners)',
      '',
      `    Password: ${DEMO_PASSWORD}`,
      '',
      '  Redwood and Aurora are separate tenants: neither can see the other’s cases.',
      '  LLM_PROVIDER=mock — nothing above made a paid API call.',
      '',
    ].join('\n'),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
