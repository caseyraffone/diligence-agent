/**
 * Deterministic date handling. Nothing here calls a model.
 *
 * Everything is computed in UTC. Application documents state dates like
 * "Summer 2023" or "05/2022"; we keep an explicit precision alongside the
 * instant so downstream rules never treat a year-only claim as a day-precise
 * one. Overlap analysis in particular must not flag two month-precision ranges
 * as conflicting when the underlying days may not overlap at all.
 */

export type Precision = 'DAY' | 'MONTH' | 'YEAR' | 'RANGE_APPROXIMATE' | 'UNKNOWN';

export interface ParsedDate {
  date: Date;
  precision: Precision;
  /** Latest instant still consistent with the stated precision. */
  upperBound: Date;
}

export interface DateRange {
  start: Date | null;
  end: Date | null;
  precision: Precision;
  /** An open end means "to present"; it is not the same as unknown. */
  isOngoing: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

// Seasons map to their conventional northern-hemisphere academic spans. They
// are inherently approximate and are recorded as such.
const SEASONS: Record<string, { startMonth: number; endMonth: number }> = {
  winter: { startMonth: 0, endMonth: 2 },
  spring: { startMonth: 2, endMonth: 5 },
  summer: { startMonth: 5, endMonth: 8 },
  fall: { startMonth: 8, endMonth: 11 },
  autumn: { startMonth: 8, endMonth: 11 },
};

const ONGOING = /^(present|current|now|ongoing|to date)$/i;

function utc(y: number, m = 0, d = 1): Date {
  return new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
}

function endOfMonth(y: number, m: number): Date {
  return new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
}

function endOfYear(y: number): Date {
  return new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999));
}

/**
 * Parses a single date token. Returns null when the token carries no usable
 * date — callers must treat that as "unknown", never as "false".
 */
export function parseDateToken(raw: string): ParsedDate | null {
  const s = raw.trim().replace(/[,]/g, ' ').replace(/\s+/g, ' ');
  if (!s || ONGOING.test(s)) return null;

  // ISO: 2023-05-14 / 2023-05 / 2023
  const iso = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(s);
  if (iso) {
    const y = Number(iso[1]);
    if (iso[3] !== undefined) {
      const m = Number(iso[2]) - 1;
      const d = Number(iso[3]);
      if (m < 0 || m > 11 || d < 1 || d > 31) return null;
      return { date: utc(y, m, d), precision: 'DAY', upperBound: new Date(utc(y, m, d).getTime() + 86_399_999) };
    }
    if (iso[2] !== undefined) {
      const m = Number(iso[2]) - 1;
      if (m < 0 || m > 11) return null;
      return { date: utc(y, m), precision: 'MONTH', upperBound: endOfMonth(y, m) };
    }
    return { date: utc(y), precision: 'YEAR', upperBound: endOfYear(y) };
  }

  // US numeric: 05/14/2023 or 05/2023
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (us) {
    const m = Number(us[1]) - 1;
    const d = Number(us[2]);
    let y = Number(us[3]);
    if (y < 100) y += y < 50 ? 2000 : 1900;
    if (m < 0 || m > 11 || d < 1 || d > 31) return null;
    return { date: utc(y, m, d), precision: 'DAY', upperBound: new Date(utc(y, m, d).getTime() + 86_399_999) };
  }
  const usShort = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (usShort) {
    const m = Number(usShort[1]) - 1;
    const y = Number(usShort[2]);
    if (m < 0 || m > 11) return null;
    return { date: utc(y, m), precision: 'MONTH', upperBound: endOfMonth(y, m) };
  }

  // "May 2023" / "May 14 2023" / "14 May 2023"
  const monthWord = /^([A-Za-z]+)\.? ?(\d{1,2})? ?(\d{4})$/.exec(s);
  if (monthWord) {
    const key = (monthWord[1] ?? '').toLowerCase();
    const y = Number(monthWord[3]);
    if (key in MONTHS) {
      const m = MONTHS[key]!;
      if (monthWord[2] !== undefined) {
        const d = Number(monthWord[2]);
        return { date: utc(y, m, d), precision: 'DAY', upperBound: new Date(utc(y, m, d).getTime() + 86_399_999) };
      }
      return { date: utc(y, m), precision: 'MONTH', upperBound: endOfMonth(y, m) };
    }
    if (key in SEASONS) {
      const season = SEASONS[key]!;
      return { date: utc(y, season.startMonth), precision: 'RANGE_APPROXIMATE', upperBound: endOfMonth(y, season.endMonth) };
    }
  }
  const dayFirst = /^(\d{1,2}) ([A-Za-z]+)\.? (\d{4})$/.exec(s);
  if (dayFirst) {
    const key = (dayFirst[2] ?? '').toLowerCase();
    if (key in MONTHS) {
      const m = MONTHS[key]!;
      const d = Number(dayFirst[1]);
      const y = Number(dayFirst[3]);
      return { date: utc(y, m, d), precision: 'DAY', upperBound: new Date(utc(y, m, d).getTime() + 86_399_999) };
    }
  }

  return null;
}

/** Parses "Jan 2022 – Present", "2019-2023", "Summer 2021". */
export function parseDateRange(raw: string): DateRange {
  const s = raw.trim().replace(/[–—]/g, '-');
  const sep = /\s+(?:to|until|through)\s+|\s*-\s*(?![0-9]{1,2}\b(?:-\d))|\s*-\s*/i;

  const parts = s.split(sep).map((p) => p.trim()).filter(Boolean);

  if (parts.length >= 2) {
    const startTok = parts[0]!;
    const endTok = parts[parts.length - 1]!;
    const start = parseDateToken(startTok);
    const isOngoing = ONGOING.test(endTok);
    const end = isOngoing ? null : parseDateToken(endTok);
    const precision = weakestPrecision(start?.precision, end?.precision);
    return {
      start: start?.date ?? null,
      end: end ? end.upperBound : null,
      precision,
      isOngoing,
    };
  }

  const single = parseDateToken(s);
  if (!single) return { start: null, end: null, precision: 'UNKNOWN', isOngoing: false };
  return { start: single.date, end: single.upperBound, precision: single.precision, isOngoing: false };
}

const PRECISION_RANK: Record<Precision, number> = {
  DAY: 0,
  MONTH: 1,
  RANGE_APPROXIMATE: 2,
  YEAR: 3,
  UNKNOWN: 4,
};

export function weakestPrecision(...values: Array<Precision | undefined>): Precision {
  const present = values.filter((v): v is Precision => v !== undefined);
  if (present.length === 0) return 'UNKNOWN';
  return present.reduce((worst, v) => (PRECISION_RANK[v] > PRECISION_RANK[worst] ? v : worst));
}

export interface OverlapResult {
  overlaps: boolean;
  /** Whole days of overlap, 0 when none. */
  days: number;
  /**
   * True when both ranges are coarse enough that the apparent overlap could be
   * an artefact of precision rather than a real conflict. Callers must not
   * raise a discrepancy on an ambiguous overlap alone.
   */
  ambiguousDueToPrecision: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Computes overlap between two ranges. An open (ongoing) end is treated as
 * extending to `asOf`.
 */
export function rangeOverlap(a: DateRange, b: DateRange, asOf: Date = new Date()): OverlapResult {
  const aStart = a.start;
  const bStart = b.start;
  if (!aStart || !bStart) return { overlaps: false, days: 0, ambiguousDueToPrecision: true };

  const aEnd = a.isOngoing ? asOf : a.end;
  const bEnd = b.isOngoing ? asOf : b.end;
  if (!aEnd || !bEnd) return { overlaps: false, days: 0, ambiguousDueToPrecision: true };

  const start = Math.max(aStart.getTime(), bStart.getTime());
  const end = Math.min(aEnd.getTime(), bEnd.getTime());
  const ms = end - start;
  if (ms <= 0) return { overlaps: false, days: 0, ambiguousDueToPrecision: false };

  const days = Math.floor(ms / DAY_MS);
  const coarse =
    PRECISION_RANK[a.precision] >= PRECISION_RANK['MONTH'] && PRECISION_RANK[b.precision] >= PRECISION_RANK['MONTH'];

  // With two month-or-coarser ranges, an overlap shorter than the coarser unit
  // tells us nothing. Treat it as ambiguous rather than as a conflict.
  const ambiguous = coarse && days < 31;

  return { overlaps: true, days, ambiguousDueToPrecision: ambiguous };
}

/** Inclusive whole-day duration of a range, or null when unbounded. */
export function durationDays(range: DateRange, asOf: Date = new Date()): number | null {
  if (!range.start) return null;
  const end = range.isOngoing ? asOf : range.end;
  if (!end) return null;
  return Math.max(0, Math.round((end.getTime() - range.start.getTime()) / DAY_MS));
}

export function toRange(
  start: Date | null | undefined,
  end: Date | null | undefined,
  precision: Precision,
): DateRange {
  return {
    start: start ?? null,
    end: end ?? null,
    precision,
    isOngoing: Boolean(start) && !end,
  };
}

export function formatRange(range: DateRange): string {
  if (!range.start) return 'Date not stated';
  const fmt = (d: Date, p: Precision): string => {
    const iso = d.toISOString();
    if (p === 'YEAR') return iso.slice(0, 4);
    if (p === 'MONTH' || p === 'RANGE_APPROXIMATE') return iso.slice(0, 7);
    return iso.slice(0, 10);
  };
  const start = fmt(range.start, range.precision);
  if (range.isOngoing) return `${start} – present`;
  if (!range.end) return start;
  const end = fmt(range.end, range.precision);
  return start === end ? start : `${start} – ${end}`;
}
