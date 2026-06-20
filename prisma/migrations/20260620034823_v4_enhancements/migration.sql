-- CreateTable
CREATE TABLE "RuleRerunBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchNo" TEXT NOT NULL,
    "triggeredById" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL DEFAULT 'MANUAL',
    "ruleSnapshot" TEXT,
    "reportIds" TEXT,
    "affectedCount" INTEGER NOT NULL DEFAULT 0,
    "newIssueCount" INTEGER NOT NULL DEFAULT 0,
    "removedCount" INTEGER NOT NULL DEFAULT 0,
    "changedCount" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RuleRerunBatch_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AuditTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL,
    "taskDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "assignedToId" TEXT,
    "assignedById" TEXT,
    "assignedAt" DATETIME,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "rectifiedAt" DATETIME,
    "lastRemindedAt" DATETIME,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditTask_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AuditTask_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditTask_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AuditTask" ("assignedAt", "assignedById", "assignedToId", "completedAt", "createdAt", "id", "priority", "rectifiedAt", "reportId", "startedAt", "status", "taskDate", "updatedAt") SELECT "assignedAt", "assignedById", "assignedToId", "completedAt", "createdAt", "id", "priority", "rectifiedAt", "reportId", "startedAt", "status", "taskDate", "updatedAt" FROM "AuditTask";
DROP TABLE "AuditTask";
ALTER TABLE "new_AuditTask" RENAME TO "AuditTask";
CREATE TABLE "new_RuleCheckResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "ruleName" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "message" TEXT NOT NULL,
    "fieldName" TEXT,
    "suggestion" TEXT,
    "ruleSnapshot" TEXT,
    "batchId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RuleCheckResult_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RuleCheckResult_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RuleRerunBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_RuleCheckResult" ("createdAt", "fieldName", "id", "message", "passed", "reportId", "ruleCode", "ruleName", "ruleSnapshot", "severity", "suggestion") SELECT "createdAt", "fieldName", "id", "message", "passed", "reportId", "ruleCode", "ruleName", "ruleSnapshot", "severity", "suggestion" FROM "RuleCheckResult";
DROP TABLE "RuleCheckResult";
ALTER TABLE "new_RuleCheckResult" RENAME TO "RuleCheckResult";
CREATE INDEX "RuleCheckResult_batchId_idx" ON "RuleCheckResult"("batchId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "RuleRerunBatch_batchNo_key" ON "RuleRerunBatch"("batchNo");

-- CreateIndex
CREATE INDEX "RuleRerunBatch_triggeredById_idx" ON "RuleRerunBatch"("triggeredById");

-- CreateIndex
CREATE INDEX "RuleRerunBatch_createdAt_idx" ON "RuleRerunBatch"("createdAt");
