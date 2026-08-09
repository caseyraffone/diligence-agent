-- CreateEnum
CREATE TYPE "UseCase" AS ENUM ('UNIVERSITY_APPLICATION', 'JOB_APPLICATION', 'SCHOLARSHIP_FELLOWSHIP', 'PROFESSIONAL_LICENSING', 'GRANT', 'VENDOR_FOUNDER_DILIGENCE');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('INTAKE', 'AWAITING_CONSENT', 'IN_VERIFICATION', 'AWAITING_APPLICANT', 'READY_FOR_REVIEW', 'CLOSED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'CORROBORATED', 'PARTIALLY_CORROBORATED', 'UNABLE_TO_VERIFY', 'CONFLICTING_INFORMATION', 'APPLICANT_CLARIFICATION_REQUESTED', 'HUMAN_REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "ClaimCategory" AS ENUM ('EDUCATION_ENROLLMENT', 'DEGREE_AWARD', 'EMPLOYMENT', 'AWARD_COMPETITION', 'RESEARCH_POSITION', 'PUBLICATION', 'ATHLETIC_PARTICIPATION', 'CERTIFICATION_LICENSE', 'VOLUNTEER_LEADERSHIP', 'PROJECT_VENTURE_PATENT', 'QUANTITATIVE_METRIC', 'OTHER');

-- CreateEnum
CREATE TYPE "DatePrecision" AS ENUM ('DAY', 'MONTH', 'YEAR', 'RANGE_APPROXIMATE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('APPLICATION', 'RESUME_CV', 'TRANSCRIPT', 'AWARD_CERTIFICATE', 'RECOMMENDATION_LETTER', 'PUBLICATION', 'PORTFOLIO', 'SUPPORTING_EVIDENCE', 'APPLICANT_CLARIFICATION_UPLOAD', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADED', 'SCANNING', 'SCAN_FAILED', 'QUARANTINED', 'PARSING', 'PARSED', 'PARSE_FAILED', 'DELETED_BY_RETENTION');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'UNSUPPORTED', 'ERROR');

-- CreateEnum
CREATE TYPE "AuthorityLevel" AS ENUM ('L1_ISSUING_AUTHORITY', 'L2_OFFICIAL_WEBSITE', 'L3_AUTHORIZED_REPRESENTATIVE', 'L4_SIGNED_VERIFIABLE_RECORD', 'L5_INDEPENDENT_REPORTING', 'L6_APPLICANT_PROVIDED', 'L7_INFORMAL_SELF_PUBLISHED');

-- CreateEnum
CREATE TYPE "EvidenceRelation" AS ENUM ('SUPPORTING', 'CONFLICTING', 'NEUTRAL');

-- CreateEnum
CREATE TYPE "StatementType" AS ENUM ('CONFIRMED_FACT', 'APPLICANT_STATEMENT', 'THIRD_PARTY_STATEMENT', 'SYSTEM_OBSERVATION', 'INFERENCE', 'UNRESOLVED_DISCREPANCY');

-- CreateEnum
CREATE TYPE "SourceCheckResult" AS ENUM ('MATCH', 'PARTIAL_MATCH', 'NO_MATCH', 'RECORD_NOT_FOUND', 'SOURCE_UNAVAILABLE', 'INCONCLUSIVE', 'ERROR');

-- CreateEnum
CREATE TYPE "DiscrepancyKind" AS ENUM ('CONFLICTING_DATES', 'OVERLAPPING_FULL_TIME_COMMITMENT', 'TITLE_MISMATCH', 'ORGANIZATION_NAME_MISMATCH', 'AWARD_LEVEL_INCONSISTENCY', 'RANKING_MISMATCH', 'PUBLICATION_AUTHORSHIP_DISCREPANCY', 'UNSUPPORTED_BY_RECOMMENDATION', 'RESEARCH_DESCRIPTION_DIVERGENCE', 'ARITHMETIC_INCONSISTENCY', 'DUPLICATE_DOCUMENT', 'DOCUMENT_ANOMALY', 'CLAIM_SOURCE_CONFLICT');

-- CreateEnum
CREATE TYPE "DiscrepancySeverity" AS ENUM ('INFORMATIONAL', 'REVIEW_SUGGESTED', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "DiscrepancyStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'EXPLAINED', 'RESOLVED', 'DISMISSED_NOT_AN_ISSUE');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('PARSE_DOCUMENT', 'EXTRACT_CLAIMS', 'PLAN_VERIFICATION', 'RUN_SOURCE_CHECK', 'ANALYZE_CONSISTENCY', 'GENERATE_INTERVIEW_QUESTIONS', 'RECOMPUTE_CASE_SUMMARY', 'APPLY_RETENTION');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED_AWAITING_CONSENT');

-- CreateEnum
CREATE TYPE "OutreachStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED_FOR_SENDING', 'SENT_RECORDED_MANUALLY', 'DECLINED_BY_REVIEWER', 'RESPONSE_RECEIVED', 'NO_RESPONSE');

-- CreateEnum
CREATE TYPE "ClarificationStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'RESPONDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TipStatus" AS ENUM ('RECEIVED', 'DUPLICATE_SUPPRESSED', 'UNDER_REVIEW', 'CORROBORATION_REQUIRED', 'INDEPENDENTLY_CORROBORATED', 'CLOSED_UNSUBSTANTIATED', 'CLOSED_OUT_OF_SCOPE');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'APPLICANT', 'ANONYMOUS');

-- CreateEnum
CREATE TYPE "ConsentScope" AS ENUM ('INTERNAL_REVIEW_ONLY', 'EXTERNAL_PUBLIC_SOURCES', 'ISSUING_ORGANIZATION_OUTREACH', 'REFERENCE_OUTREACH');

-- CreateEnum
CREATE TYPE "RetentionAction" AS ENUM ('DELETE_ORIGINAL_DOCUMENTS', 'ANONYMIZE_APPLICANT', 'DELETE_CASE');

-- CreateEnum
CREATE TYPE "ExtractionOrigin" AS ENUM ('MODEL', 'HUMAN', 'MODEL_EDITED_BY_HUMAN');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settings" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "permissions" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfSecret" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "userAgentHash" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "useCase" "UseCase" NOT NULL,
    "description" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "relevantClaimCategories" "ClaimCategory"[],
    "approvedSourceKeys" TEXT[],
    "evidenceRequirements" JSONB NOT NULL DEFAULT '{}',
    "retentionDays" INTEGER NOT NULL DEFAULT 365,
    "escalationRules" JSONB NOT NULL DEFAULT '{}',
    "reportLanguage" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Applicant" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "externalRef" TEXT,
    "contactEmail" TEXT,
    "anonymizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Applicant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "policyTemplateId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'INTAKE',
    "priorityScore" INTEGER NOT NULL DEFAULT 0,
    "dueDate" TIMESTAMP(3),
    "assignedReviewerId" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "scope" "ConsentScope" NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "grantedVia" TEXT NOT NULL,
    "documentRef" TEXT,
    "revokedAt" TIMESTAMP(3),
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationDocument" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "scanStatus" "ScanStatus" NOT NULL DEFAULT 'PENDING',
    "scanDetail" TEXT,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT,
    "uploadedVia" "ActorType" NOT NULL DEFAULT 'USER',
    "integritySignals" JSONB NOT NULL DEFAULT '[]',
    "originalDeletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentPage" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DocumentPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractedClaim" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "sourcePassage" TEXT NOT NULL,
    "normalizedText" TEXT NOT NULL,
    "category" "ClaimCategory" NOT NULL,
    "personName" TEXT,
    "organizationName" TEXT,
    "title" TEXT,
    "location" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "datePrecision" "DatePrecision" NOT NULL DEFAULT 'UNKNOWN',
    "amountValue" DECIMAL(20,4),
    "amountUnit" TEXT,
    "isObjectivelyVerifiable" BOOLEAN NOT NULL DEFAULT true,
    "suggestedSourceKey" TEXT,
    "status" "ClaimStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "extractionConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "origin" "ExtractionOrigin" NOT NULL DEFAULT 'MODEL',
    "isFullTimeCommitment" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractedClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimRevision" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "userId" TEXT,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "relation" "EvidenceRelation" NOT NULL,
    "statementType" "StatementType" NOT NULL,
    "authorityLevel" "AuthorityLevel" NOT NULL,
    "summary" TEXT NOT NULL,
    "detail" TEXT,
    "sourceCheckId" TEXT,
    "documentId" TEXT,
    "outreachResponseId" TEXT,
    "clarificationResponseId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceCheck" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "adapterKey" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "url" TEXT,
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "excerpt" TEXT,
    "authorityLevel" "AuthorityLevel" NOT NULL,
    "result" "SourceCheckResult" NOT NULL,
    "detail" TEXT,
    "rawResponseKey" TEXT,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "isLive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Discrepancy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" "DiscrepancyKind" NOT NULL,
    "severity" "DiscrepancySeverity" NOT NULL,
    "status" "DiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "claimIds" TEXT[],
    "documentIds" TEXT[],
    "ruleKey" TEXT NOT NULL,
    "detectedBy" "ActorType" NOT NULL DEFAULT 'SYSTEM',
    "resolutionNote" TEXT,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Discrepancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationTask" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "claimId" TEXT,
    "type" "TaskType" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "claimId" TEXT,
    "recipientOrgName" TEXT NOT NULL,
    "recipientEmail" TEXT,
    "recipientNote" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "OutreachStatus" NOT NULL DEFAULT 'DRAFT',
    "requiredConsent" "ConsentScope" NOT NULL DEFAULT 'ISSUING_ORGANIZATION_OUTREACH',
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sentRecordedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachResponse" (
    "id" TEXT NOT NULL,
    "outreachRequestId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "respondentName" TEXT NOT NULL,
    "respondentRole" TEXT,
    "content" TEXT NOT NULL,
    "authorityLevel" "AuthorityLevel" NOT NULL DEFAULT 'L3_AUTHORIZED_REPRESENTATIVE',
    "isConfidential" BOOLEAN NOT NULL DEFAULT true,
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClarificationRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "claimId" TEXT,
    "discrepancyId" TEXT,
    "status" "ClarificationStatus" NOT NULL DEFAULT 'DRAFT',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "acceptableEvidence" TEXT[],
    "dueDate" TIMESTAMP(3),
    "tokenHash" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sentRecordedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClarificationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClarificationResponse" (
    "id" TEXT NOT NULL,
    "clarificationRequestId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "message" TEXT NOT NULL,
    "documentIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClarificationResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Interview" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "claimId" TEXT,
    "topic" TEXT NOT NULL,
    "questions" JSONB NOT NULL DEFAULT '[]',
    "scorecard" JSONB NOT NULL DEFAULT '[]',
    "conclusion" TEXT,
    "humanReviewed" BOOLEAN NOT NULL DEFAULT false,
    "conductedByUserId" TEXT,
    "conductedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Interview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewerDecision" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "claimId" TEXT,
    "previousStatus" "ClaimStatus",
    "newStatus" "ClaimStatus" NOT NULL,
    "rationale" TEXT NOT NULL,
    "evidenceItemIds" TEXT[],
    "decidedByUserId" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversesDecisionId" TEXT,
    "isReversal" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ReviewerDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewerNote" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewerNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnonymousTip" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "allegationText" TEXT NOT NULL,
    "claimedEvidence" TEXT,
    "contentHash" TEXT NOT NULL,
    "submissionFingerprint" TEXT,
    "status" "TipStatus" NOT NULL DEFAULT 'RECEIVED',
    "duplicateOfId" TEXT,
    "reviewNote" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "AnonymousTip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT,
    "actorType" "ActorType" NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sequence" INTEGER NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetentionRule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "policyTemplateId" TEXT,
    "name" TEXT NOT NULL,
    "action" "RetentionAction" NOT NULL,
    "afterDaysFromClosure" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetentionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitCounter" (
    "id" TEXT NOT NULL,
    "bucketKey" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowEndsAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Role_key_key" ON "Role"("key");

-- CreateIndex
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "User_organizationId_email_key" ON "User"("organizationId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "PolicyTemplate_useCase_idx" ON "PolicyTemplate"("useCase");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyTemplate_organizationId_key_version_key" ON "PolicyTemplate"("organizationId", "key", "version");

-- CreateIndex
CREATE INDEX "Applicant_organizationId_idx" ON "Applicant"("organizationId");

-- CreateIndex
CREATE INDEX "Case_organizationId_status_idx" ON "Case"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Case_organizationId_reference_key" ON "Case"("organizationId", "reference");

-- CreateIndex
CREATE INDEX "ConsentRecord_caseId_scope_idx" ON "ConsentRecord"("caseId", "scope");

-- CreateIndex
CREATE INDEX "ApplicationDocument_caseId_idx" ON "ApplicationDocument"("caseId");

-- CreateIndex
CREATE INDEX "ApplicationDocument_organizationId_sha256_idx" ON "ApplicationDocument"("organizationId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentPage_documentId_pageNumber_key" ON "DocumentPage"("documentId", "pageNumber");

-- CreateIndex
CREATE INDEX "ExtractedClaim_caseId_status_idx" ON "ExtractedClaim"("caseId", "status");

-- CreateIndex
CREATE INDEX "ExtractedClaim_caseId_category_idx" ON "ExtractedClaim"("caseId", "category");

-- CreateIndex
CREATE INDEX "ClaimRevision_claimId_idx" ON "ClaimRevision"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceItem_sourceCheckId_key" ON "EvidenceItem"("sourceCheckId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceItem_outreachResponseId_key" ON "EvidenceItem"("outreachResponseId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceItem_clarificationResponseId_key" ON "EvidenceItem"("clarificationResponseId");

-- CreateIndex
CREATE INDEX "EvidenceItem_caseId_idx" ON "EvidenceItem"("caseId");

-- CreateIndex
CREATE INDEX "EvidenceItem_claimId_relation_idx" ON "EvidenceItem"("claimId", "relation");

-- CreateIndex
CREATE INDEX "SourceCheck_caseId_idx" ON "SourceCheck"("caseId");

-- CreateIndex
CREATE INDEX "SourceCheck_claimId_idx" ON "SourceCheck"("claimId");

-- CreateIndex
CREATE INDEX "Discrepancy_caseId_status_idx" ON "Discrepancy"("caseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Discrepancy_caseId_ruleKey_key" ON "Discrepancy"("caseId", "ruleKey");

-- CreateIndex
CREATE INDEX "VerificationTask_status_runAfter_idx" ON "VerificationTask"("status", "runAfter");

-- CreateIndex
CREATE INDEX "VerificationTask_caseId_idx" ON "VerificationTask"("caseId");

-- CreateIndex
CREATE INDEX "OutreachRequest_caseId_status_idx" ON "OutreachRequest"("caseId", "status");

-- CreateIndex
CREATE INDEX "OutreachResponse_outreachRequestId_idx" ON "OutreachResponse"("outreachRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "ClarificationRequest_tokenHash_key" ON "ClarificationRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "ClarificationRequest_caseId_status_idx" ON "ClarificationRequest"("caseId", "status");

-- CreateIndex
CREATE INDEX "ClarificationResponse_clarificationRequestId_idx" ON "ClarificationResponse"("clarificationRequestId");

-- CreateIndex
CREATE INDEX "Interview_caseId_idx" ON "Interview"("caseId");

-- CreateIndex
CREATE INDEX "ReviewerDecision_caseId_idx" ON "ReviewerDecision"("caseId");

-- CreateIndex
CREATE INDEX "ReviewerDecision_claimId_idx" ON "ReviewerDecision"("claimId");

-- CreateIndex
CREATE INDEX "ReviewerNote_caseId_idx" ON "ReviewerNote"("caseId");

-- CreateIndex
CREATE INDEX "AnonymousTip_organizationId_status_idx" ON "AnonymousTip"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AnonymousTip_organizationId_contentHash_key" ON "AnonymousTip"("organizationId", "contentHash");

-- CreateIndex
CREATE INDEX "AuditEvent_caseId_createdAt_idx" ON "AuditEvent"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_action_idx" ON "AuditEvent"("organizationId", "action");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_organizationId_sequence_key" ON "AuditEvent"("organizationId", "sequence");

-- CreateIndex
CREATE INDEX "RetentionRule_organizationId_idx" ON "RetentionRule"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimitCounter_bucketKey_key" ON "RateLimitCounter"("bucketKey");

-- CreateIndex
CREATE INDEX "RateLimitCounter_windowEndsAt_idx" ON "RateLimitCounter"("windowEndsAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyTemplate" ADD CONSTRAINT "PolicyTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Applicant" ADD CONSTRAINT "Applicant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_policyTemplateId_fkey" FOREIGN KEY ("policyTemplateId") REFERENCES "PolicyTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_assignedReviewerId_fkey" FOREIGN KEY ("assignedReviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationDocument" ADD CONSTRAINT "ApplicationDocument_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationDocument" ADD CONSTRAINT "ApplicationDocument_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentPage" ADD CONSTRAINT "DocumentPage_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ApplicationDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedClaim" ADD CONSTRAINT "ExtractedClaim_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedClaim" ADD CONSTRAINT "ExtractedClaim_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ApplicationDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimRevision" ADD CONSTRAINT "ClaimRevision_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ExtractedClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimRevision" ADD CONSTRAINT "ClaimRevision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ExtractedClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_sourceCheckId_fkey" FOREIGN KEY ("sourceCheckId") REFERENCES "SourceCheck"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ApplicationDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_outreachResponseId_fkey" FOREIGN KEY ("outreachResponseId") REFERENCES "OutreachResponse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_clarificationResponseId_fkey" FOREIGN KEY ("clarificationResponseId") REFERENCES "ClarificationResponse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceCheck" ADD CONSTRAINT "SourceCheck_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceCheck" ADD CONSTRAINT "SourceCheck_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ExtractedClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Discrepancy" ADD CONSTRAINT "Discrepancy_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Discrepancy" ADD CONSTRAINT "Discrepancy_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationTask" ADD CONSTRAINT "VerificationTask_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationTask" ADD CONSTRAINT "VerificationTask_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ExtractedClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachRequest" ADD CONSTRAINT "OutreachRequest_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachRequest" ADD CONSTRAINT "OutreachRequest_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ExtractedClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachRequest" ADD CONSTRAINT "OutreachRequest_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachResponse" ADD CONSTRAINT "OutreachResponse_outreachRequestId_fkey" FOREIGN KEY ("outreachRequestId") REFERENCES "OutreachRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachResponse" ADD CONSTRAINT "OutreachResponse_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClarificationRequest" ADD CONSTRAINT "ClarificationRequest_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClarificationRequest" ADD CONSTRAINT "ClarificationRequest_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ExtractedClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClarificationRequest" ADD CONSTRAINT "ClarificationRequest_discrepancyId_fkey" FOREIGN KEY ("discrepancyId") REFERENCES "Discrepancy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClarificationRequest" ADD CONSTRAINT "ClarificationRequest_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClarificationResponse" ADD CONSTRAINT "ClarificationResponse_clarificationRequestId_fkey" FOREIGN KEY ("clarificationRequestId") REFERENCES "ClarificationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ExtractedClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_conductedByUserId_fkey" FOREIGN KEY ("conductedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewerDecision" ADD CONSTRAINT "ReviewerDecision_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewerDecision" ADD CONSTRAINT "ReviewerDecision_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ExtractedClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewerDecision" ADD CONSTRAINT "ReviewerDecision_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewerNote" ADD CONSTRAINT "ReviewerNote_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewerNote" ADD CONSTRAINT "ReviewerNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnonymousTip" ADD CONSTRAINT "AnonymousTip_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnonymousTip" ADD CONSTRAINT "AnonymousTip_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetentionRule" ADD CONSTRAINT "RetentionRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetentionRule" ADD CONSTRAINT "RetentionRule_policyTemplateId_fkey" FOREIGN KEY ("policyTemplateId") REFERENCES "PolicyTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
