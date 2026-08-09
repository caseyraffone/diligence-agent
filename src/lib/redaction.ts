/**
 * Redaction of government identifiers and unrelated sensitive data.
 *
 * Applied to extracted text *before* it is written to the database, so the
 * derived-data store never contains identifiers the verification purpose does
 * not need. Original bytes remain in encrypted object storage under retention
 * control; they are not searchable and not shown in the claim workspace.
 *
 * This is deliberately conservative pattern matching. It is a data-minimisation
 * control, not a guarantee: see LIMITATIONS.md.
 */

export type RedactionKind =
  | 'US_SSN'
  | 'US_ITIN'
  | 'PASSPORT_LIKE'
  | 'NATIONAL_ID_LABELLED'
  | 'PAYMENT_CARD'
  | 'BANK_ACCOUNT_LABELLED'
  | 'DATE_OF_BIRTH_LABELLED';

export interface RedactionHit {
  kind: RedactionKind;
  /** Character offset in the input text. */
  index: number;
  length: number;
}

export interface RedactionResult {
  text: string;
  hits: RedactionHit[];
}

interface Rule {
  kind: RedactionKind;
  pattern: RegExp;
  /** Which capture group holds the sensitive value; 0 = whole match. */
  group: number;
}

const RULES: Rule[] = [
  // 123-45-6789 / 123 45 6789, and the labelled bare-9-digit form.
  { kind: 'US_SSN', pattern: /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g, group: 0 },
  {
    kind: 'US_SSN',
    pattern: /\b(?:SSN|Social Security(?: Number| No\.?)?)\s*[:#]?\s*(\d{3}[- ]?\d{2}[- ]?\d{4})\b/gi,
    group: 1,
  },
  { kind: 'US_ITIN', pattern: /\b9\d{2}[- ]?(?:5\d|6[0-5]|7\d|8[0-8]|9[0-2]|9[4-9])[- ]?\d{4}\b/g, group: 0 },
  {
    kind: 'PASSPORT_LIKE',
    pattern: /\bPassport(?:\s*(?:No|Number|#))?\s*[:#]?\s*([A-Z0-9]{6,9})\b/gi,
    group: 1,
  },
  {
    kind: 'NATIONAL_ID_LABELLED',
    pattern: /\b(?:National ID|NRIC|Aadhaar|CPF|NIN|PPS(?:N)?|SIN)\s*[:#]?\s*([A-Z0-9][A-Z0-9 -]{5,17})\b/gi,
    group: 1,
  },
  // Card-shaped digit runs. Luhn is checked separately to cut false positives.
  { kind: 'PAYMENT_CARD', pattern: /\b(?:\d[ -]?){12,18}\d\b/g, group: 0 },
  {
    kind: 'BANK_ACCOUNT_LABELLED',
    pattern: /\b(?:Account(?:\s*(?:No|Number|#))?|IBAN|Routing(?:\s*(?:No|Number|#))?)\s*[:#]?\s*([A-Z0-9][A-Z0-9 -]{6,32})\b/gi,
    group: 1,
  },
  {
    kind: 'DATE_OF_BIRTH_LABELLED',
    pattern: /\b(?:DOB|Date of Birth|Birth ?date)\s*[:#]?\s*([0-9]{1,4}[/\-. ][0-9]{1,2}[/\-. ][0-9]{2,4}|[A-Z][a-z]+ \d{1,2},? \d{4})/gi,
    group: 1,
  },
];

function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

const MASK: Record<RedactionKind, string> = {
  US_SSN: '[REDACTED:GOV_ID]',
  US_ITIN: '[REDACTED:GOV_ID]',
  PASSPORT_LIKE: '[REDACTED:PASSPORT]',
  NATIONAL_ID_LABELLED: '[REDACTED:NATIONAL_ID]',
  PAYMENT_CARD: '[REDACTED:PAYMENT]',
  BANK_ACCOUNT_LABELLED: '[REDACTED:FINANCIAL]',
  DATE_OF_BIRTH_LABELLED: '[REDACTED:DOB]',
};

/**
 * Replaces sensitive spans with typed placeholders. Offsets in `hits` refer to
 * the *input* string so a reviewer tool could highlight the original.
 */
export function redact(input: string): RedactionResult {
  interface Span {
    start: number;
    end: number;
    kind: RedactionKind;
  }
  const spans: Span[] = [];

  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const captured = rule.group === 0 ? m[0] : m[rule.group];
      if (captured === undefined) continue;

      // Payment-card shaped runs are only redacted when they actually check out
      // as card numbers. A student ID or a long grant number should survive.
      if (rule.kind === 'PAYMENT_CARD' && !luhnValid(captured)) continue;

      const offset = rule.group === 0 ? m.index : m[0].indexOf(captured) + m.index;
      spans.push({ start: offset, end: offset + captured.length, kind: rule.kind });
    }
  }

  if (spans.length === 0) return { text: input, hits: [] };

  spans.sort((a, b) => a.start - b.start || b.end - a.end);

  // Drop spans contained in an earlier span so masks never nest.
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) continue;
    merged.push(s);
  }

  let out = '';
  let cursor = 0;
  const hits: RedactionHit[] = [];
  for (const s of merged) {
    out += input.slice(cursor, s.start) + MASK[s.kind];
    hits.push({ kind: s.kind, index: s.start, length: s.end - s.start });
    cursor = s.end;
  }
  out += input.slice(cursor);
  return { text: out, hits };
}

/** True when the text still contains something that looks like a government id. */
export function containsGovernmentIdentifier(text: string): boolean {
  return redact(text).hits.some(
    (h) => h.kind === 'US_SSN' || h.kind === 'US_ITIN' || h.kind === 'NATIONAL_ID_LABELLED' || h.kind === 'PASSPORT_LIKE',
  );
}
