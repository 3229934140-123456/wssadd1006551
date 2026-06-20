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
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
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

export const RuleCode = {
  EXAM_NAME_REQUIRED: 'EXAM_NAME_REQUIRED',
  EXAM_NAME_STANDARD: 'EXAM_NAME_STANDARD',
  TOOTH_POSITION_FORMAT: 'TOOTH_POSITION_FORMAT',
  DIAGNOSIS_WITH_TOOTH: 'DIAGNOSIS_WITH_TOOTH',
  CONCLUSION_COMPLETENESS: 'CONCLUSION_COMPLETENESS',
  RECOMMENDATION_RELEVANCE: 'RECOMMENDATION_RELEVANCE',
  TERMINOLOGY_CONSISTENCY: 'TERMINOLOGY_CONSISTENCY',
} as const
export type RuleCode = (typeof RuleCode)[keyof typeof RuleCode]

export const RuleDefinitions: Record<RuleCode, { name: string; description: string; defaultSeverity: RuleSeverity }> = {
  [RuleCode.EXAM_NAME_REQUIRED]: {
    name: '检查名称必填',
    description: '报告必须填写检查名称，如"全景片"、"CBCT"等',
    defaultSeverity: RuleSeverity.ERROR,
  },
  [RuleCode.EXAM_NAME_STANDARD]: {
    name: '检查名称规范性',
    description: '检查名称是否为标准化术语',
    defaultSeverity: RuleSeverity.WARNING,
  },
  [RuleCode.TOOTH_POSITION_FORMAT]: {
    name: '牙位写法规范',
    description: '牙位字段需使用FDI两位编号格式，如16、36，逗号分隔',
    defaultSeverity: RuleSeverity.ERROR,
  },
  [RuleCode.DIAGNOSIS_WITH_TOOTH]: {
    name: '诊断需明确牙位',
    description: '出现"炎症/阴影/龋/异常"等模糊描述时必须关联具体牙位',
    defaultSeverity: RuleSeverity.ERROR,
  },
  [RuleCode.CONCLUSION_COMPLETENESS]: {
    name: '结论完整性',
    description: '诊断结论应明确，避免"有问题/请结合临床/随诊"等笼统表述',
    defaultSeverity: RuleSeverity.WARNING,
  },
  [RuleCode.RECOMMENDATION_RELEVANCE]: {
    name: '建议相关性',
    description: '治疗建议需基于影像所见，给出可执行的具体方案',
    defaultSeverity: RuleSeverity.WARNING,
  },
  [RuleCode.TERMINOLOGY_CONSISTENCY]: {
    name: '术语统一性',
    description: '统一使用标准医学术语，如"龋齿"而非"虫牙"、"洁治"而非"洗牙"',
    defaultSeverity: RuleSeverity.WARNING,
  },
}

export const ResolvedBy = {
  SYSTEM: 'SYSTEM',
  DOCTOR: 'DOCTOR',
  AUDITOR: 'AUDITOR',
} as const
export type ResolvedBy = (typeof ResolvedBy)[keyof typeof ResolvedBy]

export const ResolvedAction = {
  AUTO: 'AUTO',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const
export type ResolvedAction = (typeof ResolvedAction)[keyof typeof ResolvedAction]

export const SamplingRunStatus = {
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
} as const
export type SamplingRunStatus = (typeof SamplingRunStatus)[keyof typeof SamplingRunStatus]

export const SamplingTriggerType = {
  SCHEDULED: 'SCHEDULED',
  MANUAL: 'MANUAL',
  API: 'API',
} as const
export type SamplingTriggerType = (typeof SamplingTriggerType)[keyof typeof SamplingTriggerType]
