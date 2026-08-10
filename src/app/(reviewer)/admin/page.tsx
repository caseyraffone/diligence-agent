import { notFound } from 'next/navigation';
import { requireActor } from '@/lib/auth/context';
import { prisma } from '@/lib/prisma';
import { describeProviderPosture } from '@/lib/env';
import { allAdapters } from '@/adapters/registry';
import { verifyAuditChain } from '@/lib/audit/audit';
import { ROLE_DEFINITIONS } from '@/lib/auth/permissions';
import { EmptyState, Pill, formatDateTime } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const actor = await requireActor();
  if (!actor.permissions.includes('admin:settings')) notFound();

  const posture = describeProviderPosture();
  const adapters = allAdapters();

  const [policies, users, retention, chain, orgs] = await Promise.all([
    prisma.policyTemplate.findMany({
      where: { OR: [{ organizationId: null }, { organizationId: actor.organizationId }] },
      orderBy: { name: 'asc' },
    }),
    prisma.user.findMany({
      where: { organizationId: actor.organizationId },
      include: { role: true },
      orderBy: { name: 'asc' },
    }),
    prisma.retentionRule.findMany({ where: { organizationId: actor.organizationId }, orderBy: { name: 'asc' } }),
    verifyAuditChain(actor.organizationId),
    prisma.organization.count(),
  ]);

  return (
    <>
      <div className="page-head">
        <h1>Administration</h1>
        <p>Provider posture, verification policies, source integrations, access, and retention.</p>
      </div>

      {/* ------------------------------------------------ AI provider */}
      <section className="card">
        <h2>AI provider</h2>
        {posture.isPaid ? (
          <div className="notice notice-warn" role="alert">
            <strong>A paid provider is active</strong>
            Every extraction, drafting, and question-generation call is billed to your account, and applicant document
            text is transmitted to <strong>{posture.provider}</strong>. Confirm you have a data-processing agreement
            covering this and that your applicant privacy notice discloses it. Set{' '}
            <span className="mono">LLM_PROVIDER=mock</span> to return to the free, offline provider.
          </div>
        ) : (
          <div className="notice">
            <strong>No API cost</strong>
            {posture.provider === 'mock'
              ? 'The deterministic mock provider is active. It runs offline, costs nothing, and produces identical output for identical input. No applicant data leaves this machine.'
              : 'A local Ollama model is active. No applicant data leaves your infrastructure and no API charges are incurred.'}
          </div>
        )}

        <div className="table-wrap">
          <table>
            <tbody>
              <tr>
                <th scope="row">Provider</th>
                <td>
                  <span className="mono">{posture.provider}</span>{' '}
                  {posture.isPaid ? <Pill tone="warn">billed per request</Pill> : <Pill tone="ok">no API cost</Pill>}
                </td>
              </tr>
              <tr>
                <th scope="row">Model</th>
                <td className="mono">{posture.model}</td>
              </tr>
              <tr>
                <th scope="row">Credential configured</th>
                <td>
                  {posture.credentialConfigured ? 'Yes' : 'No'}
                  {/* The key itself is never rendered, logged, or returned by any API. */}
                  <span className="muted small"> — key material is never displayed or logged</span>
                </td>
              </tr>
              <tr>
                <th scope="row">Limits</th>
                <td className="small">
                  {posture.timeoutMs} ms timeout · {posture.maxRetries} retries · {posture.maxOutputTokens} max output
                  tokens
                </td>
              </tr>
              <tr>
                <th scope="row">What the model may do</th>
                <td className="small">
                  Extract, normalise, classify, summarise, generate interview questions, draft clarification text.
                  <strong> It cannot set a verification status, reach a conclusion, or produce a decision</strong> — the
                  output schemas contain no field for any of those.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ------------------------------------------------ source adapters */}
      <section className="card">
        <h2>Source integrations</h2>
        <p className="small muted">
          Live external calls are {posture.liveSourcesEnabled ? 'ENABLED' : 'disabled'} (
          <span className="mono">ENABLE_LIVE_SOURCES</span>). When disabled, every adapter serves recorded fixtures and
          no network request is made. Adapters marked “fixture only” need work beyond code before they can be real —
          read the integration note before promising a go-live date.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Authority</th>
                <th scope="col">Covers</th>
                <th scope="col">Status</th>
                <th scope="col">What production access requires</th>
              </tr>
            </thead>
            <tbody>
              {adapters.map((a) => (
                <tr key={a.key}>
                  <td className="small">
                    <strong>{a.name}</strong>
                    <div className="mono muted">{a.key}</div>
                  </td>
                  <td className="small">{a.authorityLevel.replace(/_/g, ' ').toLowerCase()}</td>
                  <td className="small muted">
                    {a.supportedCategories.map((c) => c.replace(/_/g, ' ').toLowerCase()).join(', ')}
                  </td>
                  <td>
                    {a.integrationStatus === 'LIVE_CAPABLE' ? (
                      <Pill tone="ok">live capable</Pill>
                    ) : (
                      <Pill tone="neutral">fixture only</Pill>
                    )}
                  </td>
                  <td className="small">{a.integrationNote}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ------------------------------------------------ policies */}
      <section className="card">
        <h2>Verification policies</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Policy</th>
                <th scope="col">Use case</th>
                <th scope="col">Approved sources</th>
                <th scope="col">Retention</th>
                <th scope="col">Scope</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td className="small">
                    <strong>{p.name}</strong>
                    <div className="muted">{p.description}</div>
                  </td>
                  <td className="small">{p.useCase.replace(/_/g, ' ').toLowerCase()}</td>
                  <td className="small mono">{p.approvedSourceKeys.join(', ')}</td>
                  <td className="small">{p.retentionDays} days</td>
                  <td className="small">{p.organizationId ? 'This tenant' : 'Built-in'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ------------------------------------------------ access */}
      <section className="card">
        <h2>Access</h2>
        <p className="small muted">
          {orgs} tenant organisation(s) exist in this deployment. You can only see your own — tenant scope is taken from
          the session and folded into every query.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Role</th>
                <th scope="col">Permissions</th>
                <th scope="col">Last sign-in</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="small">
                    {u.name}
                    <div className="mono muted">{u.email}</div>
                  </td>
                  <td className="small">{u.role.name}</td>
                  <td className="small muted">
                    {ROLE_DEFINITIONS[u.role.key as keyof typeof ROLE_DEFINITIONS]?.permissions.length ?? 0} permissions
                  </td>
                  <td className="small">{formatDateTime(u.lastLoginAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          No role in this system — including administrator — can produce an admissions, hiring, or eligibility decision.
          That capability does not exist, so it cannot be granted.
        </p>
      </section>

      {/* ------------------------------------------------ retention */}
      <section className="card">
        <h2>Retention</h2>
        <p className="small muted">
          Retention rules run against closed cases. Deleting originals leaves the extracted claims, the evidence trail,
          and the audit log intact, so a decision record survives after the source documents are gone.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Action</th>
                <th scope="col">Applies</th>
                <th scope="col">Last run</th>
              </tr>
            </thead>
            <tbody>
              {retention.map((r) => (
                <tr key={r.id}>
                  <td className="small">{r.name}</td>
                  <td className="small mono">{r.action.replace(/_/g, ' ').toLowerCase()}</td>
                  <td className="small">{r.afterDaysFromClosure} days after closure</td>
                  <td className="small">{formatDateTime(r.lastRunAt)}</td>
                </tr>
              ))}
              {retention.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <EmptyState>No retention rules configured.</EmptyState>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          The scheduled enforcement job is not implemented in this MVP — rules are stored and displayed but are not yet
          executed automatically. See LIMITATIONS.md.
        </p>
      </section>

      {/* ------------------------------------------------ audit integrity */}
      <section className="card">
        <h2>Audit integrity</h2>
        {chain.valid ? (
          <p>
            <Pill tone="ok">Chain intact</Pill> {chain.checked} events verified.
          </p>
        ) : (
          <div className="notice notice-conflict" role="alert">
            <strong>Verification failed at sequence {chain.brokenAtSequence}</strong>
            {chain.reason}
          </div>
        )}
      </section>
    </>
  );
}
