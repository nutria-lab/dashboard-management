-- AlterTable
ALTER TABLE "Sprint" ADD COLUMN     "endsAt" TIMESTAMP(3),
ADD COLUMN     "startsAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DeliveryRecord" (
    "issueId" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "dueDate" TEXT,
    "studentId" TEXT,
    "studentName" TEXT,
    "sprintId" TEXT,
    "incompleteReason" TEXT,

    CONSTRAINT "DeliveryRecord_pkey" PRIMARY KEY ("issueId")
);

-- CreateTable
CREATE TABLE "LinearSyncState" (
    "teamId" TEXT NOT NULL,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "retryAt" TIMESTAMP(3),
    "lastError" TEXT,
    "bootstrapCursor" TEXT,
    "bootstrapListed" BOOLEAN NOT NULL DEFAULT false,
    "bootstrapComplete" BOOLEAN NOT NULL DEFAULT false,
    "metadataSyncedAt" TIMESTAMP(3),
    "openStateIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "LinearSyncState_pkey" PRIMARY KEY ("teamId")
);

-- CreateTable
CREATE TABLE "LinearTask" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "sprintId" TEXT,
    "assigneeId" TEXT,
    "assigneeName" TEXT,
    "stateId" TEXT NOT NULL,
    "stateName" TEXT NOT NULL,
    "stateType" TEXT NOT NULL,
    "dueDate" TEXT,
    "linearUpdatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "deliveryFrozen" BOOLEAN NOT NULL DEFAULT false,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "detailPending" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinearTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SprintSync" (
    "sprintId" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "SprintSync_pkey" PRIMARY KEY ("sprintId")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "deliveryId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "eventAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("deliveryId")
);

-- CreateIndex
CREATE INDEX "DeliveryRecord_sprintId_idx" ON "DeliveryRecord"("sprintId");

-- CreateIndex
CREATE INDEX "LinearTask_teamId_idx" ON "LinearTask"("teamId");

-- CreateIndex
CREATE INDEX "LinearTask_sprintId_idx" ON "LinearTask"("sprintId");

-- CreateIndex
CREATE INDEX "LinearTask_deliveryFrozen_idx" ON "LinearTask"("deliveryFrozen");

-- CreateIndex
CREATE INDEX "WebhookEvent_teamId_processedAt_idx" ON "WebhookEvent"("teamId", "processedAt");

