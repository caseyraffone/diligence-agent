# Recording runbook

Three synthetic candidates staged for a walkthrough, in the order they tell the
story. Everything is fictional.

```bash
npm run db:reset   # clean slate — wipes and re-seeds
npm run demo       # adds DEMO-1, DEMO-2, DEMO-3
npm run dev        # http://localhost:3200
```

Password for every account: `DemoReviewer!2026`

Re-run `npm run demo` any time to reset just the demo cases; it deletes and
rebuilds anything prefixed `DEMO-` and leaves the rest alone. Safe to run
between takes.

---

## DEMO-1 · Maya Chen — an ordinary, legitimate record

**Sign in as** `lead@aurora.example`

This is the most important case in the video, and the reason is that
**nothing is flagged**. Zero observations.

She has three things that a careless screening tool flags on every one of them:

- a summer internship **during** her degree — the commonest false positive in
  credential screening,
- an employer with no public employment record,
- volunteering that no registry covers.

**On camera:** open _Claims & evidence_ and scroll to the Star Mountain Capital
claim. It reads:

|                          |                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Organisation context** | GLEIF confirms the organisation exists and is registered. It does not address the applicant's engagement there. |
| **Claim evidence**       | Employer verification holds no record — an evidence gap, not a negative finding.                                |
| **Status**               | Unable to verify                                                                                                |

That block is the thesis of the whole product. Point at the sentence _"nothing
below speaks to this claim"_ — the system is refusing to let a registry hit
corroborate an employment claim it never addressed.

Then open the _Observations_ tab and show it is **empty**.

---

## DEMO-2 · Priya Raman — a genuine conflict

**Sign in as** `lead@redwood.example`

A competition placement where two independent sources hold records that differ
from the claim: the organiser's published standings, and an archived capture of
the same page from shortly after the event.

**On camera:**

1. _Observations_ — read one aloud. Note that it states what differs and offers
   ordinary explanations, and never says the applicant lied.
2. _Outreach & clarifications_ — a clarification has already been sent to the
   applicant, and a letter to the competition organiser sits awaiting approval.
   Good moment to say the system drafts and a person sends.
3. _Claims & evidence_ — the claim sits at **Human review required**. Record the
   outcome live: choose _Conflicting information_ and type a rationale. Show
   that a rationale is mandatory.

The teaching point: two independent checks disagreeing is the strongest signal
this system produces, and it still does not conclude anything.

---

## DEMO-3 · Amara Okonkwo — publication verification

**Sign in as** `lead@redwood.example`

Two publications, deliberately:

- `10.5281/zenodo.7654321` — resolves and confirms the work.
- `10.1038/nature14539` — **a real DOI.** Offline it reports an evidence gap.

### To show a live lookup on camera

```bash
# in .env
ENABLE_LIVE_SOURCES="true"
LIVE_SOURCE_CONTACT_EMAIL="you@yourdomain.com"
```

Restart, open the claim, press **Run check** on the Crossref row.

**Test this before you film.** The live HTTP path has never been exercised —
the container this was built in blocks outbound network, so the code is written
and its response handling is unit-tested against recorded payloads, but the real
call is unproven. If it works it is the strongest thirty seconds in the video.
If it does not, you want to know now.

Expect a **partial match**: Crossref will confirm the paper exists and report
that the applicant is not in the author list. That is a better demo than a clean
pass, because the wording shows the discipline — _"author metadata is often
incomplete, and names change; this is a question to put to the applicant, not a
finding."_

---

## A caution about the framing

It is tempting to present the Star Mountain result as "my first version failed."
It did not. The system returned _unable to verify_, which was correct.

The honest version is stronger and survives a technical audience:

> "It came back 'unable to verify', and my first instinct was that I'd built it
> wrong. Then I realised there is no public record of who interned anywhere. The
> system was right and my expectation was wrong — and that changed how I designed
> everything after it."

Same beat, and nobody in the comments can take it apart.

---

## Other things worth showing

| Where                                                      | Why it lands                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Any case → _Report_ → Download PDF                         | Confirmed facts, applicant statements, third-party statements, system observations, and inferences are printed as separate sections. |
| Any case → _Audit history_                                 | "Chain intact" — every view, edit, and export hash-chained.                                                                          |
| `/admin` as `admin@redwood.example`                        | Which sources are live versus fixture-backed, stated plainly. Also shows the AI provider costs nothing.                              |
| Sign in as `lead@aurora.example` vs `lead@redwood.example` | Two tenants, completely separate case lists.                                                                                         |
| DEMO-2 → `raman-*.txt` documents                           | The seeded case includes a prompt-injection payload recorded as an observation and ignored.                                          |
| `npm test`                                                 | 282 tests, including an accuracy corpus reporting 100% recall, 100% precision, 0% false-positive rate.                               |

## What not to claim on camera

- That it can verify employment by searching the web. It cannot, and neither can
  anything else.
- That it is production-ready. FCRA adverse-action workflow, SSO, SOC 2, and a
  penetration test all stand between here and a real pilot. See `IMPROVEMENTS.md`.
- That the accuracy figure generalises. Twelve labelled cases catch regressions;
  they are not a population-level claim.
