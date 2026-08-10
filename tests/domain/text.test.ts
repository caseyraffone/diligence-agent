import { describe, expect, it } from 'vitest';
import { comparePersonNames, extractDoi, extractOrcid, organizationsMatch, similarity, titlesMatch } from '@/lib/text';

/**
 * These are the adversarial name/organisation fixtures. Each one is a shape
 * that would produce a false accusation if matching were naive.
 */
describe('organisation matching', () => {
  it('matches an organisation that renamed itself', () => {
    expect(organizationsMatch('Facebook, Inc.', 'Meta Platforms')).toBe(true);
    expect(organizationsMatch('Twitter', 'X Corp')).toBe(true);
  });

  it('matches a local-language name against its English form', () => {
    expect(organizationsMatch('Universidad Nacional Autónoma de México', 'UNAM')).toBe(true);
    expect(organizationsMatch('Eidgenössische Technische Hochschule Zürich', 'ETH Zurich')).toBe(true);
  });

  it('matches an acronym against the full institution name', () => {
    expect(organizationsMatch('MIT', 'Massachusetts Institute of Technology')).toBe(true);
  });

  it('matches a division against its parent', () => {
    expect(organizationsMatch('Google', 'Google Research')).toBe(true);
  });

  it('ignores legal-form suffixes and punctuation', () => {
    expect(organizationsMatch('Northwind Analytics, Inc.', 'Northwind Analytics LLC')).toBe(true);
  });

  it('still distinguishes genuinely different organisations', () => {
    expect(organizationsMatch('Riverton State University', 'Riverside Technical College')).toBe(false);
    expect(organizationsMatch('Aurora Robotics Lab', 'Helios Robotics')).toBe(false);
  });
});

describe('title matching', () => {
  it('treats known synonyms as the same role', () => {
    expect(titlesMatch('Software Engineer', 'Software Developer')).toBe(true);
    expect(titlesMatch('Co-Founder', 'Cofounder')).toBe(true);
    expect(titlesMatch('Sr Software Engineer', 'Senior Software Engineer')).toBe(true);
  });

  it('distinguishes a seniority change that is worth asking about', () => {
    expect(titlesMatch('Senior Software Engineer', 'Software Engineer')).toBe(false);
  });
});

describe('person name comparison', () => {
  it('matches an exact normalized name', () => {
    const result = comparePersonNames('Amara Okonkwo', 'amara  okonkwo');
    expect(result.match).toBe(true);
    expect(result.ambiguous).toBe(false);
  });

  it('treats an initial as a possible but ambiguous match', () => {
    // "J. Smith" is the archetypal false-positive generator. It must never be
    // reported as a confirmed identity match.
    const result = comparePersonNames('J. Smith', 'Jane Smith');
    expect(result.match).toBe(true);
    expect(result.ambiguous).toBe(true);
    expect(result.reason).toMatch(/several people may share this form/i);
  });

  it('does not match on differing family names', () => {
    const result = comparePersonNames('Jane Smith', 'Jane Okonkwo');
    expect(result.match).toBe(false);
    expect(result.ambiguous).toBe(false);
  });

  it('flags differing given names as ambiguous rather than a clean mismatch', () => {
    // A name change, a middle name used as a first name, or a transliteration
    // all land here. Reporting it as "not the same person" would be wrong.
    const result = comparePersonNames('Priya Raman', 'Lakshmi Raman');
    expect(result.match).toBe(false);
    expect(result.ambiguous).toBe(true);
  });

  it('handles diacritics as equivalent', () => {
    expect(comparePersonNames('José Álvarez', 'Jose Alvarez').match).toBe(true);
  });
});

describe('identifier extraction', () => {
  it('extracts a DOI from a citation', () => {
    expect(extractDoi('Journal of Things, 2024. doi:10.5281/zenodo.7654321')).toBe('10.5281/zenodo.7654321');
  });

  it('returns null when there is no DOI', () => {
    expect(extractDoi('Presented at a workshop, 2024.')).toBeNull();
  });

  it('extracts an ORCID iD including a check digit of X', () => {
    expect(extractOrcid('ORCID: 0000-0002-1825-009X')).toBe('0000-0002-1825-009X');
  });
});

describe('similarity', () => {
  it('is 1 for identical strings and 0 for an empty comparison', () => {
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('', 'abc')).toBe(0);
  });
});
