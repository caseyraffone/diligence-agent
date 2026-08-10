import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getActor } from '@/lib/auth/context';
import { revokeSession, SESSION_COOKIE } from '@/lib/auth/session';
import { describeProviderPosture } from '@/lib/env';

export const dynamic = 'force-dynamic';

async function signOut(): Promise<void> {
  'use server';
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(token);
  store.delete(SESSION_COOKIE);
  redirect('/login?error=signedout');
}

export default async function ReviewerLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor) redirect('/login');

  const posture = describeProviderPosture();
  const canSeeTips = actor.permissions.includes('tip:read');
  const canAdmin = actor.permissions.includes('admin:settings');

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>

      <nav className="sidebar" aria-label="Primary">
        <a href="/" className="brand">
          Diligence Agent
        </a>
        <span className="brand-sub">Decision-support · not a decision system</span>

        <div className="nav">
          <a href="/">Case queue</a>
          <a href="/queue">Verification queue</a>
          {canSeeTips ? <a href="/tips">Anonymous submissions</a> : null}
          {canAdmin ? <a href="/admin">Administration</a> : null}
        </div>

        <div className="nav-heading">Signed in</div>
        <div className="small" style={{ padding: '0 0.6rem 0.5rem' }}>
          <div>{actor.name}</div>
          <div className="muted mono" style={{ fontSize: '0.72rem' }}>
            {actor.email}
          </div>
          <div className="muted" style={{ marginTop: '0.25rem' }}>
            {actor.roleKey.replace(/_/g, ' ').toLowerCase()}
          </div>
        </div>

        <form action={signOut}>
          <button type="submit" className="btn-secondary btn-small" style={{ width: '100%' }}>
            Sign out
          </button>
        </form>

        {/*
          A paid provider is a running cost and sends applicant documents to a
          third party. Both facts belong in front of the operator at all times,
          not buried in a settings page.
        */}
        {posture.isPaid ? (
          <div className="notice notice-warn small" style={{ marginTop: '1rem' }}>
            <strong>Paid AI provider active</strong>
            {posture.provider} / {posture.model}. Requests are billed and applicant text is sent to that provider.
          </div>
        ) : (
          <div className="small muted" style={{ marginTop: '1rem', padding: '0 0.6rem' }}>
            AI provider: <span className="mono">{posture.provider}</span>
            <br />
            {posture.provider === 'mock' ? 'Deterministic, offline, no API cost.' : 'Local model, no API cost.'}
          </div>
        )}
      </nav>

      <main className="main" id="main">
        {children}
      </main>
    </div>
  );
}
