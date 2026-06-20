-- AlterTable
ALTER TABLE "AuditFeedback" ADD COLUMN "newValue" TEXT;
ALTER TABLE "AuditFeedback" ADD COLUMN "resolvedAction" TEXT;
ALTER TABLE "AuditFeedback" ADD COLUMN "resolvedBy" TEXT;
ALTER TABLE "AuditFeedback" ADD COLUMN "resolvedNote" TEXT;

-- CreateTable
CREATE TABLE "RuleConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleCode" TEXT NOT NULL,
    "ruleName" TEXT NOT NULL,
    "reportType" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "severity" TEXT NOT NULL DEFAULT 'WARNING',
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RuleConfig_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SamplingRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "totalReports" INTEGER NOT NULL DEFAULT 0,
    "createdTasks" INTEGER NOT NULL DEFAULT 0,
    "skippedTasks" INTEGER NOT NULL DEFAULT 0,
    "triggeredById" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SamplingRun_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SamplingRunItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "reportNo" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "submitterId" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "matchedRuleId" TEXT,
    "matchedRuleName" TEXT,
    "samplingRate" REAL NOT NULL DEFAULT 0,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "existingTask" BOOLEAN NOT NULL DEFAULT false,
    "assignedToId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SamplingRunItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SamplingRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "RuleConfig_ruleCode_reportType_key" ON "RuleConfig"("ruleCode", "reportType");

-- CreateIndex
CREATE INDEX "SamplingRunItemRunIdSelectedIdx" ON "SamplingRunItem"("runId", "selected");
