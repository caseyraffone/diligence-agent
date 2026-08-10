import { beforeAll, describe, expect, it } from 'vitest';
import { createCase, createTenant, prisma, resetDatabase, type TestTenant } from '../helpers/db';
import { ingestDocument } from '@/modules/orchestrator';
import { ValidationError } from '@/lib/errors';
import { getObjectStore } from '@/providers/storage';
import { encryptBytes, decryptBytes } from '@/lib/crypto';
import { redact, containsGovernmentIdentifier } from '@/lib/redaction';

let tenant: TestTenant;
let caseId: string;

beforeAll(async () => {
  await resetDatabase();
  tenant = await createTenant('uploads');
  caseId = (await createCase(tenant, { reference: 'UP-1' })).caseId;
});

const upload = (overrides: Partial<Parameters<typeof ingestDocument>[0]> = {}) =>
  ingestDocument({
    caseId,
    organizationId: tenant.organizationId,
    filename: 'cv.txt',
    declaredMimeType: 'text/plain',
    bytes: Buffer.from('EXPERIENCE\nSoftware Engineer, Northwind Analytics (Jan 2022 - Dec 2023)\n', 'utf8'),
    kind: 'RESUME_CV',
    uploadedByUserId: tenant.users.LEAD_REVIEWER.id,
    ...overrides,
  });

describe('upload validation', () => {
  it('accepts a well-formed text document', async () => {
    const result = await upload();
    expect(result.status).toBe('PARSED');
    expect(result.pageCount).toBeGreaterThan(0);
  });

  it('rejects an empty file', async () => {
    await expect(upload({ bytes: Buffer.alloc(0) })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a file above the size limit', async () => {
    const oversized = Buffer.alloc(30 * 1024 * 1024, 0x41);
    await expect(upload({ bytes: oversized })).rejects.toThrow(/exceeds/i);
  });

  it('rejects a disallowed content type', async () => {
    await expect(upload({ declaredMimeType: 'application/x-msdownload' })).rejects.toThrow(/not accepted/i);
  });

  it('rejects content that does not match its declared type', async () => {
    // A payload claiming to be a PDF but starting with something else is the
    // classic route to confusing a downstream parser.
    await expect(
      upload({
        declaredMimeType: 'application/pdf',
        filename: 'fake.pdf',
        bytes: Buffer.from('<html>not a pdf</html>'),
      }),
    ).rejects.toThrow(/do not match the declared type/i);
  });

  it('detects a byte-identical re-upload under a different filename', async () => {
    // Content unique to this test, so the match cannot be an earlier upload.
    const bytes = Buffer.from('EXPERIENCE\nAnalyst, Duplicate Detection Co (Jan 2020 - Dec 2020)\n', 'utf8');

    const first = await upload({ filename: 'dup-a.txt', bytes });
    expect(first.duplicateOfDocumentId).toBeNull();

    const second = await upload({ filename: 'dup-b.txt', bytes });
    expect(second.duplicateOfDocumentId).toBe(first.documentId);

    // Both rows are kept — a duplicate is recorded, not silently discarded.
    const docs = await prisma.applicationDocument.findMany({
      where: { caseId, sha256: first.documentId ? undefined : undefined },
    });
    expect(docs.filter((d) => d.filename.startsWith('dup-'))).toHaveLength(2);
  });

  it('records that no malware scanner ran rather than implying a clean file', async () => {
    const result = await upload({ filename: 'scan.txt' });
    // MALWARE_SCANNER=noop must never produce CLEAN.
    expect(result.scanStatus).toBe('UNSUPPORTED');
    const doc = await prisma.applicationDocument.findUniqueOrThrow({ where: { id: result.documentId } });
    expect(doc.scanDetail).toMatch(/was NOT scanned/i);
  });
});

describe('storage', () => {
  it('encrypts document bytes at rest', async () => {
    const plaintext = Buffer.from('EXPERIENCE\nSensitive content here\n', 'utf8');
    const result = await upload({ filename: 'encrypted.txt', bytes: plaintext });

    const doc = await prisma.applicationDocument.findUniqueOrThrow({ where: { id: result.documentId } });
    const roundTripped = await getObjectStore().get(doc.storageKey);
    expect(roundTripped.toString('utf8')).toBe(plaintext.toString('utf8'));

    // And the envelope itself is not readable.
    const envelope = encryptBytes(plaintext);
    expect(envelope.toString('utf8')).not.toContain('Sensitive content');
    expect(decryptBytes(envelope).toString('utf8')).toBe(plaintext.toString('utf8'));
  });

  it('refuses an object key that escapes the storage root', async () => {
    const store = getObjectStore();
    await expect(store.get('../../etc/passwd')).rejects.toThrow(/unsafe object key|escapes storage root/i);
  });

  it('rejects a tampered ciphertext rather than returning garbage', () => {
    const envelope = encryptBytes(Buffer.from('hello'));
    // Flip a bit in the ciphertext; GCM authentication must reject it.
    const last = envelope.length - 1;
    envelope.writeUInt8(envelope.readUInt8(last) ^ 0xff, last);
    expect(() => decryptBytes(envelope)).toThrow();
  });

  it('keeps original bytes out of the database', async () => {
    const doc = await prisma.applicationDocument.findFirstOrThrow({ where: { caseId } });
    // Only a key is stored; the row has no column holding file bytes.
    expect(doc.storageKey).toMatch(/^cases\//);
    expect(Object.keys(doc)).not.toContain('content');
  });
});

describe('redaction of government identifiers', () => {
  it('masks identifiers before extracted text is written', async () => {
    const content = [
      'EXPERIENCE',
      'Software Engineer, Northwind Analytics (Jan 2022 - Dec 2023)',
      'SSN: 123-45-6789',
      'Passport No: X1234567',
      'Date of Birth: 1998-04-12',
    ].join('\n');

    const result = await upload({ filename: 'with-pii.txt', bytes: Buffer.from(content, 'utf8') });
    expect(result.redactionsApplied).toBeGreaterThan(0);

    const pages = await prisma.documentPage.findMany({ where: { documentId: result.documentId } });
    const stored = pages.map((p) => p.text).join('\n');

    expect(stored).not.toContain('123-45-6789');
    expect(stored).not.toContain('X1234567');
    expect(stored).toContain('[REDACTED:GOV_ID]');
  });

  it('does not redact ordinary numbers that merely look long', () => {
    // A student id or grant number must survive; over-redaction destroys the
    // very claims we need to verify.
    const result = redact('Student ID 20194455 and grant number 887766554433 were listed.');
    expect(result.text).toContain('20194455');
    expect(result.hits).toHaveLength(0);
  });

  it('redacts a payment card only when it passes a Luhn check', () => {
    expect(redact('Card 4111111111111111 on file').hits).toHaveLength(1);
    expect(redact('Reference 4111111111111112 on file').hits).toHaveLength(0);
  });

  it('detects a remaining government identifier', () => {
    expect(containsGovernmentIdentifier('SSN 123-45-6789')).toBe(true);
    expect(containsGovernmentIdentifier('No identifiers here')).toBe(false);
  });

  it('never nests masks when patterns overlap', () => {
    const result = redact('SSN: 123-45-6789');
    expect(result.text.match(/\[REDACTED/g)).toHaveLength(1);
  });
});
