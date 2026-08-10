-- CreateEnum
CREATE TYPE "EvidenceScope" AS ENUM ('CLAIM', 'ORGANIZATION_CONTEXT');

-- AlterTable
ALTER TABLE "EvidenceItem" ADD COLUMN     "scope" "EvidenceScope" NOT NULL DEFAULT 'CLAIM';
