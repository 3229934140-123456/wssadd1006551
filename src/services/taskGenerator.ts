import dayjs from 'dayjs'
import prisma from '../lib/prisma'
import { ReportStatus } from '../lib/enums'

export interface SamplingRuleShape {
  id: string
  clinicId: string | null
  auditorId: string | null
  reportType: string | null
  submitterId: string | null
  samplingRate: number
  priority: number
  isActive: boolean
}
export interface ReportShape {
  id: string
  reportNo: string
  clinicId: string
  submitterId: string
  type: string
  status: string
  createdAt: Date
}

function matchRule(report: ReportShape, rule: SamplingRuleShape): boolean {
  if (rule.clinicId && report.clinicId !== rule.clinicId) return false
  if (rule.submitterId && report.submitterId !== rule.submitterId) return false
  if (rule.reportType && report.type !== rule.reportType) return false
  return true
}

function getEffectiveSamplingRate(report: ReportShape, rules: SamplingRuleShape[]): {
  rate: number
  auditorId: string | null
  matchedRule: SamplingRuleShape | null
} {
  const activeRules = rules.filter(r => r.isActive).sort((a, b) => b.priority - a.priority)
  for (const rule of activeRules) {
    if (matchRule(report, rule)) {
      return { rate: rule.samplingRate, auditorId: rule.auditorId, matchedRule: rule }
    }
  }
  return { rate: 0.1, auditorId: null, matchedRule: null }
}

export async function generateDailyTasks(targetDate?: Date): Promise<{
  totalReports: number
  createdTasks: number
  details: { reportId: string; reportNo: string; rate: number; selected: boolean }[]
}> {
  const date = targetDate || dayjs().startOf('day').toDate()
  const nextDay = dayjs(date).add(1, 'day').toDate()

  const reports = await prisma.report.findMany({
    where: {
      createdAt: { gte: date, lt: nextDay },
      status: {
        in: [
          ReportStatus.RULE_CHECK_PASSED,
          ReportStatus.RULE_CHECK_FAILED,
          ReportStatus.REVISED,
        ],
      },
    },
  })

  const existingTasks = await prisma.auditTask.findMany({
    where: { taskDate: { gte: date, lt: nextDay } },
  })
  const existingReportIds = new Set(existingTasks.map(t => t.reportId))

  const rules = await prisma.samplingRule.findMany({ where: { isActive: true } })

  const results: { reportId: string; reportNo: string; rate: number; selected: boolean }[] = []
  let createdCount = 0

  for (const report of reports) {
    if (existingReportIds.has(report.id)) {
      results.push({ reportId: report.id, reportNo: report.reportNo, rate: 0, selected: false })
      continue
    }

    const { rate, auditorId } = getEffectiveSamplingRate(report, rules)
    const selected = Math.random() < rate

    if (selected) {
      const priority = report.status === ReportStatus.RULE_CHECK_FAILED ? 10 : 5
      const hasErrors = await prisma.ruleCheckResult.findFirst({
        where: { reportId: report.id, severity: 'ERROR', passed: false },
      })
      const task = await prisma.auditTask.create({
        data: {
          reportId: report.id,
          taskDate: date,
          assignedToId: auditorId,
          assignedById: auditorId || undefined,
          assignedAt: auditorId ? new Date() : undefined,
          status: auditorId ? 'ASSIGNED' : 'PENDING',
          priority: hasErrors ? priority + 5 : priority,
        },
      })

      if (auditorId) {
        await prisma.report.update({
          where: { id: report.id },
          data: { status: ReportStatus.PENDING_AUDIT },
        })
      }

      createdCount++
      results.push({ reportId: report.id, reportNo: report.reportNo, rate, selected: true })
    } else {
      results.push({ reportId: report.id, reportNo: report.reportNo, rate, selected: false })
    }
  }

  return {
    totalReports: reports.length,
    createdTasks: createdCount,
    details: results,
  }
}

export async function generateManualTask(
  reportId: string,
  assignedToId?: string,
  assignedById?: string,
): Promise<string> {
  const report = await prisma.report.findUnique({ where: { id: reportId } })
  if (!report) throw new Error('报告不存在')

  const existing = await prisma.auditTask.findFirst({
    where: {
      reportId,
      status: { in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS'] },
    },
  })
  if (existing) throw new Error('该报告已有待处理的审核任务')

  const task = await prisma.auditTask.create({
    data: {
      reportId,
      taskDate: new Date(),
      assignedToId: assignedToId || null,
      assignedById: assignedById || null,
      assignedAt: assignedToId ? new Date() : null,
      status: assignedToId ? 'ASSIGNED' : 'PENDING',
      priority: 8,
    },
  })

  if (assignedToId) {
    await prisma.report.update({
      where: { id: reportId },
      data: { status: ReportStatus.PENDING_AUDIT },
    })
  }

  return task.id
}
