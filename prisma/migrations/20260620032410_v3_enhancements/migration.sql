-- AlterTable
ALTER TABLE "RuleCheckResult" ADD COLUMN "ruleSnapshot" TEXT;

-- CreateTable
CREATE TABLE "RuleConfigChangeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleConfigId" TEXT NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "reportType" TEXT,
    "fieldName" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "changedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RuleConfigChangeLog_ruleConfigId_fkey" FOREIGN KEY ("ruleConfigId") REFERENCES "RuleConfig" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RuleConfigChangeLog_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RuleConfigChangeLog_ruleConfigId_idx" ON "RuleConfigChangeLog"("ruleConfigId");

-- CreateIndex
CREATE INDEX "RuleConfigChangeLog_ruleCode_reportType_idx" ON "RuleConfigChangeLog"("ruleCode", "reportType");

-- CreateIndex
CREATE INDEX "RuleConfigChangeLog_changedById_idx" ON "RuleConfigChangeLog"("changedById");
