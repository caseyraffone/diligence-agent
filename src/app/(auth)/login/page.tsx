import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { verifyPassword } from '@/lib/crypto';
import { createSession, sessionCookieOptions, SESSION_COOKIE } from '@/lib/auth/session';
import { consumeRateLimit } from '@/lib/ratelimit';
import { getEnv } from '@/lib/env';
import { getActor } from '@/lib/auth/context';

export const dynamic = 'force-dynamic';

async function signIn(formData: FormData): Promise<void> {
  'use server';

  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) redirect('/login?error=missing');

  // Rate limited per email address, so an attacker cannot grind one account,
  // and per-IP-ish signal is deliberately not collected here.
  const limit = await consumeRateLimit({
    scope: 'login',
    identifier: email,
    limit: getEnv().LOGIN_RATE_LIMIT_PER_15MIN,
    windowSeconds: 900,
  });
  if (!limit.allowed) redirect('/login?error=ratelimited');

  const user = await prisma.user.findFirst({
    where: { email, isActive: true },
    include: { role: true },
  });

  // Always run a verification, even for an unknown address, so response timing
  // does not reveal whether an account exists.
  const stored = user?.passwordHash ?? '$scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const ok = await verifyPassword(password, stored);

  if (!user || !ok) redirect('/login?error=invalid');

  const headerList = await headers();
  const session = await createSession(user.id, headerList.get('user-agent'));

  const store = await cookies();
  store.set(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  redirect('/');
}

const MESSAGES: Record<string, string> = {
  missing: 'Enter both an email address and a password.',
  invalid: 'Those sign-in details were not recognised.',
  ratelimited: 'Too many sign-in attempts. Please wait a few minutes and try again.',
  signedout: 'You have been signed out.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getActor()) redirect('/');

  const params = await searchParams;
  const message = params.error ? MESSAGES[params.error] : null;

  return (
    <main className="portal">
      <div className="portal-head">
        <h1>Credential Integrity Agent</h1>
        <p className="muted">
          Investigative decision-support for authorised verification teams. Access is restricted to named reviewers,
          and every action you take in this system is logged.
        </p>
      </div>

      {message ? (
        <div className="notice notice-warn" role="alert">
          {message}
        </div>
      ) : null}

      <form action={signIn} className="card">
        <div className="field">
          <label htmlFor="email">Email address</label>
          <input id="email" name="email" type="email" autoComplete="username" required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <button type="submit">Sign in</button>
      </form>

      <div className="notice small">
        <strong>Demonstration deployment</strong>
        Seeded sign-ins: <span className="mono">lead@redwood.example</span> (lead reviewer),{' '}
        <span className="mono">reviewer@redwood.example</span>, <span className="mono">auditor@redwood.example</span>{' '}
        (read-only), <span className="mono">lead@aurora.example</span> (a separate tenant). Password:{' '}
        <span className="mono">DemoReviewer!2026</span>. All data is fictional.
      </div>

      <p className="small muted">
        Submitting a confidential concern about an application?{' '}
        <a href="/tips/new">Use the anonymous submission form</a>.
      </p>
    </main>
  );
}
