import { describe, expect, it } from 'vitest';
import { durationDays, formatRange, parseDateRange, parseDateToken, rangeOverlap, toRange } from '@/lib/dates';

describe('date parsing', () => {
  it('parses ISO dates at each precision', () => {
    expect(parseDateToken('2023-05-14')?.precision).toBe('DAY');
    expect(parseDateToken('2023-05')?.precision).toBe('MONTH');
    expect(parseDateToken('2023')?.precision).toBe('YEAR');
  });

  it('sets an upper bound consistent with the stated precision', () => {
    const year = parseDateToken('2023')!;
    expect(year.date.toISOString().slice(0, 10)).toBe('2023-01-01');
    expect(year.upperBound.toISOString().slice(0, 10)).toBe('2023-12-31');

    const month = parseDateToken('2023-02')!;
    expect(month.upperBound.toISOString().slice(0, 10)).toBe('2023-02-28');
  });

  it('parses month-name and day-first forms', () => {
    expect(parseDateToken('May 2023')?.date.toISOString().slice(0, 7)).toBe('2023-05');
    expect(parseDateToken('14 May 2023')?.date.toISOString().slice(0, 10)).toBe('2023-05-14');
    expect(parseDateToken('Sept 2021')?.date.toISOString().slice(0, 7)).toBe('2021-09');
  });

  it('treats a season as approximate rather than precise', () => {
    const summer = parseDateToken('Summer 2021')!;
    expect(summer.precision).toBe('RANGE_APPROXIMATE');
    expect(summer.date.toISOString().slice(0, 7)).toBe('2021-06');
  });

  it('returns null for unparseable text instead of guessing', () => {
    expect(parseDateToken('sometime recently')).toBeNull();
    expect(parseDateToken('')).toBeNull();
  });

  it('distinguishes an ongoing range from an unknown end', () => {
    const ongoing = parseDateRange('Jan 2022 - Present');
    expect(ongoing.isOngoing).toBe(true);
    expect(ongoing.start?.toISOString().slice(0, 7)).toBe('2022-01');

    const closed = parseDateRange('2019 - 2023');
    expect(closed.isOngoing).toBe(false);
    expect(closed.end?.toISOString().slice(0, 4)).toBe('2023');
  });
});

describe('overlap detection', () => {
  const asOf = new Date('2026-01-01T00:00:00Z');

  it('detects a genuine multi-month overlap between day-precise ranges', () => {
    const a = toRange(new Date('2022-01-01'), new Date('2022-12-31'), 'DAY');
    const b = toRange(new Date('2022-06-01'), new Date('2023-06-30'), 'DAY');
    const result = rangeOverlap(a, b, asOf);
    expect(result.overlaps).toBe(true);
    expect(result.days).toBeGreaterThan(200);
    expect(result.ambiguousDueToPrecision).toBe(false);
  });

  it('reports no overlap for adjacent ranges', () => {
    const a = toRange(new Date('2022-01-01'), new Date('2022-05-31'), 'DAY');
    const b = toRange(new Date('2022-06-01'), new Date('2022-12-31'), 'DAY');
    expect(rangeOverlap(a, b, asOf).overlaps).toBe(false);
  });

  it('marks a short overlap between coarse ranges as ambiguous, not conflicting', () => {
    // Two month-precision ranges that touch at a boundary tell us nothing about
    // the actual days worked. Flagging this would be a false positive.
    const a = toRange(new Date('2022-01-01'), new Date('2022-06-30T23:59:59Z'), 'MONTH');
    const b = toRange(new Date('2022-06-01'), new Date('2022-12-31T23:59:59Z'), 'MONTH');
    const result = rangeOverlap(a, b, asOf);
    expect(result.overlaps).toBe(true);
    expect(result.ambiguousDueToPrecision).toBe(true);
  });

  it('treats a missing start date as ambiguous rather than as no overlap', () => {
    const a = toRange(null, null, 'UNKNOWN');
    const b = toRange(new Date('2022-01-01'), new Date('2022-12-31'), 'DAY');
    const result = rangeOverlap(a, b, asOf);
    expect(result.overlaps).toBe(false);
    expect(result.ambiguousDueToPrecision).toBe(true);
  });

  it('extends an ongoing range to the evaluation date', () => {
    const ongoing = toRange(new Date('2024-01-01'), null, 'MONTH');
    const other = toRange(new Date('2025-01-01'), new Date('2025-12-31'), 'DAY');
    expect(rangeOverlap(ongoing, other, asOf).overlaps).toBe(true);
  });
});

describe('durations and formatting', () => {
  it('computes inclusive day counts', () => {
    const range = toRange(new Date('2022-01-01'), new Date('2022-01-31'), 'DAY');
    expect(durationDays(range, new Date('2026-01-01'))).toBe(30);
  });

  it('returns null for an unbounded range', () => {
    expect(durationDays(toRange(null, null, 'UNKNOWN'))).toBeNull();
  });

  it('formats at the precision that was actually stated', () => {
    expect(formatRange(toRange(new Date('2022-01-01'), new Date('2022-12-31'), 'YEAR'))).toBe('2022');
    expect(formatRange(toRange(new Date('2022-03-01'), null, 'MONTH'))).toBe('2022-03 – present');
    expect(formatRange(toRange(null, null, 'UNKNOWN'))).toBe('Date not stated');
  });
});
