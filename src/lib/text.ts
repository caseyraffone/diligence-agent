/**
 * Deterministic text normalisation and fuzzy matching.
 *
 * Used for comparing organisation names, person names, and job titles across
 * documents. Two properties matter more than raw accuracy here:
 *
 *  1. It must be conservative. A name that merely *looks* different is not
 *     evidence of anything — "Universidad Nacional Autónoma de México" and
 *     "UNAM" are the same institution, and an organisation that renamed itself
 *     is not an inconsistency. Known aliases and equivalences win over string
 *     distance.
 *  2. It must never be the sole basis for a discrepancy. Callers pair a
 *     mismatch with corroborating signal before raising anything.
 */

const ORG_STOPWORDS = new Set([
  'the',
  'of',
  'and',
  'at',
  'for',
  'a',
  'an',
  'inc',
  'incorporated',
  'llc',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'plc',
  'gmbh',
  'sa',
  'sas',
  'bv',
  'nv',
  'ab',
  'oy',
  'as',
  'spa',
  'srl',
  'pty',
  'company',
  'group',
  'holdings',
  'technologies',
  'technology',
  'labs',
  'laboratory',
]);

const TITLE_SYNONYMS: Array<Set<string>> = [
  new Set(['software engineer', 'software developer', 'programmer', 'sde']),
  new Set(['senior software engineer', 'sr software engineer', 'software engineer ii', 'software engineer 2']),
  new Set(['research assistant', 'undergraduate researcher', 'student researcher']),
  new Set(['intern', 'internship', 'summer intern', 'trainee']),
  new Set(['principal investigator', 'pi', 'lab director']),
  new Set(['founder', 'co-founder', 'cofounder']),
  new Set(['chief executive officer', 'ceo']),
  new Set(['teaching assistant', 'ta', 'course assistant']),
];

/**
 * Organisations that are the same entity under different names, including
 * renames and local-language forms. In production this table is per-tenant and
 * editable; the built-ins exist so the seeded demonstration cases behave
 * correctly and so the "renamed organisation" adversarial fixture does not
 * produce a false positive.
 */
const ORG_EQUIVALENCE: string[][] = [
  ['meta platforms', 'facebook'],
  ['alphabet', 'google'],
  ['x corp', 'twitter'],
  ['universidad nacional autonoma de mexico', 'unam', 'national autonomous university of mexico'],
  ['eidgenossische technische hochschule zurich', 'eth zurich', 'swiss federal institute of technology zurich'],
  ['indian institute of technology bombay', 'iit bombay', 'iitb'],
  ['massachusetts institute of technology', 'mit'],
  ['california institute of technology', 'caltech'],
  ['nanyang technological university', 'ntu singapore'],
  ['deutsches zentrum fur luft und raumfahrt', 'german aerospace center', 'dlr'],
];

/** Strips diacritics, punctuation, and case. Keeps word order. */
export function normalizeText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeOrganization(input: string): string {
  const base = normalizeText(input);
  const kept = base.split(' ').filter((w) => w && !ORG_STOPWORDS.has(w));
  // Never normalise an organisation away to nothing; fall back to the base form.
  return kept.length > 0 ? kept.join(' ') : base;
}

/** Canonical key for an organisation, collapsing known aliases to one form. */
export function organizationKey(input: string): string {
  const norm = normalizeOrganization(input);
  for (const group of ORG_EQUIVALENCE) {
    const normalized = group.map((g) => normalizeOrganization(g));
    if (normalized.includes(norm)) return normalized[0]!;
  }
  return norm;
}

export function organizationsMatch(a: string, b: string): boolean {
  if (organizationKey(a) === organizationKey(b)) return true;
  const na = normalizeOrganization(a);
  const nb = normalizeOrganization(b);
  if (!na || !nb) return false;
  // Acronym form: "MIT" vs "Massachusetts Institute of Technology".
  if (isAcronymOf(na, nb) || isAcronymOf(nb, na)) return true;
  // Containment handles "Google" vs "Google Research".
  if (na.startsWith(`${nb} `) || nb.startsWith(`${na} `)) return true;
  return similarity(na, nb) >= 0.92;
}

function isAcronymOf(short: string, long: string): boolean {
  const compact = short.replace(/\s/g, '');
  if (compact.length < 2 || compact.length > 8) return false;
  const initials = long
    .split(' ')
    .map((w) => w[0] ?? '')
    .join('');
  return initials === compact;
}

export function normalizeTitle(input: string): string {
  return normalizeText(input)
    .replace(/\b(sr|snr)\b/g, 'senior')
    .replace(/\b(jr)\b/g, 'junior');
}

export function titlesMatch(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return true;
  for (const group of TITLE_SYNONYMS) {
    if (group.has(na) && group.has(nb)) return true;
  }
  return similarity(na, nb) >= 0.9;
}

export interface NameComparison {
  match: boolean;
  /**
   * True when the two forms are consistent but not conclusive — e.g. an
   * initial matching a full first name. The caller must not treat an ambiguous
   * name as a confirmed identity match.
   */
  ambiguous: boolean;
  reason: string;
}

/**
 * Compares person names conservatively. "J. Smith" vs "Jane Smith" is a
 * *possible* match, not a confirmed one, and there may be many J. Smiths.
 */
export function comparePersonNames(a: string, b: string): NameComparison {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return { match: false, ambiguous: true, reason: 'One or both names are empty.' };
  if (na === nb) return { match: true, ambiguous: false, reason: 'Exact normalized match.' };

  const ta = na.split(' ');
  const tb = nb.split(' ');
  const lastA = ta[ta.length - 1]!;
  const lastB = tb[tb.length - 1]!;
  if (lastA !== lastB && similarity(lastA, lastB) < 0.9) {
    return { match: false, ambiguous: false, reason: 'Family names differ.' };
  }

  const firstA = ta[0]!;
  const firstB = tb[0]!;
  if (firstA === firstB) {
    return { match: true, ambiguous: ta.length !== tb.length, reason: 'Given and family names agree.' };
  }
  const initialMatch =
    (firstA.length === 1 && firstB.startsWith(firstA)) || (firstB.length === 1 && firstA.startsWith(firstB));
  if (initialMatch) {
    return {
      match: true,
      ambiguous: true,
      reason: 'Given name is abbreviated to an initial; several people may share this form.',
    };
  }
  return { match: false, ambiguous: true, reason: 'Given names differ; may be a different person or a name change.' };
}

/** Normalized Levenshtein similarity in [0,1]. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/** Stable hash for duplicate detection over free text (tips, allegations). */
export function contentFingerprint(text: string): string {
  const words = normalizeText(text).split(' ').filter(Boolean);
  return words.join(' ');
}

/** Extracts a DOI if present. Used to link publication claims to Crossref. */
export function extractDoi(text: string): string | null {
  const m = /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/.exec(text);
  return m ? (m[1] ?? null) : null;
}

/** Extracts an ORCID iD if present. */
export function extractOrcid(text: string): string | null {
  const m = /\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/.exec(text);
  return m ? (m[1] ?? null) : null;
}
