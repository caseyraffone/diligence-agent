import { CaseStatus, ClaimStatus, DiscrepancyStatus, Prisma } from '@prisma/client';
import { requireActor, requireServerAction } from '@/lib/auth/context';
import { prisma } from '@/lib/prisma';
import { scoreCasePriority } from '@/domain/prioritize';
import { DecisionSupportNotice, EmptyState, Pill, Stat, formatDate } from '@/components/ui';
import { recordAudit } from '@/lib/audit/audit';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

async function createCase(formData: FormData): Promise<void> {
  'use server';
  const actor = await requireServerAction('case:create');

  const applicantName = String(formData.get('applicantName') ?? '').trim();
  const reference = String(formData.get('reference') ?? '').trim();
  const title = String(formData.get('title') ?? '').trim();
  const policyTemplateId = String(formData.get('policyTemplateId') ?? '');
  const dueDate = String(formData.get('dueDate') ?? '');

  if (!applicantName || !reference || !title || !policyTemplateId) redirect('/?error=missing');

  const applicant = await prisma.applicant.create({
    data: { organizationId: actor.organizationId, displayName: applicantName },
  });

  const created = await prisma.case.create({
    data: {
      organizationId: actor.organizationId,
      applicantId: applicant.id,
      policyTemplateId,
      reference,
      title,
      assignedReviewerId: actor.userId,
      dueDate: dueDate ? new Date(dueDate) : null,
      status: CaseStatus.AWAITING_CONSENT,
    },
  });

  await recordAudit({
    organizationId: actor.organizationId,
    caseId: created.id,
    actorType: 'USER',
    actorUserId: actor.userId,
    action: 'CASE_CREATED',
    entityType: 'Case',
    entityId: created.id,
    metadata: { reference, policyTemplateId },
  });

  redirect(`/cases/${created.id}`);
}

interface Filters {
  status?: string;
  reviewer?: string;
  q?: string;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Filters> }) {
  const actor = await requireActor();
  const filters = await searchParams;

  const where: Prisma.CaseWhereInput = {
    // Tenant scope comes from the session, never from the query string.
    organizationId: actor.organizationId,
    ...(filters.status ? { status: filters.status as CaseStatus } : {}),
    ...(filters.reviewer === 'me' ? { assignedReviewerId: actor.userId } : {}),
    ...(filters.q
      ? {
          OR: [
            { reference: { contains: filters.q, mode: 'insensitive' } },
            { title: { contains: filters.q, mode: 'insensitive' } },
            { applicant: { displayName: { contains: filters.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [cases, policies, reviewers] = await Promise.all([
    prisma.case.findMany({
      where,
      include: {
        applicant: { select: { displayName: true } },
        policyTemplate: { select: { name: true } },
        assignedReviewer: { select: { name: true } },
        _count: { select: { claims: true, documents: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    }),
    prisma.policyTemplate.findMany({
      where: { OR: [{ organizationId: null }, { organizationId: actor.organizationId }], isActive: true },
      orderBy: { name: 'asc' },
    }),
    prisma.user.count({ where: { organizationId: actor.organizationId, isActive: true } }),
  ]);

  // Priority is computed per case from evidence gaps only. It is displayed with
  // its contributing factors so the ordering is always explainable.
  const enriched = await Promise.all(
    cases.map(async (c) => {
      const [awaiting, unable, open, overdue, failed, severities] = await Promise.all([
        prisma.extractedClaim.count({ where: { caseId: c.id, status: ClaimStatus.PENDING_VERIFICATION } }),
        prisma.extractedClaim.count({ where: { caseId: c.id, status: ClaimStatus.UNABLE_TO_VERIFY } }),
        prisma.discrepancy.count({
          where: { caseId: c.id, status: { in: [DiscrepancyStatus.OPEN, DiscrepancyStatus.UNDER_REVIEW] } },
        }),
        prisma.clarificationRequest.count({ where: { caseId: c.id, status: 'SENT', dueDate: { lt: new Date() } } }),
        prisma.sourceCheck.count({ where: { caseId: c.id, result: { in: ['SOURCE_UNAVAILABLE', 'ERROR'] } } }),
        prisma.discrepancy.findMany({
          where: { caseId: c.id, status: { in: [DiscrepancyStatus.OPEN, DiscrepancyStatus.UNDER_REVIEW] } },
          select: { severity: true },
        }),
      ]);

      const priority = scoreCasePriority({
        claimsAwaitingVerification: awaiting,
        claimsUnableToVerify: unable,
        openDiscrepancies: open,
        highestOpenSeverity:
          severities.find((s) => s.severity === 'REVIEW_REQUIRED')?.severity ??
          severities.find((s) => s.severity === 'REVIEW_SUGGESTED')?.severity ??
          severities.at(0)?.severity ??
          null,
        overdueClarifications: overdue,
        daysUntilDue: c.dueDate ? Math.round((c.dueDate.getTime() - Date.now()) / 86_400_000) : null,
        failedSourceChecks: failed,
      });

      return { ...c, priority, openDiscrepancies: open };
    }),
  );

  enriched.sort((a, b) => b.priority.score - a.priority.score);

  const totals = {
    cases: enriched.length,
    claims: enriched.reduce((s, c) => s + c._count.claims, 0),
    open: enriched.reduce((s, c) => s + c.openDiscrepancies, 0),
  };

  return (
    <>
      <div className="page-head">
        <h1>Case queue</h1>
        <p>
          Cases for {actor.roleKey === 'READ_ONLY_AUDITOR' ? 'review (read-only)' : 'your organisation'}, ordered by
          how much unresolved uncertainty a reviewer could clear. Ordering uses evidence gaps and unresolved
          differences only — never anything about the applicant.
        </p>
      </div>

      <DecisionSupportNotice />

      <div className="grid" style={{ marginBottom: '1rem' }}>
        <Stat value={totals.cases} label="Cases visible" />
        <Stat value={totals.claims} label="Claims extracted" />
        <Stat value={totals.open} label="Unresolved observations" />
        <Stat value={reviewers} label="Reviewers in tenant" />
      </div>

      <form className="card" method="get" role="search">
        <div className="row">
          <div>
            <label htmlFor="q">Search</label>
            <input id="q" name="q" type="search" defaultValue={filters.q ?? ''} placeholder="Reference, title, or applicant" />
          </div>
          <div>
            <label htmlFor="status">Case status</label>
            <select id="status" name="status" defaultValue={filters.status ?? ''}>
              <option value="">Any status</option>
              {Object.values(CaseStatus).map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="reviewer">Assignment</label>
            <select id="reviewer" name="reviewer" defaultValue={filters.reviewer ?? ''}>
              <option value="">Anyone</option>
              <option value="me">Assigned to me</option>
            </select>
          </div>
          <div style={{ flex: '0 0 auto' }}>
            <button type="submit">Apply filters</button>
          </div>
        </div>
      </form>

      <div className="table-wrap">
        <table>
          <caption>
            {enriched.length} case{enriched.length === 1 ? '' : 's'}. Priority is explainable — hover a score to see
            what produced it.
          </caption>
          <thead>
            <tr>
              <th scope="col">Reference</th>
              <th scope="col">Applicant</th>
              <th scope="col">Policy</th>
              <th scope="col">Status</th>
              <th scope="col">Claims</th>
              <th scope="col">Open observations</th>
              <th scope="col">Reviewer</th>
              <th scope="col">Due</th>
              <th scope="col">Priority</th>
            </tr>
          </thead>
          <tbody>
            {enriched.map((c) => (
              <tr key={c.id}>
                <td>
                  <a href={`/cases/${c.id}`}>{c.reference}</a>
                  <div className="small muted">{c.title}</div>
                </td>
                <td>{c.applicant.displayName}</td>
                <td className="small">{c.policyTemplate.name}</td>
                <td>
                  <Pill tone={c.status === 'READY_FOR_REVIEW' ? 'ok' : 'neutral'}>
                    {c.status.replace(/_/g, ' ').toLowerCase()}
                  </Pill>
                </td>
                <td>{c._count.claims}</td>
                <td>{c.openDiscrepancies > 0 ? <Pill tone="warn">{c.openDiscrepancies}</Pill> : '0'}</td>
                <td className="small">{c.assignedReviewer?.name ?? 'Unassigned'}</td>
                <td className="small">{formatDate(c.dueDate)}</td>
                <td>
                  <abbr
                    title={c.priority.contributions.map((x) => `${x.points}: ${x.explanation}`).join('\n') || 'No outstanding factors'}
                    style={{ textDecoration: 'none', borderBottom: '1px dotted currentColor', cursor: 'help' }}
                  >
                    {c.priority.score}
                  </abbr>
                </td>
              </tr>
            ))}
            {enriched.length === 0 ? (
              <tr>
                <td colSpan={9}>
                  <EmptyState>No cases match these filters.</EmptyState>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {actor.permissions.includes('case:create') ? (
        <details className="card" style={{ marginTop: '1rem' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Create a new case</summary>
          <form action={createCase} style={{ marginTop: '0.85rem' }}>
            <div className="row">
              <div>
                <label htmlFor="reference">Case reference</label>
                <input id="reference" name="reference" type="text" required placeholder="RU-2026-0001" />
              </div>
              <div>
                <label htmlFor="applicantName">Applicant name</label>
                <input id="applicantName" name="applicantName" type="text" required />
              </div>
            </div>
            <div className="field">
              <label htmlFor="title">Case title</label>
              <input id="title" name="title" type="text" required placeholder="Undergraduate application — Physics" />
            </div>
            <div className="row">
              <div>
                <label htmlFor="policyTemplateId">Verification policy</label>
                <select id="policyTemplateId" name="policyTemplateId" required>
                  {policies.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="dueDate">Review due date</label>
                <input id="dueDate" name="dueDate" type="date" />
              </div>
            </div>
            <p className="hint">
              A new case starts in “awaiting consent”. No external source is contacted until documented applicant
              consent is recorded on the case.
            </p>
            <button type="submit">Create case</button>
          </form>
        </details>
      ) : null}
    </>
  );
}
