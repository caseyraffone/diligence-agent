import { ClaimStatus, DiscrepancyStatus, StatementType, type ClaimCategory } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recordAudit, verifyAuditChain } from '@/lib/audit/audit';
import { assertTransition } from '@/domain/claimStatus';
import { scoreCasePriority, suggestNextAction, type NextActionSuggestion } from '@/domain/prioritize';
import { AUTHORITY_LABELS } from '@/domain/authority';
import { formatRange, toRange, type Precision } from '@/lib/dates';
import { ValidationError } from '@/lib/errors';

/**
 * MODULE 4 — CASE REVIEWER
 *
 * Assembles everything a trained reviewer needs into one workspace, and
 * produces the neutral report.
 *
 * The report's job is to keep categories of information apart. A confirmed fact
 * from a registrar, an applicant's own statement, a referee's opinion, an
 * observation the software made, and an unresolved difference between documents
 * are five different things, and a report that blurs them invites a reviewer to
 * treat a machine observation as a finding. Every evidence row carries a
 * StatementType and the report groups by it.
 */

// ---------------------------------------------------------------- workspace

export interface ClaimSummary {
  id: string;
  category: ClaimCategory;
  normalizedText: string;
  sourcePassage: string;
  documentId: string;
  documentName: string;
  pageNumber: number;
  organizationName: string | null;
  title: string | null;
  dateLabel: string;
  status: ClaimStatus;
  extractionConfidence: number;
  supportingCount: number;
  conflictingCount: number;
  neutralCount: number;
  strongestSupportingAuthority: string | null;
  nextAction: NextActionSuggestion;
  hasHumanDecision: boolean;
}

export interface CaseWorkspace {
  caseId: string;
  reference: string;
  title: string;
  status: string;
  applicantName: string;
  policyName: string;
  assignedReviewer: string | null;
  dueDate: Date | null;
  progress: {
    totalClaims: number;
    byStatus: Record<ClaimStatus, number>;
    percentReviewed: number;
  };
  priority: ReturnType<typeof scoreCasePriority>;
  claims: ClaimSummary[];
  openDiscrepancies: number;
  unresolvedQuestions: string[];
  consentScopes: string[];
}

export async function buildCaseWorkspace(caseId: string, organizationId: string): Promise<CaseWorkspace> {
  const record = await prisma.case.findFirstOrThrow({
    where: { id: caseId, organizationId },
    include: {
      applicant: true,
      policyTemplate: true,
      assignedReviewer: { select: { name: true } },
      consents: { where: { revokedAt: null } },
    },
  });

  const claims = await prisma.extractedClaim.findMany({
    where: { caseId, organizationId },
    include: {
      document: { select: { id: true, filename: true } },
      evidenceItems: true,
      sourceChecks: { select: { id: true } },
      decisions: { select: { id: true } },
      clarifications: { where: { status: { in: ['SENT', 'APPROVED'] } }, select: { id: true } },
    },
    orderBy: [{ category: 'asc' }, { createdAt: 'asc' }],
  });

  const [openDiscrepancies, overdueClarifications, failedChecks, severities] = await Promise.all([
    prisma.discrepancy.count({
      where: { caseId, status: { in: [DiscrepancyStatus.OPEN, DiscrepancyStatus.UNDER_REVIEW] } },
    }),
    prisma.clarificationRequest.count({
      where: { caseId, status: 'SENT', dueDate: { lt: new Date() } },
    }),
    prisma.sourceCheck.count({ where: { caseId, result: { in: ['SOURCE_UNAVAILABLE', 'ERROR'] } } }),
    prisma.discrepancy.findMany({
      where: { caseId, status: { in: [DiscrepancyStatus.OPEN, DiscrepancyStatus.UNDER_REVIEW] } },
      select: { severity: true },
    }),
  ]);

  const byStatus = emptyStatusCounts();
  for (const claim of claims) byStatus[claim.status]++;

  const summaries: ClaimSummary[] = claims.map((claim) => {
    const supporting = claim.evidenceItems.filter((e) => e.relation === 'SUPPORTING');
    const conflicting = claim.evidenceItems.filter((e) => e.relation === 'CONFLICTING');
    const neutral = claim.evidenceItems.filter((e) => e.relation === 'NEUTRAL');

    const strongest = supporting
      .map((e) => e.authorityLevel)
      .sort((a, b) => a.localeCompare(b))
      .at(0);

    return {
      id: claim.id,
      category: claim.category,
      normalizedText: claim.normalizedText,
      sourcePassage: claim.sourcePassage,
      documentId: claim.document.id,
      documentName: claim.document.filename,
      pageNumber: claim.pageNumber,
      organizationName: claim.organizationName,
      title: claim.title,
      dateLabel: formatRange(toRange(claim.startDate, claim.endDate, claim.datePrecision as Precision)),
      status: claim.status,
      extractionConfidence: claim.extractionConfidence,
      supportingCount: supporting.length,
      conflictingCount: conflicting.length,
      neutralCount: neutral.length,
      strongestSupportingAuthority: strongest ? AUTHORITY_LABELS[strongest] : null,
      hasHumanDecision: claim.decisions.length > 0,
      nextAction: suggestNextAction({
        status: claim.status,
        hasRunAnySourceCheck: claim.sourceChecks.length > 0,
        hasSupportingEvidence: supporting.length > 0,
        hasConflictingEvidence: conflicting.length > 0,
        hasOpenClarification: claim.clarifications.length > 0,
        isContributionClaim:
          claim.category === 'RESEARCH_POSITION' ||
          claim.category === 'PROJECT_VENTURE_PATENT' ||
          claim.category === 'PUBLICATION',
      }),
    };
  });

  const reviewed = claims.filter(
    (c) => c.status !== ClaimStatus.PENDING_VERIFICATION && c.status !== ClaimStatus.HUMAN_REVIEW_REQUIRED,
  ).length;

  const priority = scoreCasePriority({
    claimsAwaitingVerification: byStatus[ClaimStatus.PENDING_VERIFICATION],
    claimsUnableToVerify: byStatus[ClaimStatus.UNABLE_TO_VERIFY],
    openDiscrepancies,
    highestOpenSeverity:
      severities.find((s) => s.severity === 'REVIEW_REQUIRED')?.severity ??
      severities.find((s) => s.severity === 'REVIEW_SUGGESTED')?.severity ??
      severities.at(0)?.severity ??
      null,
    overdueClarifications,
    daysUntilDue: record.dueDate ? Math.round((record.dueDate.getTime() - Date.now()) / 86_400_000) : null,
    failedSourceChecks: failedChecks,
  });

  return {
    caseId: record.id,
    reference: record.reference,
    title: record.title,
    status: record.status,
    applicantName: record.applicant.displayName,
    policyName: record.policyTemplate.name,
    assignedReviewer: record.assignedReviewer?.name ?? null,
    dueDate: record.dueDate,
    progress: {
      totalClaims: claims.length,
      byStatus,
      percentReviewed: claims.length === 0 ? 0 : Math.round((reviewed / claims.length) * 100),
    },
    priority,
    claims: summaries,
    openDiscrepancies,
    unresolvedQuestions: summaries
      .filter((s) => s.nextAction.action !== 'NO_ACTION_NEEDED')
      .slice(0, 12)
      .map((s) => `${s.normalizedText} — ${s.nextAction.reason}`),
    consentScopes: record.consents.map((c) => c.scope),
  };
}

// ---------------------------------------------------------------- timeline

export interface TimelineEntry {
  claimId: string;
  category: ClaimCategory;
  label: string;
  organizationName: string | null;
  start: Date | null;
  end: Date | null;
  dateLabel: string;
  status: ClaimStatus;
  isOngoing: boolean;
}

export async function buildTimeline(caseId: string, organizationId: string): Promise<TimelineEntry[]> {
  const claims = await prisma.extractedClaim.findMany({
    where: {
      caseId,
      organizationId,
      startDate: { not: null },
      category: {
        in: [
          'EDUCATION_ENROLLMENT',
          'DEGREE_AWARD',
          'EMPLOYMENT',
          'RESEARCH_POSITION',
          'VOLUNTEER_LEADERSHIP',
          'ATHLETIC_PARTICIPATION',
        ],
      },
    },
    orderBy: { startDate: 'asc' },
  });

  return claims.map((c) => ({
    claimId: c.id,
    category: c.category,
    label: c.title ?? c.normalizedText,
    organizationName: c.organizationName,
    start: c.startDate,
    end: c.endDate,
    dateLabel: formatRange(toRange(c.startDate, c.endDate, c.datePrecision as Precision)),
    status: c.status,
    isOngoing: Boolean(c.startDate) && !c.endDate,
  }));
}

// ---------------------------------------------------------------- graph

export interface GraphNode {
  id: string;
  type: 'CLAIM' | 'DOCUMENT' | 'ORGANIZATION' | 'SOURCE';
  label: string;
  status?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string;
}

export interface RelationshipGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Connects claims to the documents they came from, the organisations they name, and the sources consulted. */
export async function buildRelationshipGraph(caseId: string, organizationId: string): Promise<RelationshipGraph> {
  const [claims, documents, checks] = await Promise.all([
    prisma.extractedClaim.findMany({ where: { caseId, organizationId } }),
    prisma.applicationDocument.findMany({ where: { caseId, organizationId } }),
    prisma.sourceCheck.findMany({ where: { caseId, organizationId } }),
  ]);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const orgNodes = new Set<string>();

  for (const doc of documents) {
    nodes.push({ id: `doc:${doc.id}`, type: 'DOCUMENT', label: doc.filename });
  }

  for (const claim of claims) {
    nodes.push({
      id: `claim:${claim.id}`,
      type: 'CLAIM',
      label: claim.normalizedText.slice(0, 80),
      status: claim.status,
    });
    edges.push({ from: `claim:${claim.id}`, to: `doc:${claim.documentId}`, label: `page ${claim.pageNumber}` });

    if (claim.organizationName) {
      const orgId = `org:${claim.organizationName.toLowerCase()}`;
      if (!orgNodes.has(orgId)) {
        orgNodes.add(orgId);
        nodes.push({ id: orgId, type: 'ORGANIZATION', label: claim.organizationName });
      }
      edges.push({ from: `claim:${claim.id}`, to: orgId, label: 'names' });
    }
  }

  const sourceNodes = new Set<string>();
  for (const check of checks) {
    const sourceId = `source:${check.adapterKey}`;
    if (!sourceNodes.has(sourceId)) {
      sourceNodes.add(sourceId);
      nodes.push({ id: sourceId, type: 'SOURCE', label: check.adapterKey });
    }
    edges.push({ from: `claim:${check.claimId}`, to: sourceId, label: check.result });
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------- decisions

export interface RecordDecisionInput {
  claimId: string;
  organizationId: string;
  userId: string;
  newStatus: ClaimStatus;
  rationale: string;
  evidenceItemIds?: string[];
  reversesDecisionId?: string;
}

/**
 * The only path by which a claim reaches a human-authored conclusion.
 *
 * Requires a rationale, records the prior status, and is always reversible.
 */
export async function recordReviewerDecision(input: RecordDecisionInput): Promise<string> {
  const claim = await prisma.extractedClaim.findFirstOrThrow({
    where: { id: input.claimId, organizationId: input.organizationId },
  });

  // Throws InvalidTransitionError with a reviewer-readable reason.
  assertTransition({
    from: claim.status,
    to: input.newStatus,
    actor: 'HUMAN',
    rationale: input.rationale,
  });

  if (input.evidenceItemIds?.length) {
    const count = await prisma.evidenceItem.count({
      where: { id: { in: input.evidenceItemIds }, claimId: input.claimId, organizationId: input.organizationId },
    });
    if (count !== input.evidenceItemIds.length) {
      throw new ValidationError('One or more cited evidence items do not belong to this claim.');
    }
  }

  return prisma.$transaction(async (tx) => {
    const decision = await tx.reviewerDecision.create({
      data: {
        organizationId: input.organizationId,
        caseId: claim.caseId,
        claimId: claim.id,
        previousStatus: claim.status,
        newStatus: input.newStatus,
        rationale: input.rationale,
        evidenceItemIds: input.evidenceItemIds ?? [],
        decidedByUserId: input.userId,
        reversesDecisionId: input.reversesDecisionId ?? null,
        isReversal: Boolean(input.reversesDecisionId),
      },
    });

    await tx.extractedClaim.update({ where: { id: claim.id }, data: { status: input.newStatus } });

    await recordAudit(
      {
        organizationId: input.organizationId,
        caseId: claim.caseId,
        actorType: 'USER',
        actorUserId: input.userId,
        action: 'CLAIM_STATUS_CHANGED',
        entityType: 'ExtractedClaim',
        entityId: claim.id,
        metadata: {
          from: claim.status,
          to: input.newStatus,
          decisionId: decision.id,
          isReversal: Boolean(input.reversesDecisionId),
          citedEvidence: input.evidenceItemIds ?? [],
        },
      },
      tx,
    );

    return decision.id;
  });
}

// ---------------------------------------------------------------- report

export interface CaseReport {
  generatedAt: string;
  notice: string;
  case: {
    reference: string;
    title: string;
    status: string;
    applicantName: string;
    policy: string;
    assignedReviewer: string | null;
  };
  summary: {
    totalClaims: number;
    byStatus: Record<string, number>;
    openDiscrepancies: number;
    percentReviewed: number;
  };
  /** The five categories are kept strictly separate; see module docblock. */
  confirmedFacts: ReportEvidenceLine[];
  applicantStatements: ReportEvidenceLine[];
  thirdPartyStatements: ReportEvidenceLine[];
  systemObservations: ReportEvidenceLine[];
  inferences: ReportEvidenceLine[];
  unresolvedDiscrepancies: Array<{
    title: string;
    description: string;
    severity: string;
    status: string;
  }>;
  claims: Array<{
    claim: string;
    category: string;
    status: string;
    statusMeaning: string;
    citation: string;
    dates: string;
    humanDecision: { by: string; at: string; rationale: string } | null;
  }>;
  timeline: Array<{ label: string; organization: string | null; dates: string; status: string }>;
  clarifications: Array<{ subject: string; status: string; sentAt: string | null; responses: number }>;
  /**
   * Structured conversations about claimed personal contributions. Reported as
   * counts and the reviewer's written conclusion — never as an aggregate score,
   * because a number invites reading a conversation as a result.
   */
  interviews: Array<{
    topic: string;
    claim: string | null;
    conductedBy: string | null;
    conductedAt: string | null;
    humanReviewed: boolean;
    conclusion: string | null;
    corroborates: number;
    partiallyCorroborates: number;
    doesNotAddress: number;
    notAsked: number;
  }>;
  auditIntegrity: { valid: boolean; eventsChecked: number; reason: string | null };
}

export interface ReportEvidenceLine {
  claim: string;
  summary: string;
  detail: string | null;
  authority: string;
  relation: string;
  source: string | null;
  retrievedAt: string | null;
}

export const REPORT_NOTICE =
  'This report is investigative decision-support for a trained human reviewer. It does not determine whether any ' +
  'statement is true, does not allege dishonesty or fraud, and does not make or recommend an admissions, hiring, ' +
  'eligibility, or funding decision. A status of "Unable to verify" means no record was located through the ' +
  'channels available — it is not evidence that a claim is inaccurate, and many legitimate achievements leave no ' +
  'searchable record. Observations about document files are properties of those files and cannot establish that a ' +
  'document was altered. Every conclusion in this report was recorded by a named human reviewer and can be revised ' +
  'if new information arrives.';

export async function buildCaseReport(caseId: string, organizationId: string): Promise<CaseReport> {
  const [workspace, timeline, record, evidence, discrepancies, decisions, clarifications, interviews, chain] =
    await Promise.all([
      buildCaseWorkspace(caseId, organizationId),
      buildTimeline(caseId, organizationId),
      prisma.case.findFirstOrThrow({
        where: { id: caseId, organizationId },
        include: { applicant: true, policyTemplate: true, assignedReviewer: { select: { name: true } } },
      }),
      prisma.evidenceItem.findMany({
        where: { caseId, organizationId },
        include: { claim: { select: { normalizedText: true } }, sourceCheck: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.discrepancy.findMany({
        where: { caseId, organizationId, status: { in: [DiscrepancyStatus.OPEN, DiscrepancyStatus.UNDER_REVIEW] } },
      }),
      prisma.reviewerDecision.findMany({
        where: { caseId, organizationId },
        include: { decidedBy: { select: { name: true } } },
        orderBy: { decidedAt: 'desc' },
      }),
      prisma.clarificationRequest.findMany({
        where: { caseId, organizationId },
        include: { _count: { select: { responses: true } } },
      }),
      prisma.interview.findMany({
        where: { caseId, organizationId },
        include: {
          claim: { select: { normalizedText: true } },
          conductedBy: { select: { name: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      verifyAuditChain(organizationId),
    ]);

  const line = (e: (typeof evidence)[number]): ReportEvidenceLine => ({
    claim: e.claim.normalizedText,
    summary: e.summary,
    detail: e.detail,
    authority: AUTHORITY_LABELS[e.authorityLevel],
    relation: e.relation,
    source: e.sourceCheck?.url ?? e.sourceCheck?.adapterKey ?? null,
    retrievedAt: e.sourceCheck?.retrievedAt.toISOString() ?? null,
  });

  const byType = (t: StatementType) => evidence.filter((e) => e.statementType === t).map(line);

  const latestDecisionByClaim = new Map<string, (typeof decisions)[number]>();
  for (const d of decisions) {
    if (d.claimId && !latestDecisionByClaim.has(d.claimId)) latestDecisionByClaim.set(d.claimId, d);
  }

  const { STATUS_MEANINGS } = await import('@/domain/claimStatus');

  return {
    generatedAt: new Date().toISOString(),
    notice: REPORT_NOTICE,
    case: {
      reference: record.reference,
      title: record.title,
      status: record.status,
      applicantName: record.applicant.displayName,
      policy: record.policyTemplate.name,
      assignedReviewer: record.assignedReviewer?.name ?? null,
    },
    summary: {
      totalClaims: workspace.progress.totalClaims,
      byStatus: workspace.progress.byStatus,
      openDiscrepancies: workspace.openDiscrepancies,
      percentReviewed: workspace.progress.percentReviewed,
    },
    confirmedFacts: byType(StatementType.CONFIRMED_FACT),
    applicantStatements: byType(StatementType.APPLICANT_STATEMENT),
    thirdPartyStatements: byType(StatementType.THIRD_PARTY_STATEMENT),
    systemObservations: byType(StatementType.SYSTEM_OBSERVATION),
    inferences: byType(StatementType.INFERENCE),
    unresolvedDiscrepancies: discrepancies.map((d) => ({
      title: d.title,
      description: d.description,
      severity: d.severity,
      status: d.status,
    })),
    claims: workspace.claims.map((c) => {
      const decision = latestDecisionByClaim.get(c.id);
      return {
        claim: c.normalizedText,
        category: c.category,
        status: c.status,
        statusMeaning: STATUS_MEANINGS[c.status],
        citation: `${c.documentName}, page ${c.pageNumber}`,
        dates: c.dateLabel,
        humanDecision: decision
          ? {
              by: decision.decidedBy.name,
              at: decision.decidedAt.toISOString(),
              rationale: decision.rationale,
            }
          : null,
      };
    }),
    timeline: timeline.map((t) => ({
      label: t.label,
      organization: t.organizationName,
      dates: t.dateLabel,
      status: t.status,
    })),
    clarifications: clarifications.map((c) => ({
      subject: c.subject,
      status: c.status,
      sentAt: c.sentRecordedAt?.toISOString() ?? null,
      responses: c._count.responses,
    })),
    interviews: interviews.map((i) => {
      const scores = Array.isArray(i.scorecard) ? (i.scorecard as unknown as Array<{ rating?: string }>) : [];
      const count = (rating: string): number => scores.filter((s) => s.rating === rating).length;
      return {
        topic: i.topic,
        claim: i.claim?.normalizedText ?? null,
        conductedBy: i.conductedBy?.name ?? null,
        conductedAt: i.conductedAt?.toISOString() ?? null,
        humanReviewed: i.humanReviewed,
        conclusion: i.conclusion,
        corroborates: count('CORROBORATES'),
        partiallyCorroborates: count('PARTIALLY_CORROBORATES'),
        doesNotAddress: count('DOES_NOT_ADDRESS'),
        notAsked: count('NOT_ASKED'),
      };
    }),
    auditIntegrity: { valid: chain.valid, eventsChecked: chain.checked, reason: chain.reason },
  };
}

function emptyStatusCounts(): Record<ClaimStatus, number> {
  return {
    [ClaimStatus.PENDING_VERIFICATION]: 0,
    [ClaimStatus.VERIFIED]: 0,
    [ClaimStatus.CORROBORATED]: 0,
    [ClaimStatus.PARTIALLY_CORROBORATED]: 0,
    [ClaimStatus.UNABLE_TO_VERIFY]: 0,
    [ClaimStatus.CONFLICTING_INFORMATION]: 0,
    [ClaimStatus.APPLICANT_CLARIFICATION_REQUESTED]: 0,
    [ClaimStatus.HUMAN_REVIEW_REQUIRED]: 0,
  };
}
