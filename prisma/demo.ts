/**
 * Camera-ready demonstration cases.
 *
 *   npm run demo
 *
 * Seeds exactly three synthetic candidates in one tenant, with clean references
 * and no clutter, for recording a walkthrough. Everything is fictional.
 *
 * The three are chosen to tell one story in order:
 *
 *   DEMO-1  An ordinary, legitimate person. The system confirms what it can,
 *           says "unable to verify" for the rest, and raises NOTHING. This is
 *           the false-positive philosophy, on screen.
 *   DEMO-2  A genuine conflict. Two independent sources hold records that
 *           differ from the claim, so it routes to a human.
 *   DEMO-3  A publication. Confirms a work through an authoritative registry,
 *           and shows the careful handling when a name is not in the author list.
 *
 * Run `npm run db:reset && npm run demo` for a clean slate before recording.
 */
import { PrismaClient, type DocumentKind } from '@prisma/client';
import { ingestDocument, enqueueVerificationForCase } from '../src/modules/orchestrator';
import { drainQueue } from '../src/queue/worker';
import { analyzeCase } from '../src/modules/consistencyAnalyst';
import { recordReviewerDecision } from '../src/modules/caseReviewer';
import { draftClarification, approveAndSendClarification } from '../src/modules/clarification';
import { draftOutreach } from '../src/modules/outreach';

const prisma = new PrismaClient();

interface DemoDoc {
  filename: string;
  kind: DocumentKind;
  content: string;
}

// ---------------------------------------------------------------- DEMO-1

/**
 * The point of this candidate is that NOTHING is flagged.
 *
 * She has a summer internship during her degree (the commonest false positive
 * in screening), an employer with no public employment record, and volunteering
 * no registry covers. A careless system flags all three. This one confirms the
 * organisations, states plainly that the engagements are unverified, and raises
 * no observation at all.
 */
const DEMO_1: DemoDoc[] = [
  {
    filename: 'chen-resume.txt',
    kind: 'RESUME_CV',
    content: `MAYA CHEN

EDUCATION
B.S. Economics, Riverton State University (Aug 2020 - May 2024)

EXPERIENCE
Summer Analyst Intern, Star Mountain Capital (Jun 2023 - Aug 2023)
- Built a screening model reviewed by 4 investment professionals

VOLUNTEER
Mathematics Tutor, Elmwood Community Trust (Sep 2022 - May 2024)
- Delivered 180 hours of free tutoring
`,
  },
  {
    filename: 'chen-application.txt',
    kind: 'APPLICATION',
    content: `EMPLOYMENT APPLICATION — DECLARED HISTORY

EDUCATION
B.S. Economics, Riverton State University (Aug 2020 - May 2024)

EXPERIENCE
Summer Analyst Intern, Star Mountain Capital (Jun 2023 - Aug 2023)
`,
  },
];

// ---------------------------------------------------------------- DEMO-2

const DEMO_2: DemoDoc[] = [
  {
    filename: 'raman-cv.txt',
    kind: 'RESUME_CV',
    content: `PRIYA RAMAN

AWARDS
First Place, International Robotics Challenge (2023)

EXPERIENCE
Robotics Research Intern, Aurora Robotics Lab (Jun 2023 - Sep 2023)
`,
  },
  {
    filename: 'raman-statement.txt',
    kind: 'APPLICATION',
    content: `PERSONAL STATEMENT

AWARDS
First Place, International Robotics Challenge (2023)
`,
  },
];

// ---------------------------------------------------------------- DEMO-3

/**
 * Two publications on purpose.
 *
 * The first resolves against the registry and confirms the work exists. The
 * second uses a REAL DOI, so with ENABLE_LIVE_SOURCES=true it makes a genuine
 * network call to Crossref during the recording. Offline it reports an evidence
 * gap, which is also a truthful thing to show.
 */
const DEMO_3: DemoDoc[] = [
  {
    filename: 'okonkwo-cv.txt',
    kind: 'RESUME_CV',
    content: `AMARA OKONKWO

EDUCATION
Diploma Programme, Lagos International College (Sep 2021 - Jun 2025)

RESEARCH
Summer Research Assistant, University of Lagos (Jun 2024 - Aug 2024)

PUBLICATIONS
Okonkwo, A.; Adeyemi, T. "Low-cost spectrometry for classroom physics: a field trial in three Lagos schools." Journal of Undergraduate Physics Education, 2024. doi:10.5281/zenodo.7654321
Okonkwo, A. "Contribution to a review of deep learning methods." Nature, 2015. doi:10.1038/nature14539
`,
  },
];

// ---------------------------------------------------------------- runner

async function main(): Promise<void> {
  console.log('▸ Seeding demonstration candidates\n');

  const org = await prisma.organization.findFirst({ where: { slug: 'aurora-talent' } });
  const university = await prisma.organization.findFirst({ where: { slug: 'redwood-university' } });
  if (!org || !university) {
    console.error('Run `npm run setup` first — the demo builds on the seeded organisations.');
    process.exit(1);
  }

  // Remove any previous demo run so references stay clean on camera.
  await prisma.case.deleteMany({ where: { reference: { startsWith: 'DEMO-' } } });

  const jobPolicy = await prisma.policyTemplate.findFirstOrThrow({ where: { key: 'job-application' } });
  const uniPolicy = await prisma.policyTemplate.findFirstOrThrow({ where: { key: 'university-application' } });

  const employerReviewer = await prisma.user.findFirstOrThrow({
    where: { organizationId: org.id, email: 'lead@aurora.example' },
  });
  const uniReviewer = await prisma.user.findFirstOrThrow({
    where: { organizationId: university.id, email: 'lead@redwood.example' },
  });

  const one = await buildCase({
    organizationId: org.id,
    policyId: jobPolicy.id,
    reviewerId: employerReviewer.id,
    applicantName: 'Maya Chen',
    reference: 'DEMO-1',
    title: 'Analyst application — an ordinary, legitimate record',
    documents: DEMO_1,
  });

  const two = await buildCase({
    organizationId: university.id,
    policyId: uniPolicy.id,
    reviewerId: uniReviewer.id,
    applicantName: 'Priya Raman',
    reference: 'DEMO-2',
    title: 'Undergraduate application — a genuine conflict',
    documents: DEMO_2,
  });

  const three = await buildCase({
    organizationId: university.id,
    policyId: uniPolicy.id,
    reviewerId: uniReviewer.id,
    applicantName: 'Amara Okonkwo',
    reference: 'DEMO-3',
    title: 'Undergraduate application — publication verification',
    documents: DEMO_3,
  });

  // DEMO-2: stage the conflict so the clarification thread is visible on camera,
  // but leave the reviewer decision unmade so it can be recorded live.
  await stageConflict(two, university.id, uniReviewer.id);

  // DEMO-3: record outcomes for the corroborated claims so the report has
  // something to show, leaving the publications for the walkthrough.
  await recordStraightforwardOutcomes(three, university.id, uniReviewer.id);

  await report(one, 'DEMO-1');
  await report(two, 'DEMO-2');
  await report(three, 'DEMO-3');

  console.log(
    [
      '',
      '  Sign in and film in this order:',
      '',
      '    DEMO-1  lead@aurora.example    → nothing flagged. Open a claim and show',
      '                                     "Organisation context": the firm is confirmed',
      '                                     real, the engagement is not verifiable.',
      '    DEMO-2  lead@redwood.example   → Observations tab. Two independent sources',
      '                                     disagree with the claim. Record the outcome live.',
      '    DEMO-3  lead@redwood.example   → Claims tab. One DOI resolves; the other is a',
      '                                     real DOI — set ENABLE_LIVE_SOURCES=true to have',
      '                                     it hit Crossref on camera.',
      '',
      '    Password for both: DemoReviewer!2026',
      '',
    ].join('\n'),
  );

  await prisma.$disconnect();
}

interface BuildInput {
  organizationId: string;
  policyId: string;
  reviewerId: string;
  applicantName: string;
  reference: string;
  title: string;
  documents: DemoDoc[];
}

async function buildCase(input: BuildInput): Promise<string> {
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
      dueDate: new Date(Date.now() + 14 * 86_400_000),
    },
  });

  await prisma.consentRecord.createMany({
    data: (['INTERNAL_REVIEW_ONLY', 'EXTERNAL_PUBLIC_SOURCES', 'ISSUING_ORGANIZATION_OUTREACH'] as const).map(
      (scope) => ({
        caseId: created.id,
        scope,
        grantedAt: new Date(),
        grantedVia: 'Signed verification authorisation form',
        recordedByUserId: input.reviewerId,
      }),
    ),
  });

  for (const doc of input.documents) {
    await ingestDocument({
      caseId: created.id,
      organizationId: input.organizationId,
      filename: doc.filename,
      declaredMimeType: 'text/plain',
      bytes: Buffer.from(doc.content, 'utf8'),
      kind: doc.kind,
      uploadedByUserId: input.reviewerId,
    });
  }

  await drainQueue({ caseId: created.id, maxTasks: 200 });
  await enqueueVerificationForCase({
    caseId: created.id,
    organizationId: input.organizationId,
    actorUserId: input.reviewerId,
  });
  await drainQueue({ caseId: created.id, maxTasks: 400 });
  await analyzeCase({
    caseId: created.id,
    organizationId: input.organizationId,
    actorUserId: input.reviewerId,
  });

  return created.id;
}

async function stageConflict(caseId: string, organizationId: string, userId: string): Promise<void> {
  const claim = await prisma.extractedClaim.findFirst({
    where: { caseId, category: 'AWARD_COMPETITION' },
    include: { evidenceItems: true },
  });
  if (!claim) return;

  const clarificationId = await draftClarification({ caseId, organizationId, claimId: claim.id, userId });
  await approveAndSendClarification({ clarificationId, organizationId, userId });

  // An approved-but-unsent outreach draft, so the approval queue has something
  // to show without the reviewer having done anything irreversible.
  await draftOutreach({
    caseId,
    organizationId,
    claimId: claim.id,
    recipientOrgName: 'International Robotics Challenge (organising committee)',
    recipientEmail: 'results@example-robotics-challenge.org',
    userId,
  });
}

async function recordStraightforwardOutcomes(caseId: string, organizationId: string, userId: string): Promise<void> {
  const claims = await prisma.extractedClaim.findMany({
    where: { caseId, category: { in: ['EDUCATION_ENROLLMENT', 'RESEARCH_POSITION'] } },
    include: { evidenceItems: true },
  });

  for (const claim of claims) {
    const supporting = claim.evidenceItems.filter((e) => e.relation === 'SUPPORTING' && e.scope === 'CLAIM');
    if (supporting.length === 0) continue;
    await recordReviewerDecision({
      claimId: claim.id,
      organizationId,
      userId,
      newStatus: 'VERIFIED',
      rationale:
        'The issuing organisation confirmed this directly through the approved verification channel. Dates and ' +
        'description match the application.',
      evidenceItemIds: supporting.map((e) => e.id),
    });
  }
}

async function report(caseId: string, reference: string): Promise<void> {
  const [claims, discrepancies, orgContext] = await Promise.all([
    prisma.extractedClaim.count({ where: { caseId } }),
    prisma.discrepancy.count({ where: { caseId } }),
    prisma.evidenceItem.count({ where: { caseId, scope: 'ORGANIZATION_CONTEXT' } }),
  ]);
  console.log(
    `  ${reference}: ${claims} claims, ${discrepancies} observation(s), ${orgContext} organisation-context finding(s)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
