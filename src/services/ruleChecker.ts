import { RuleSeverity } from '../lib/enums'

export type ReportShape = {
  id: string
  type: string
  examName: string | null
  diagnosis: string
  conclusions: string
  recommendations: string
  toothPositions: string
  description: string
}
export type RuleCheckResultShape = {
  reportId: string
  ruleCode: string
  ruleName: string
  severity: RuleSeverity
  passed: boolean
  message: string
  fieldName?: string | null
  suggestion?: string | null
}

export interface RuleCheckIssue {
  ruleCode: string
  ruleName: string
  severity: RuleSeverity
  passed: boolean
  message: string
  fieldName?: string
  suggestion?: string
}

const STANDARD_TOOTH_PATTERN = /^[1-4][1-8](,[1-4][1-8])*$/
const TOOTH_MENTION_PATTERN = /([1-4][1-8]|乳牙|全口|上颌|下颌|前牙|后牙|磨牙|尖牙|切牙)/g

const STANDARD_EXAM_NAMES: Record<string, string[]> = {
  PANORAMIC_XRAY: ['全景片', '曲面断层片', '全景', '口腔全景片'],
  CBCT: ['CBCT', '锥形束CT', '口腔CT'],
}

const VAGUE_DIAGNOSIS_WORDS = ['炎症', '异常', '病变', '问题', '不适', '阴影', '密度改变']
const VAGUE_CONCLUSION_WORDS = ['建议进一步检查', '必要时复诊', '结合临床', '请结合临床', '随诊']
const STANDARD_TERMINOLOGY_MAP: Record<string, string> = {
  '虫牙': '龋齿',
  '蛀牙': '龋齿',
  '牙神经痛': '牙髓炎',
  '牙床肿': '牙龈肿胀',
  '长牙包': '根尖周脓肿',
  '火牙': '牙周炎',
  '牙垢': '牙结石',
  '洗牙': '洁治',
  '补牙': '充填治疗',
  '杀神经': '根管治疗',
  '镶牙': '义齿修复',
  '种牙': '种植修复',
}

function checkExamName(report: ReportShape): RuleCheckIssue {
  const passed = !!report.examName && report.examName.trim().length > 0
  return {
    ruleCode: 'EXAM_NAME_001',
    ruleName: '检查名称必填',
    severity: RuleSeverity.ERROR,
    passed,
    message: passed ? '检查名称已填写' : '检查名称缺失，请填写规范的检查名称',
    fieldName: 'examName',
    suggestion: `请填写检查名称，如：${STANDARD_EXAM_NAMES[report.type]?.join('、') || '全景片、CBCT'}`,
  }
}

function checkExamNameStandard(report: ReportShape): RuleCheckIssue {
  if (!report.examName) {
    return {
      ruleCode: 'EXAM_NAME_002',
      ruleName: '检查名称规范性',
      severity: RuleSeverity.WARNING,
      passed: false,
      message: '检查名称缺失，无法验证规范性',
      fieldName: 'examName',
    }
  }
  const validNames = STANDARD_EXAM_NAMES[report.type] || []
  const passed = validNames.some(n => report.examName!.includes(n))
  return {
    ruleCode: 'EXAM_NAME_002',
    ruleName: '检查名称规范性',
    severity: RuleSeverity.WARNING,
    passed,
    message: passed ? '检查名称符合规范' : `检查名称可能不规范，建议使用：${validNames.join('、')}`,
    fieldName: 'examName',
    suggestion: `请使用标准术语，推荐：${validNames.join('、')}`,
  }
}

function checkToothPositionFormat(report: ReportShape): RuleCheckIssue {
  const content = (report.toothPositions + report.diagnosis + report.conclusions + report.recommendations).trim()
  if (!content) {
    return {
      ruleCode: 'TOOTH_001',
      ruleName: '牙位信息存在性',
      severity: RuleSeverity.ERROR,
      passed: false,
      message: '未发现任何牙位相关描述，请补充涉及的牙位',
      fieldName: 'toothPositions',
      suggestion: '请使用 FDI 牙位表示法（如 16、25、36、47），用逗号分隔',
    }
  }
  if (report.toothPositions.trim()) {
    const positions = report.toothPositions.split(/[,，、;；\s]+/).filter(Boolean)
    const allValid = positions.every(p => STANDARD_TOOTH_PATTERN.test(p) || /乳牙|全口|上颌|下颌|前牙|后牙/.test(p))
    return {
      ruleCode: 'TOOTH_001',
      ruleName: '牙位写法规范',
      severity: allValid ? RuleSeverity.INFO : RuleSeverity.WARNING,
      passed: allValid,
      message: allValid ? '牙位写法符合 FDI 规范' : '牙位写法不规范，请使用 FDI 两位数标注法（1-4象限+1-8牙位）',
      fieldName: 'toothPositions',
      suggestion: '标准格式示例：16,25,36,47（逗号分隔，无空格）',
    }
  }
  const hasToothMention = TOOTH_MENTION_PATTERN.test(content)
  return {
    ruleCode: 'TOOTH_001',
    ruleName: '牙位信息完整性',
    severity: RuleSeverity.WARNING,
    passed: hasToothMention,
    message: hasToothMention ? '文本中包含牙位相关描述' : '牙位字段为空且内容中未提及具体牙位',
    fieldName: 'toothPositions',
    suggestion: '建议在"牙位"字段明确标注涉及的牙齿编号',
  }
}

function checkDiagnosisWithTooth(report: ReportShape): RuleCheckIssue {
  const diagnosis = report.diagnosis
  if (!diagnosis.trim()) {
    return {
      ruleCode: 'DIAG_001',
      ruleName: '诊断内容必填',
      severity: RuleSeverity.ERROR,
      passed: false,
      message: '诊断结论缺失，请填写诊断内容',
      fieldName: 'diagnosis',
    }
  }
  const hasVagueTerm = VAGUE_DIAGNOSIS_WORDS.some(w => diagnosis.includes(w))
  if (!hasVagueTerm) {
    return {
      ruleCode: 'DIAG_002',
      ruleName: '诊断-牙位关联检查',
      severity: RuleSeverity.INFO,
      passed: true,
      message: '诊断描述中未检测到模糊术语',
      fieldName: 'diagnosis',
    }
  }
  const hasToothInDiagnosis = TOOTH_MENTION_PATTERN.test(diagnosis) || report.toothPositions.trim().length > 0
  return {
    ruleCode: 'DIAG_002',
    ruleName: '诊断需明确牙位',
    severity: RuleSeverity.ERROR,
    passed: hasToothInDiagnosis,
    message: hasToothInDiagnosis
      ? '模糊术语已关联到具体牙位'
      : `诊断中使用了模糊描述（${VAGUE_DIAGNOSIS_WORDS.filter(w => diagnosis.includes(w)).join('、')}），但未明确对应牙位`,
    fieldName: 'diagnosis',
    suggestion: '例如："16根尖周炎症" 而不仅仅是 "有炎症"',
  }
}

function checkConclusion(report: ReportShape): RuleCheckIssue {
  const conclusions = report.conclusions
  if (!conclusions.trim()) {
    return {
      ruleCode: 'CONCL_001',
      ruleName: '结论必填',
      severity: RuleSeverity.ERROR,
      passed: false,
      message: '诊断结论缺失，请填写总结性结论',
      fieldName: 'conclusions',
    }
  }
  const isTooVague = VAGUE_CONCLUSION_WORDS.some(w => conclusions.trim() === w || conclusions.trim().length < 6)
  return {
    ruleCode: 'CONCL_002',
    ruleName: '结论完整性',
    severity: RuleSeverity.WARNING,
    passed: !isTooVague,
    message: isTooVague ? '结论过于笼统，请补充具体诊断结论' : '结论填写完整',
    fieldName: 'conclusions',
    suggestion: '请给出明确的诊断结论，如："16 慢性根尖周炎，25 深龋近髓"',
  }
}

function checkRecommendations(report: ReportShape): RuleCheckIssue {
  const recommendations = report.recommendations
  if (!recommendations.trim()) {
    return {
      ruleCode: 'REC_001',
      ruleName: '建议必填',
      severity: RuleSeverity.ERROR,
      passed: false,
      message: '治疗建议缺失，请填写处置建议',
      fieldName: 'recommendations',
    }
  }
  const hasImageRelated = /片|影像|CBCT|CT|全景|根尖片/g.test(report.description + report.diagnosis)
  if (hasImageRelated) {
    const recMatchesImage = /根管|充填|拔除|修复|种植|洁治|刮治|观察|复查/.test(recommendations)
    return {
      ruleCode: 'REC_002',
      ruleName: '建议与影像匹配性',
      severity: RuleSeverity.WARNING,
      passed: recMatchesImage,
      message: recMatchesImage
        ? '建议内容与常规影像检查处置方向一致'
        : '建议内容可能与影像结果不匹配，请确认建议的合理性',
      fieldName: 'recommendations',
      suggestion: '建议应基于影像所见给出具体方案，如根管治疗、充填治疗等',
    }
  }
  return {
    ruleCode: 'REC_002',
    ruleName: '建议与影像匹配性',
    severity: RuleSeverity.INFO,
    passed: true,
    message: '建议已填写',
    fieldName: 'recommendations',
  }
}

function checkTerminologyConsistency(report: ReportShape): RuleCheckIssue {
  const allText = `${report.diagnosis} ${report.conclusions} ${report.recommendations} ${report.description}`
  const usedTerms: string[] = []
  for (const [colloquial, standard] of Object.entries(STANDARD_TERMINOLOGY_MAP)) {
    if (allText.includes(colloquial)) {
      usedTerms.push(`"${colloquial}"→"${standard}"`)
    }
  }
  return {
    ruleCode: 'TERM_001',
    ruleName: '术语统一性',
    severity: usedTerms.length > 0 ? RuleSeverity.WARNING : RuleSeverity.INFO,
    passed: usedTerms.length === 0,
    message: usedTerms.length > 0
      ? `检测到非标准术语，建议替换：${usedTerms.join('；')}`
      : '术语使用规范统一',
    fieldName: 'diagnosis',
    suggestion: usedTerms.length > 0 ? '请使用统一的标准口腔医学术语' : undefined,
  }
}

export function runAllRules(report: ReportShape): RuleCheckIssue[] {
  return [
    checkExamName(report),
    checkExamNameStandard(report),
    checkToothPositionFormat(report),
    checkDiagnosisWithTooth(report),
    checkConclusion(report),
    checkRecommendations(report),
    checkTerminologyConsistency(report),
  ]
}

export function issuesToDbRecords(
  reportId: string,
  issues: RuleCheckIssue[],
): RuleCheckResultShape[] {
  return issues.map(issue => ({
    reportId,
    ruleCode: issue.ruleCode,
    ruleName: issue.ruleName,
    severity: issue.severity,
    passed: issue.passed,
    message: issue.message,
    fieldName: issue.fieldName,
    suggestion: issue.suggestion,
  }))
}
