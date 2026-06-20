export const UserRole = {
  ADMIN: 'ADMIN',
  QC_MANAGER: 'QC_MANAGER',
  QC_AUDITOR: 'QC_AUDITOR',
  CLINIC_DOCTOR: 'CLINIC_DOCTOR',
  CLINIC_MANAGER: 'CLINIC_MANAGER',
} as const
export type UserRole = (typeof UserRole)[keyof typeof UserRole]

export const ReportType = {
  PANORAMIC_XRAY: 'PANORAMIC_XRAY',
  CBCT: 'CBCT',
} as const
export type ReportType = (typeof ReportType)[keyof typeof ReportType]

export const ReportStatus = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  RULE_CHECK_PASSED: 'RULE_CHECK_PASSED',
  RULE_CHECK_FAILED: 'RULE_CHECK_FAILED',
  PENDING_AUDIT: 'PENDING_AUDIT',
  IN_AUDIT: 'IN_AUDIT',
  AUDIT_APPROVED: 'AUDIT_APPROVED',
  AUDIT_REJECTED: 'AUDIT_REJECTED',
  NEEDS_REVISION: 'NEEDS_REVISION',
  REVISED: 'REVISED',
  RECTIFIED: 'RECTIFIED',
} as const
export type ReportStatus = (typeof ReportStatus)[keyof typeof ReportStatus]

export const TaskStatus = {
  PENDING: 'PENDING',
  ASSIGNED: 'ASSIGNED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  RECTIFIED: 'RECTIFIED',
} as const
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus]

export const IssueCategory = {
  TOOTH_POSITION_FORMAT: 'TOOTH_POSITION_FORMAT',
  EXAM_NAME_MISSING: 'EXAM_NAME_MISSING',
  DIAGNOSIS_INCOMPLETE: 'DIAGNOSIS_INCOMPLETE',
  RECOMMENDATION_MISMATCH: 'RECOMMENDATION_MISMATCH',
  TERMINOLOGY_INCONSISTENT: 'TERMINOLOGY_INCONSISTENT',
  CONCLUSION_TOO_GENERAL: 'CONCLUSION_TOO_GENERAL',
  SUGGESTION_IMAGE_MISMATCH: 'SUGGESTION_IMAGE_MISMATCH',
  OTHER: 'OTHER',
} as const
export type IssueCategory = (typeof IssueCategory)[keyof typeof IssueCategory]

export const RuleSeverity = {
  ERROR: 'ERROR',
  WARNING: 'WARNING',
  INFO: 'INFO',
} as const
export type RuleSeverity = (typeof RuleSeverity)[keyof typeof RuleSeverity]

export const IssueCategoryLabels: Record<IssueCategory, string> = {
  [IssueCategory.TOOTH_POSITION_FORMAT]: '牙位格式问题',
  [IssueCategory.EXAM_NAME_MISSING]: '检查名称缺失',
  [IssueCategory.DIAGNOSIS_INCOMPLETE]: '诊断缺项或不完整',
  [IssueCategory.RECOMMENDATION_MISMATCH]: '建议缺项或不匹配',
  [IssueCategory.TERMINOLOGY_INCONSISTENT]: '术语不统一',
  [IssueCategory.CONCLUSION_TOO_GENERAL]: '结论过于笼统',
  [IssueCategory.SUGGESTION_IMAGE_MISMATCH]: '建议与影像不匹配',
  [IssueCategory.OTHER]: '其他问题',
}
