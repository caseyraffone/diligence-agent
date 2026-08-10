import { createHash } from 'node:crypto';
import type { GenerateInput, GenerateOutput, LlmProvider, UntrustedBlock } from './types';
import { scanForInjectionAttempts } from './prompt';
import { extractDoi } from '@/lib/text';
import type { ExtractedClaimPayload } from './schemas';

/**
 * Deterministic, offline, zero-cost provider. The default everywhere.
 *
 * This is not a stub that returns canned strings. It is a genuine rule-based
 * extractor over the supplied text, so the seeded demonstration cases, the
 * reviewer dashboard, the discrepancy engine, and the reports all exercise real
 * data end to end without an API key.
 *
 * Determinism is a feature: the same document always yields the same claims, so
 * cross-document consistency tests and adversarial fixtures assert on stable
 * output.
 *
 * It deliberately does NOT follow instructions found in the text it reads. It
 * pattern-matches; there is no instruction-following surface to hijack.
 */

const SECTION_PATTERNS: Array<{ re: RegExp; category: ExtractedClaimPayload['category'] }> = [
  { re: /^(education|academic background|academics)\b/i, category: 'EDUCATION_ENROLLMENT' },
  { re: /^(experience|employment|work experience|professional experience|internships?)\b/i, category: 'EMPLOYMENT' },
  { re: /^(research|research experience|research positions?)\b/i, category: 'RESEARCH_POSITION' },
  { re: /^(publications?|papers|preprints)\b/i, category: 'PUBLICATION' },
  { re: /^(awards?|honors?|honours?|competitions?|distinctions?)\b/i, category: 'AWARD_COMPETITION' },
  { re: /^(certifications?|licen[cs]es?)\b/i, category: 'CERTIFICATION_LICENSE' },
  { re: /^(athletics?|sports?|varsity)\b/i, category: 'ATHLETIC_PARTICIPATION' },
  { re: /^(volunteer|community|leadership|service|activities)\b/i, category: 'VOLUNTEER_LEADERSHIP' },
  { re: /^(projects?|ventures?|patents?|portfolio|startups?)\b/i, category: 'PROJECT_VENTURE_PATENT' },
];

const FULL_TIME_EXCLUSIONS =
  /\b(part[- ]?time|volunteer|advisor|advisory|board member|mentor|consultant|contract|weekend|evening|shadow)\b/i;

/** Entry line: "Title, Organization (dates)" or "Title, Organization, Location (dates)". */
const ENTRY_RE = /^(?<title>[^,()]{2,120}?)\s*,\s*(?<rest>[^()]{2,200}?)\s*(?:\((?<dates>[^)]{3,60})\))?\s*$/;

const METRIC_RE =
  /(?<value>\$?\d[\d,]*(?:\.\d+)?)\s*(?<scale>million|billion|thousand|k\b|m\b)?\s*(?<unit>users?|customers?|downloads?|students?|participants?|members?|people|hours?|dollars?|usd|revenue|subscribers?|citations?|lines of code|teammates?|engineers?|employees?|percent|%)/gi;

const RANK_RE = /\b(?:ranked|rank|placed|finished|top)\s*(?:#|no\.?\s*)?(\d{1,4})(?:st|nd|rd|th)?\b/i;

export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock' as const;
  readonly model = 'deterministic-mock-v1';
  readonly isPaid = false;

  async generate(input: GenerateInput): Promise<GenerateOutput> {
    const { task, untrusted, instruction } = input.structuredContext;
    const requestId = `mock-${createHash('sha256').update(input.user).digest('hex').slice(0, 12)}`;

    let payload: unknown;
    switch (task) {
      case 'EXTRACT_CLAIMS':
        payload = extractClaims(untrusted);
        break;
      case 'GENERATE_INTERVIEW_QUESTIONS':
        payload = generateInterviewQuestions(untrusted, instruction);
        break;
      case 'DRAFT_CLARIFICATION':
        payload = draftClarification(untrusted, instruction);
        break;
      case 'SUMMARIZE_EVIDENCE':
        payload = summarizeEvidence(untrusted);
        break;
      case 'NORMALIZE_CLAIM':
        payload = { claims: [], documentObservations: [] };
        break;
    }

    return { text: JSON.stringify(payload), requestId };
  }
}

// ---------------------------------------------------------------- extraction

function extractClaims(blocks: UntrustedBlock[]): {
  claims: ExtractedClaimPayload[];
  documentObservations: Array<{ observation: string; whyItMayMatter: string }>;
} {
  const claims: ExtractedClaimPayload[] = [];
  const observations: Array<{ observation: string; whyItMayMatter: string }> = [];

  for (const block of blocks) {
    // Record, but do not obey, anything that reads like an instruction to an
    // automated reader. This is the mock demonstrating the same posture a real
    // provider is instructed to take.
    for (const hit of scanForInjectionAttempts(block.content)) {
      observations.push({
        observation: `Text in ${block.label} appears to address an automated reader: "${truncate(hit.excerpt, 200)}"`,
        whyItMayMatter:
          'Documents do not normally contain directions aimed at software. The passage was recorded and ignored; ' +
          'it did not affect extraction. A reviewer should look at the original page.',
      });
    }

    let currentCategory: ExtractedClaimPayload['category'] = 'OTHER';
    let lastEntry: ExtractedClaimPayload | null = null;

    const lines = block.content.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const section = SECTION_PATTERNS.find((s) => s.re.test(line.replace(/[:\s]+$/, '')));
      if (section && line.length < 60) {
        currentCategory = section.category;
        lastEntry = null;
        continue;
      }

      if (/^[-•*]\s+/.test(line)) {
        const detail = line.replace(/^[-•*]\s+/, '');
        claims.push(...metricClaims(detail, lastEntry));
        continue;
      }

      const publication = publicationClaim(line, currentCategory);
      if (publication) {
        claims.push(publication);
        lastEntry = publication;
        continue;
      }

      const entry = entryClaim(line, currentCategory);
      if (entry) {
        claims.push(entry);
        lastEntry = entry;
        claims.push(...metricClaims(line, entry));
      }
    }
  }

  return { claims, documentObservations: observations };
}

function publicationClaim(line: string, category: ExtractedClaimPayload['category']): ExtractedClaimPayload | null {
  const doi = extractDoi(line);
  const quoted = /[""„]([^""„"]{6,200})[""]|"([^"]{6,200})"/.exec(line);
  if (!doi && !(quoted && category === 'PUBLICATION')) return null;

  const title = (quoted?.[1] ?? quoted?.[2] ?? line).trim();
  const year = /\b(19|20)\d{2}\b/.exec(line);
  const venue = /\.\s*([A-Z][^.]{3,80}),\s*(?:19|20)\d{2}/.exec(line);

  return {
    sourcePassage: line,
    normalizedText: `Publication: "${truncate(title, 160)}"${doi ? ` (DOI ${doi})` : ''}`,
    category: 'PUBLICATION',
    personName: null,
    organizationName: venue?.[1]?.trim() ?? null,
    title: truncate(title, 300),
    location: null,
    startDate: year ? year[0] : null,
    endDate: year ? year[0] : null,
    datePrecision: year ? 'YEAR' : 'UNKNOWN',
    amountValue: null,
    amountUnit: doi ? `doi:${doi}` : null,
    isObjectivelyVerifiable: true,
    impliesFullTimeCommitment: false,
    extractionConfidence: doi ? 0.95 : 0.72,
  };
}

function entryClaim(line: string, category: ExtractedClaimPayload['category']): ExtractedClaimPayload | null {
  const m = ENTRY_RE.exec(line);
  if (!m?.groups) {
    // A substantive unstructured line still becomes a low-confidence claim so a
    // reviewer can see it and correct it, rather than it being silently dropped.
    if (line.length >= 25 && /[a-z]/.test(line) && !line.endsWith(':')) {
      return {
        sourcePassage: line,
        normalizedText: truncate(line, 300),
        category,
        personName: null,
        organizationName: null,
        title: null,
        location: null,
        startDate: null,
        endDate: null,
        datePrecision: 'UNKNOWN',
        amountValue: null,
        amountUnit: null,
        isObjectivelyVerifiable: category !== 'OTHER',
        impliesFullTimeCommitment: false,
        extractionConfidence: 0.35,
      };
    }
    return null;
  }

  const title = (m.groups['title'] ?? '').trim();
  const restRaw = (m.groups['rest'] ?? '').trim();
  const dates = (m.groups['dates'] ?? '').trim();

  // "Organization, Location" — treat a trailing short capitalized token as location.
  const restParts = restRaw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  let organization = restParts[0] ?? restRaw;
  let location: string | null = null;
  if (restParts.length > 1) {
    const tail = restParts[restParts.length - 1]!;
    if (tail.length <= 32 && /^[A-Z]/.test(tail)) {
      location = tail;
      organization = restParts.slice(0, -1).join(', ');
    }
  }

  const { startDate, endDate, precision } = splitDates(dates);
  const impliesFullTime =
    (category === 'EMPLOYMENT' || category === 'RESEARCH_POSITION' || category === 'EDUCATION_ENROLLMENT') &&
    !FULL_TIME_EXCLUSIONS.test(line);

  const rank = RANK_RE.exec(line);

  return {
    sourcePassage: line,
    normalizedText: `${title} at ${organization}${dates ? ` (${dates})` : ''}`,
    category,
    personName: null,
    organizationName: truncate(organization, 300),
    title: truncate(title, 300),
    location,
    startDate,
    endDate,
    datePrecision: precision,
    amountValue: rank?.[1] ? Number(rank[1]) : null,
    amountUnit: rank?.[1] ? 'rank_position' : null,
    isObjectivelyVerifiable: true,
    impliesFullTimeCommitment: impliesFullTime,
    extractionConfidence: dates ? 0.88 : 0.7,
  };
}

function metricClaims(text: string, parent: ExtractedClaimPayload | null): ExtractedClaimPayload[] {
  const out: ExtractedClaimPayload[] = [];
  const regex = new RegExp(METRIC_RE.source, METRIC_RE.flags);
  let m: RegExpExecArray | null;

  while ((m = regex.exec(text)) !== null) {
    const g = m.groups;
    if (!g) continue;
    const raw = (g['value'] ?? '').replace(/[$,]/g, '');
    let value = Number(raw);
    if (!Number.isFinite(value)) continue;

    const scale = (g['scale'] ?? '').toLowerCase();
    if (scale === 'million' || scale === 'm') value *= 1_000_000;
    else if (scale === 'billion') value *= 1_000_000_000;
    else if (scale === 'thousand' || scale === 'k') value *= 1_000;

    const unit = (g['unit'] ?? '').toLowerCase();

    out.push({
      sourcePassage: text,
      normalizedText: `Quantitative claim: ${value.toLocaleString('en-US')} ${unit}${
        parent?.organizationName ? ` (${parent.organizationName})` : ''
      }`,
      category: 'QUANTITATIVE_METRIC',
      personName: null,
      organizationName: parent?.organizationName ?? null,
      title: parent?.title ?? null,
      location: null,
      startDate: parent?.startDate ?? null,
      endDate: parent?.endDate ?? null,
      datePrecision: parent?.datePrecision ?? 'UNKNOWN',
      amountValue: value,
      amountUnit: unit,
      // Self-reported internal metrics usually cannot be checked against a
      // public record; the reviewer needs to know that up front.
      isObjectivelyVerifiable: /citations?|downloads?|students?|participants?/.test(unit),
      impliesFullTimeCommitment: false,
      extractionConfidence: 0.8,
    });
  }
  return out;
}

function splitDates(dates: string): {
  startDate: string | null;
  endDate: string | null;
  precision: ExtractedClaimPayload['datePrecision'];
} {
  if (!dates) return { startDate: null, endDate: null, precision: 'UNKNOWN' };

  const parts = dates
    .split(/\s*(?:–|—|-|to)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const start = parts[0] ? toIsoish(parts[0]) : null;
  const endToken = parts.length > 1 ? parts[parts.length - 1]! : null;
  const isPresent = endToken ? /^(present|current|now|ongoing)$/i.test(endToken) : false;
  const end = endToken && !isPresent ? toIsoish(endToken) : null;

  const precision: ExtractedClaimPayload['datePrecision'] =
    start && start.length === 7 ? 'MONTH' : start && start.length === 4 ? 'YEAR' : start ? 'DAY' : 'UNKNOWN';

  return { startDate: start, endDate: end, precision };
}

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

function toIsoish(token: string): string | null {
  const t = token.trim();
  const yearOnly = /^((?:19|20)\d{2})$/.exec(t);
  if (yearOnly) return yearOnly[1]!;

  const monthYear = /^([A-Za-z]{3,9})\.?\s+((?:19|20)\d{2})$/.exec(t);
  if (monthYear) {
    const key = (monthYear[1] ?? '').slice(0, 3).toLowerCase();
    const month = MONTHS[key];
    if (month) return `${monthYear[2]}-${month}`;
  }

  const iso = /^((?:19|20)\d{2})-(\d{2})(?:-(\d{2}))?$/.exec(t);
  if (iso) return iso[3] ? `${iso[1]}-${iso[2]}-${iso[3]}` : `${iso[1]}-${iso[2]}`;

  // Seasons are approximate; anchor to the conventional start month.
  const season = /^(spring|summer|fall|autumn|winter)\s+((?:19|20)\d{2})$/i.exec(t);
  if (season) {
    const map: Record<string, string> = { spring: '03', summer: '06', fall: '09', autumn: '09', winter: '01' };
    return `${season[2]}-${map[(season[1] ?? '').toLowerCase()] ?? '01'}`;
  }
  return null;
}

// ---------------------------------------------------------------- other tasks

const INTERVIEW_AREAS = [
  'ORIGINAL_PROBLEM',
  'SPECIFIC_CONTRIBUTION',
  'METHODS_AND_TOOLS',
  'DECISIONS_AND_TRADEOFFS',
  'UNEXPECTED_FAILURES',
  'DATA_SOURCES',
  'RESULTS_AND_LIMITATIONS',
  'COLLABORATION_AND_DIVISION',
  'WHAT_WOULD_CHANGE',
  'TECHNICAL_WALKTHROUGH',
] as const;

const AREA_TEMPLATES: Record<(typeof INTERVIEW_AREAS)[number], { q: (t: string) => string; shows: string }> = {
  ORIGINAL_PROBLEM: {
    q: (t) => `What problem was ${t} trying to solve, and who needed it solved?`,
    shows: 'Familiarity with the motivating context rather than the finished summary.',
  },
  SPECIFIC_CONTRIBUTION: {
    q: (t) => `Within ${t}, which parts did you personally build or decide, and which parts did others own?`,
    shows: 'A specific, bounded account of personal scope consistent with the written description.',
  },
  METHODS_AND_TOOLS: {
    q: (t) => `What tools, languages, or methods did you use in ${t}, and why those rather than the alternatives?`,
    shows: 'Working familiarity with the toolchain and its constraints.',
  },
  DECISIONS_AND_TRADEOFFS: {
    q: (t) => `What was the hardest tradeoff you had to make in ${t}, and what did you give up?`,
    shows: 'Recall of a real decision point, including its cost.',
  },
  UNEXPECTED_FAILURES: {
    q: (t) => `What went wrong during ${t} that you did not anticipate, and how did you find out?`,
    shows: 'Concrete recall of failure modes, which are rarely present in a written summary.',
  },
  DATA_SOURCES: {
    q: (t) => `Where did the data or inputs for ${t} come from, and what were their limitations?`,
    shows: 'Direct knowledge of provenance and quality issues.',
  },
  RESULTS_AND_LIMITATIONS: {
    q: (t) => `What did ${t} actually achieve, and what would you say it did not establish?`,
    shows: 'Calibrated description of outcomes, including limits.',
  },
  COLLABORATION_AND_DIVISION: {
    q: (t) => `How was work divided among the people involved in ${t}, and how did you coordinate?`,
    shows: 'A consistent account of team structure that a collaborator would recognise.',
  },
  WHAT_WOULD_CHANGE: {
    q: (t) => `If you started ${t} again tomorrow, what would you do differently and why?`,
    shows: 'Reflective engagement rather than a memorised description.',
  },
  TECHNICAL_WALKTHROUGH: {
    q: (t) => `Walk through one component of ${t} in detail, from input to output, including where it could break.`,
    shows: 'Depth of understanding at a level difficult to sustain without direct involvement.',
  },
};

function generateInterviewQuestions(blocks: UntrustedBlock[], instruction: string) {
  const subject = truncate(blocks[0]?.content.split('\n')[0]?.trim() || instruction || 'this work', 120);
  return {
    topic: subject,
    questions: INTERVIEW_AREAS.map((area) => ({
      area,
      question: AREA_TEMPLATES[area].q(subject),
      whatACorroboratingAnswerShows: AREA_TEMPLATES[area].shows,
    })),
  };
}

function draftClarification(blocks: UntrustedBlock[], instruction: string) {
  const claimText = truncate(blocks[0]?.content.trim() || 'the claim under review', 300);
  const issue = truncate(blocks[1]?.content.trim() || instruction, 400);

  return {
    subject: 'Request for clarification regarding information in your application',
    body: [
      'Hello,',
      '',
      'We are reviewing the materials submitted with your application and would like to give you an opportunity to clarify one item.',
      '',
      `The item under review is: ${claimText}`,
      '',
      `What we would like to understand: ${issue}`,
      '',
      'There may be a straightforward explanation, and we have not drawn any conclusion. Differences of this kind often come from a change in a role title, a correction to dates, an organisation renaming itself, or records being held somewhere we have not yet checked.',
      '',
      'If you are able to provide any of the supporting materials listed with this request, that will help us complete our review. If you believe our understanding of the item is mistaken, please tell us and we will correct our record.',
      '',
      'Thank you for your help.',
    ].join('\n'),
    acceptableEvidence: [
      'A letter or email from the organisation confirming the dates and title, sent from an official address',
      'An official document such as an offer letter, contract, transcript, or certificate',
      'The name and contact details of someone at the organisation authorised to confirm this on your behalf',
      'A written explanation of the difference, if the record itself is not available to you',
    ],
  };
}

function summarizeEvidence(blocks: UntrustedBlock[]) {
  const lines = blocks.flatMap((b) =>
    b.content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const supporting = lines.filter((l) => /^SUPPORTING/i.test(l)).length;
  const conflicting = lines.filter((l) => /^CONFLICTING/i.test(l)).length;
  const neutral = lines.filter((l) => /^NEUTRAL/i.test(l)).length;

  const parts: string[] = [
    `${supporting} item(s) of supporting evidence, ${conflicting} conflicting, and ${neutral} neutral observation(s) are attached to this claim.`,
  ];
  if (conflicting > 0) {
    parts.push(
      'At least one source states something materially different from the claim. The difference is documented above; its cause has not been established.',
    );
  }
  if (supporting === 0 && conflicting === 0) {
    parts.push(
      'No source consulted so far holds a record either way. This is an evidence gap and is not an indication that the claim is inaccurate.',
    );
  }

  const openQuestions: string[] = [];
  if (conflicting > 0)
    openQuestions.push('Which record is authoritative for this fact, and has the issuer been asked directly?');
  if (supporting === 0) openQuestions.push('Is there an issuing organisation that could confirm this directly?');

  return { summary: parts.join(' '), openQuestions };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
