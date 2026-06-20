import dayjs from 'dayjs'
import prisma from '../lib/prisma'
import { ReportStatus, SamplingTriggerType } from '../lib/enums'

export interface SamplingRuleShape {
  id: string
  name: string
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
export interface SamplingDetail {
  reportId: string
  reportNo: string
  rate: number
  selected: boolean
  existingTask: boolean
  matchedRuleId?: string | null
  matchedRuleName?: string | null
  assignedToId?: string | null
  priority?: number
  taskId?: string
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

export async function generateDailyTasks(
  targetDate?: Date,
  opts?: {
    triggeredById?: string
    triggerType?: SamplingTriggerType
    note?: string
    regenerateExisting?: boolean
  },
): Promise<{
  runId: string | null
  totalReports: number
  createdTasks: number
  skippedTasks: number
  details: SamplingDetail[]
}> {
  const triggeredById = opts?.triggeredById
  const triggerType = opts?.triggerType || SamplingTriggerType.API
  if (!triggeredById && triggerType === SamplingTriggerType.MANUAL) {
    throw new Error('手动触发需指定操作人')
  }
  const date = targetDate || dayjs().startOf('day').toDate()
  const nextDay = dayjs(date).add(1, 'day').toDate()
  const regenerateExisting = opts?.regenerateExisting ?? false

  const run = triggeredById
    ? await prisma.samplingRun.create({
        data: {
          taskDate: date,
          status: 'RUNNING',
          triggeredById,
          triggerType,
          note: opts?.note || null,
        },
      })
    : null

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
  const existingTaskByReport = new Map(existingTasks.map(t => [t.reportId, t]))

  const rules = await prisma.samplingRule.findMany({ where: { isActive: true } })

  const details: SamplingDetail[] = []
  const runItems: any[] = []
  let createdCount = 0
  let skippedCount = 0

  try {
    for (const report of reports) {
      const hasExisting = existingReportIds.has(report.id)
      if (hasExisting) {
        // 无论 regenerateExisting 是什么值，同日同报告已有待审任务时都不再新建
        // 只在 SamplingRunItem 中标记为沿用已有任务，避免待办越刷越多
        skippedCount++
        const existingTask = existingTaskByReport.get(report.id)!
        // 重新计算 rate 和 matchedRule 用于记录命中了哪条比例规则
        const { rate, auditorId, matchedRule } = getEffectiveSamplingRate(report, rules)
        details.push({
          reportId: report.id,
          reportNo: report.reportNo,
          rate,
          selected: true,
          existingTask: true,
          matchedRuleId: matchedRule?.id ?? null,
          matchedRuleName: matchedRule?.name ?? null,
          taskId: existingTask.id,
          assignedToId: existingTask.assignedToId,
          priority: existingTask.priority,
        })
        if (run) {
          runItems.push({
            runId: run.id,
            reportId: report.id,
            reportNo: report.reportNo,
            clinicId: report.clinicId,
            submitterId: report.submitterId,
            reportType: report.type,
            samplingRate: rate,
            selected: true,
            existingTask: true,
            matchedRuleId: matchedRule?.id ?? null,
            matchedRuleName: matchedRule?.name ?? null,
            assignedToId: existingTask.assignedToId,
            priority: existingTask.priority,
          })
        }
        continue
      }

      const { rate, auditorId, matchedRule } = getEffectiveSamplingRate(report, rules)
      const selected = Math.random() < rate
      const basePriority = report.status === ReportStatus.RULE_CHECK_FAILED ? 10 : 5
      const hasErrors = await prisma.ruleCheckResult.findFirst({
        where: { reportId: report.id, severity: 'ERROR', passed: false },
      })
      const taskPriority = hasErrors ? basePriority + 5 : basePriority

      let taskId: string | undefined
      if (selected) {
        const task = await prisma.auditTask.create({
          data: {
            reportId: report.id,
            taskDate: date,
            assignedToId: auditorId,
            assignedById: auditorId || undefined,
            assignedAt: auditorId ? new Date() : undefined,
            status: auditorId ? 'ASSIGNED' : 'PENDING',
            priority: taskPriority,
          },
        })
        taskId = task.id

        if (auditorId) {
          await prisma.report.update({
            where: { id: report.id },
            data: { status: ReportStatus.PENDING_AUDIT },
          })
        }
        createdCount++
      }

      details.push({
        reportId: report.id,
        reportNo: report.reportNo,
        rate,
        selected,
        existingTask: false,
        matchedRuleId: matchedRule?.id ?? null,
        matchedRuleName: matchedRule?.name ?? null,
        assignedToId: auditorId,
        priority: taskPriority,
        taskId,
      })

      if (run) {
        runItems.push({
          runId: run.id,
          reportId: report.id,
          reportNo: report.reportNo,
          clinicId: report.clinicId,
          submitterId: report.submitterId,
          reportType: report.type,
          matchedRuleId: matchedRule?.id ?? null,
          matchedRuleName: matchedRule?.name ?? null,
          samplingRate: rate,
          selected,
          existingTask: false,
          assignedToId: auditorId,
          priority: taskPriority,
        })
      }
    }

    if (run) {
      await prisma.samplingRunItem.createMany({ data: runItems })
      await prisma.samplingRun.update({
        where: { id: run.id },
        data: {
          status: 'COMPLETED',
          totalReports: reports.length,
          createdTasks: createdCount,
          skippedTasks: skippedCount,
        },
      })
    }

    return {
      runId: run?.id ?? null,
      totalReports: reports.length,
      createdTasks: createdCount,
      skippedTasks: skippedCount,
      details,
    }
  } catch (err) {
    if (run) {
      await prisma.samplingRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', note: (err as Error).message.slice(0, 500) },
      })
    }
    throw err
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
