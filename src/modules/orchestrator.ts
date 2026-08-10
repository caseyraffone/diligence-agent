import { DocumentKind, DocumentStatus, Prisma, TaskStatus, TaskType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recordAudit } from '@/lib/audit/audit';
import { sha256 } from '@/lib/crypto';
import { redact } from '@/lib/redaction';
import { ValidationError } from '@/lib/errors';
import { getEnv } from '@/lib/env';
import { getObjectStore } from '@/providers/storage';
import { getMalwareScanner, scanPermitsProcessing } from '@/providers/malware';
import { processDocument } from '@/providers/documents';

/**
 * ORCHESTRATING AGENT
 *
 * Coordinates the four specialists. It owns intake and enqueues work; it does
 * not itself decide anything.
 *
 * Pipeline for an uploaded document:
 *   validate → scan → store (encrypted) → extract text → redact → persist pages
 *   → enqueue EXTRACT_CLAIMS → enqueue ANALYZE_CONSISTENCY
 *
 * Redaction happens before pages are written, so the derived-data store never
 * holds government identifiers even though the encrypted original does.
 */

/** Magic-byte signatures, checked against the declared content type. */
const SIGNATURES: Array<{ mime: string; bytes: number[]; offset: number }> = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46], offset: 0 }, // %PDF
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0 },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff], offset: 0 },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38], offset: 0 },
];

const ALLOWED_MIME = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'image/png',
  'image/jpeg',
  'image/gif',
]);

export interface UploadDocumentInput {
  caseId: string;
  organizationId: string;
  filename: string;
  declaredMimeType: string;
  bytes: Buffer;
  kind: DocumentKind;
  uploadedByUserId: string | null;
  uploadedVia?: 'USER' | 'APPLICANT';
}

export interface UploadDocumentResult {
  documentId: string;
  status: DocumentStatus;
  pageCount: number;
  duplicateOfDocumentId: string | null;
  redactionsApplied: number;
  scanStatus: string;
}

export async function ingestDocument(input: UploadDocumentInput): Promise<UploadDocumentResult> {
  const env = getEnv();

  if (input.bytes.byteLength === 0) throw new ValidationError('The uploaded file is empty.');
  if (input.bytes.byteLength > env.MAX_UPLOAD_BYTES) {
    throw new ValidationError(`File exceeds the ${Math.round(env.MAX_UPLOAD_BYTES / 1_048_576)} MiB limit.`);
  }
  if (!ALLOWED_MIME.has(input.declaredMimeType)) {
    throw new ValidationError(`File type ${input.declaredMimeType} is not accepted.`);
  }

  // A file claiming to be a PDF must actually start with %PDF. This blocks the
  // simplest content-type confusion attacks against downstream processors.
  const expected = SIGNATURES.find((s) => s.mime === input.declaredMimeType);
  if (expected) {
    const actual = Array.from(input.bytes.subarray(expected.offset, expected.offset + expected.bytes.length));
    if (!expected.bytes.every((b, i) => actual[i] === b)) {
      throw new ValidationError(`The file contents do not match the declared type ${input.declaredMimeType}.`);
    }
  }

  const hash = sha256(input.bytes);

  const duplicate = await prisma.applicationDocument.findFirst({
    where: { organizationId: input.organizationId, caseId: input.caseId, sha256: hash },
    select: { id: true },
  });

  const scan = await getMalwareScanner().scan(input.bytes, input.filename);
  if (!scanPermitsProcessing(scan.status)) {
    const quarantined = await prisma.applicationDocument.create({
      data: {
        organizationId: input.organizationId,
        caseId: input.caseId,
        filename: input.filename,
        mimeType: input.declaredMimeType,
        sizeBytes: input.bytes.byteLength,
        sha256: hash,
        storageKey: '',
        kind: input.kind,
        status: DocumentStatus.QUARANTINED,
        scanStatus: scan.status,
        scanDetail: scan.detail,
        uploadedById: input.uploadedByUserId,
        uploadedVia: input.uploadedVia ?? 'USER',
      },
    });

    await recordAudit({
      organizationId: input.organizationId,
      caseId: input.caseId,
      actorType: input.uploadedVia === 'APPLICANT' ? 'APPLICANT' : 'USER',
      actorUserId: input.uploadedByUserId,
      action: 'DOCUMENT_QUARANTINED',
      entityType: 'ApplicationDocument',
      entityId: quarantined.id,
      metadata: { scanStatus: scan.status, scanner: scan.scanner },
    });

    return {
      documentId: quarantined.id,
      status: DocumentStatus.QUARANTINED,
      pageCount: 0,
      duplicateOfDocumentId: duplicate?.id ?? null,
      redactionsApplied: 0,
      scanStatus: scan.status,
    };
  }

  const storageKey = `cases/${input.caseId}/documents/${hash.slice(0, 16)}-${Date.now()}`;
  await getObjectStore().put({ key: storageKey, body: input.bytes, contentType: input.declaredMimeType });

  let processed;
  try {
    processed = await processDocument(input.bytes, input.declaredMimeType, input.filename);
  } catch (e) {
    const failed = await prisma.applicationDocument.create({
      data: {
        organizationId: input.organizationId,
        caseId: input.caseId,
        filename: input.filename,
        mimeType: input.declaredMimeType,
        sizeBytes: input.bytes.byteLength,
        sha256: hash,
        storageKey,
        kind: input.kind,
        status: DocumentStatus.PARSE_FAILED,
        scanStatus: scan.status,
        scanDetail: `${scan.detail} | Parse error: ${e instanceof Error ? e.message : 'unknown'}`,
        uploadedById: input.uploadedByUserId,
        uploadedVia: input.uploadedVia ?? 'USER',
      },
    });
    return {
      documentId: failed.id,
      status: DocumentStatus.PARSE_FAILED,
      pageCount: 0,
      duplicateOfDocumentId: duplicate?.id ?? null,
      redactionsApplied: 0,
      scanStatus: scan.status,
    };
  }

  // Redact BEFORE persisting. The extracted-data store must never receive a
  // government identifier even though the encrypted original still contains it.
  let redactionsApplied = 0;
  const redactedPages = processed.pages.map((page) => {
    const result = redact(page.text);
    redactionsApplied += result.hits.length;
    return { pageNumber: page.pageNumber, text: result.text };
  });

  const document = await prisma.applicationDocument.create({
    data: {
      organizationId: input.organizationId,
      caseId: input.caseId,
      filename: input.filename,
      mimeType: input.declaredMimeType,
      sizeBytes: input.bytes.byteLength,
      sha256: hash,
      storageKey,
      kind: input.kind,
      status: DocumentStatus.PARSED,
      scanStatus: scan.status,
      scanDetail: scan.detail,
      pageCount: redactedPages.length,
      uploadedById: input.uploadedByUserId,
      uploadedVia: input.uploadedVia ?? 'USER',
      integritySignals: [
        { kind: 'FILE_METADATA', values: processed.metadata, processor: processed.processor },
        ...(redactionsApplied > 0
          ? [
              {
                kind: 'REDACTION',
                observation: `${redactionsApplied} sensitive identifier(s) were masked in the extracted text.`,
                whyItMayMatter:
                  'The original file still contains them and is stored encrypted under retention control.',
              },
            ]
          : []),
      ] as Prisma.InputJsonValue,
      pages: { create: redactedPages.map((p) => ({ ...p, charCount: p.text.length })) },
    },
  });

  await prisma.verificationTask.createMany({
    data: [
      {
        organizationId: input.organizationId,
        caseId: input.caseId,
        type: TaskType.EXTRACT_CLAIMS,
        priority: 10,
        payload: { documentId: document.id },
      },
      {
        organizationId: input.organizationId,
        caseId: input.caseId,
        type: TaskType.ANALYZE_CONSISTENCY,
        priority: 50,
        payload: {},
      },
    ],
  });

  await recordAudit({
    organizationId: input.organizationId,
    caseId: input.caseId,
    actorType: input.uploadedVia === 'APPLICANT' ? 'APPLICANT' : 'USER',
    actorUserId: input.uploadedByUserId,
    action: 'DOCUMENT_UPLOADED',
    entityType: 'ApplicationDocument',
    entityId: document.id,
    metadata: {
      filename: input.filename,
      sizeBytes: input.bytes.byteLength,
      pages: redactedPages.length,
      redactionsApplied,
      scanStatus: scan.status,
      duplicateOf: duplicate?.id ?? null,
    },
  });

  return {
    documentId: document.id,
    status: DocumentStatus.PARSED,
    pageCount: redactedPages.length,
    duplicateOfDocumentId: duplicate?.id ?? null,
    redactionsApplied,
    scanStatus: scan.status,
  };
}

/** Queues source checks for every claim, following each claim's plan. */
export async function enqueueVerificationForCase(input: {
  caseId: string;
  organizationId: string;
  actorUserId: string | null;
}): Promise<number> {
  const record = await prisma.case.findFirstOrThrow({
    where: { id: input.caseId, organizationId: input.organizationId },
    include: { policyTemplate: true },
  });

  const claims = await prisma.extractedClaim.findMany({
    where: { caseId: input.caseId, organizationId: input.organizationId, isObjectivelyVerifiable: true },
  });

  const { buildVerificationPlan } = await import('./evidenceVerifier');
  const tasks: Prisma.VerificationTaskCreateManyInput[] = [];

  for (const claim of claims) {
    const plan = buildVerificationPlan(claim, record.policyTemplate.approvedSourceKeys);
    for (const step of plan.steps) {
      tasks.push({
        organizationId: input.organizationId,
        caseId: input.caseId,
        claimId: claim.id,
        type: TaskType.RUN_SOURCE_CHECK,
        priority: 20,
        payload: { adapterKey: step.adapterKey },
      });
    }
  }

  tasks.push({
    organizationId: input.organizationId,
    caseId: input.caseId,
    type: TaskType.ANALYZE_CONSISTENCY,
    priority: 90,
    payload: {},
  });

  if (tasks.length > 0) await prisma.verificationTask.createMany({ data: tasks });

  await recordAudit({
    organizationId: input.organizationId,
    caseId: input.caseId,
    actorType: 'USER',
    actorUserId: input.actorUserId,
    action: 'VERIFICATION_ENQUEUED',
    entityType: 'Case',
    entityId: input.caseId,
    metadata: { tasksCreated: tasks.length, claims: claims.length },
  });

  return tasks.length;
}

export async function pendingTaskCount(caseId: string): Promise<number> {
  return prisma.verificationTask.count({
    where: { caseId, status: { in: [TaskStatus.PENDING, TaskStatus.RUNNING] } },
  });
}
