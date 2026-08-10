import { prisma } from '@/lib/prisma';
import { submitAnonymousTip } from '@/modules/tips';
import { redirect } from 'next/navigation';
import { AppError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/**
 * Public, unauthenticated tip intake.
 *
 * No identity is collected — no name, no email, no IP is stored. The only
 * submitter-derived value is a coarse salted signal used for rate limiting, and
 * even that is HMAC'd rather than stored raw.
 */
async function submit(formData: FormData): Promise<void> {
  'use server';

  const organizationSlug = String(formData.get('organizationSlug') ?? '');
  const organization = await prisma.organization.findUnique({ where: { slug: organizationSlug } });
  if (!organization) redirect('/tips/new?state=error');

  try {
    await submitAnonymousTip({
      organizationId: organization.id,
      allegationText: String(formData.get('allegationText') ?? ''),
      claimedEvidence: String(formData.get('claimedEvidence') ?? '') || undefined,
      // Deliberately coarse: enough to blunt a flood, useless for identifying anyone.
      submissionSignal: `public:${organization.id}`,
    });
  } catch (e) {
    if (e instanceof AppError) redirect(`/tips/new?state=${e.code === 'RATE_LIMITED' ? 'ratelimited' : 'invalid'}`);
    throw e;
  }

  redirect('/tips/new?state=received');
}

const STATES: Record<string, { tone: string; text: string }> = {
  received: {
    tone: 'notice',
    text:
      'Thank you. Your submission has been recorded as an unverified allegation and is visible only to authorised ' +
      'reviewers. It will not change any assessment on its own — a reviewer must find independent evidence before ' +
      'anything follows from it.',
  },
  ratelimited: {
    tone: 'notice notice-warn',
    text: 'Too many submissions have been received recently. Please try again later.',
  },
  invalid: {
    tone: 'notice notice-warn',
    text: 'The submission could not be accepted. Please describe the concern in at least 20 characters.',
  },
  error: { tone: 'notice notice-warn', text: 'That organisation was not recognised.' },
};

export default async function NewTipPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const { state } = await searchParams;
  const organizations = await prisma.organization.findMany({ orderBy: { name: 'asc' }, select: { slug: true, name: true } });
  const banner = state ? STATES[state] : null;

  return (
    <main className="portal">
      <div className="portal-head">
        <h1>Confidential submission</h1>
        <p className="muted">
          If you have a concern about information in an application under review, you can describe it here without
          giving your name.
        </p>
      </div>

      {banner ? (
        <div className={banner.tone} role="status">
          {banner.text}
        </div>
      ) : null}

      <div className="notice">
        <strong>Please read before submitting</strong>
        What you write is treated as an <em>unverified allegation</em>, not as evidence. It cannot change any
        assessment by itself: a reviewer must independently establish anything that follows from it. The person
        concerned will not be told who submitted this, and we do not record your name, email address, or IP address.
        <br />
        <br />
        Please describe only what you observed and what could be checked. Submissions about someone’s race, religion,
        disability, health, sex, gender, sexual orientation, age, family circumstances, or immigration status are out
        of scope and will be closed without being used.
      </div>

      <form action={submit} className="card">
        <div className="field">
          <label htmlFor="organizationSlug">Which organisation is reviewing the application?</label>
          <select id="organizationSlug" name="organizationSlug" required>
            {organizations.map((o) => (
              <option key={o.slug} value={o.slug}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="allegationText">What is your concern?</label>
          <textarea
            id="allegationText"
            name="allegationText"
            required
            minLength={20}
            maxLength={10000}
            placeholder="Describe what you observed, and where a reviewer might check it."
          />
          <span className="hint">At least 20 characters. Facts that can be checked are far more useful than opinions.</span>
        </div>
        <div className="field">
          <label htmlFor="claimedEvidence">Is there anything a reviewer could look at? (optional)</label>
          <textarea id="claimedEvidence" name="claimedEvidence" maxLength={5000} style={{ minHeight: '5rem' }} />
        </div>
        <button type="submit">Submit confidentially</button>
      </form>

      <p className="small muted">
        <a href="/login">Return to sign in</a>
      </p>
    </main>
  );
}
