-- CreateEnum
CREATE TYPE "TaskJustificationReason" AS ENUM ('LINEAR_ERROR', 'DEPENDENCY', 'OTHER');

-- CreateTable
CREATE TABLE "TaskJustification" (
    "issueId" TEXT NOT NULL,
    "reason" "TaskJustificationReason" NOT NULL,
    "explanation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskJustification_pkey" PRIMARY KEY ("issueId")
);

