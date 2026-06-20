import { Router, Response } from 'express'
import { z } from 'zod'
import dayjs from 'dayjs'
import prisma from '../lib/prisma'
import { authenticate, AuthRequest, requireRole } from '../middleware/auth'
import { ReportStatus, ReportType, UserRole, RuleSeverity } from '../lib/enums'
import { runAllRules, issuesToDbRecords } from '../services/ruleChecker'

const router = Router()

router.use(authenticate)

router.get('/workbench', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR), async (req: AuthRequest, res: Response) => {
  try {
    const {
      status, // NEEDS_REVISION | PENDING_VERIFICATION | RECTIFIED | REJECTED | ALL_ACTIVE
      clinicId,
      submitterId,
      reportType,
      issueCategory,
      sortBy = 'updatedAt', // assignedTo | overdueDays | lastRevisedAt | updatedAt | reportNo
      sortOrder = 'desc',   // asc | desc
      page = '1',
      pageSize = '20',
    } = req.query

    // --- Step 1: 基于子查询一致地构造 baseWhere（解决分页匹配 + REJECTED 稳定入口）---
    const baseWhere: any = {}
    if (clinicId) baseWhere.clinicId = clinicId as string
    if (submitterId) baseWhere.submitterId = submitterId as string
    if (reportType) baseWhere.type = reportType as string

    // 基于 status 过滤 —— REJECTED 作为稳定入口：NEEDS_REVISION 且有被退回过的反馈
    const STATUS_REJECTED = 'REJECTED'
    const STATUS_ALL_ACTIVE = 'ALL_ACTIVE'
    const activeStatuses = [
      ReportStatus.NEEDS_REVISION,
      ReportStatus.PENDING_VERIFICATION,
      ReportStatus.REVISED,
      ReportStatus.PENDING_AUDIT,
      ReportStatus.IN_AUDIT,
    ] as string[]

    if (status === STATUS_ALL_ACTIVE) {
      baseWhere.status = { in: activeStatuses }
    } else if (status === STATUS_REJECTED) {
      // 稳定入口：状态=NEEDS_REVISION + 曾有过 REJECTED 反馈，且医生还没提交新一轮整改
      baseWhere.status = ReportStatus.NEEDS_REVISION
      baseWhere.auditFeedbacks = {
        some: { resolvedAction: 'REJECTED' },
      }
    } else if (status) {
      baseWhere.status = status as string
    }

    // issueCategory 直接放到子查询（DB 级筛选），保证总数与列表一致
    if (issueCategory) {
      // 不破坏已有的 auditFeedbacks.some，另起一个 AND 子句
      if (baseWhere.AND && Array.isArray(baseWhere.AND)) {
        baseWhere.AND.push({ auditFeedbacks: { some: { issueCategory: issueCategory as string } } })
      } else {
        baseWhere.AND = [{ auditFeedbacks: { some: { issueCategory: issueCategory as string } } }]
      }
    }

    const pageNum = Math.max(1, parseInt(page as string))
    const size = Math.min(100, Math.max(1, parseInt(pageSize as string)))
    const skip = (pageNum - 1) * size

    // --- Step 2: 并行查总数 + 列表（WHERE 完全相同，保证分页一致）---
    const [total, reports] = await Promise.all([
      prisma.report.count({ where: baseWhere }),
      prisma.report.findMany({
        where: baseWhere,
        skip,
        take: size,
        include: {
          clinic: { select: { id: true, name: true, code: true } },
          submitter: { select: { id: true, name: true, phone: true } },
          auditTasks: {
            where: { status: { not: 'COMPLETED' } },
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { assignedTo: { select: { id: true, name: true } } },
          },
          auditFeedbacks: {
            orderBy: { createdAt: 'desc' },
          },
          ruleChecks: {
            where: { severity: RuleSeverity.ERROR, passed: false },
            take: 3,
          },
        },
      }),
    ])

    // --- Step 3: 先算每条记录的 nextHandler / lastRevisedAt / overdueDays / assignedTo（用于排序）---
    const now = dayjs()
    type EnrichedReport = typeof reports[number] & {
      _nextHandler: { type: string; role: string; userId?: string; userName?: string }
      _lastRevisedAt: Date
      _overdueDays: number
      _assignedToName: string
      _rejectedCount: number
      _pendingVerification: number
    }

    const enriched = reports.map((r: any): EnrichedReport => {
      const fieldFeedbacks = r.auditFeedbacks.filter((fb: any) => fb.fieldName != null)
      const totalField = fieldFeedbacks.length
      const pendingCount = fieldFeedbacks.filter((fb: any) =>
        !fb.isResolved || (fb.isResolved && fb.resolvedBy !== 'AUDITOR')
      ).length
      const rejectedCount = fieldFeedbacks.filter((fb: any) => fb.resolvedAction === 'REJECTED').length
      const lastResolvedAt = fieldFeedbacks
        .filter((fb: any) => fb.resolvedAt)
        .sort((a: any, b: any) => (b.resolvedAt?.getTime() || 0) - (a.resolvedAt?.getTime() || 0))[0]?.resolvedAt
      const lastRevisedAt: Date = lastResolvedAt || r.updatedAt

      const st: string = r.status
      const task = r.auditTasks[0]
      const assignedTo = task?.assignedTo || null

      // nextHandler 计算
      let nextHandler: EnrichedReport['_nextHandler']
      switch (st) {
        case ReportStatus.NEEDS_REVISION:
          nextHandler = {
            type: 'DOCTOR',
            role: UserRole.CLINIC_DOCTOR,
            userId: r.submitterId,
            userName: r.submitter?.name,
          }
          break
        case ReportStatus.PENDING_VERIFICATION:
          nextHandler = assignedTo
            ? { type: 'QC_AUDITOR_ASSIGNED', role: UserRole.QC_AUDITOR, userId: assignedTo.id, userName: assignedTo.name }
            : { type: 'QC_AUDITOR_POOL', role: UserRole.QC_AUDITOR }
          break
        case ReportStatus.PENDING_AUDIT:
        case ReportStatus.REVISED:
          nextHandler = assignedTo
            ? { type: 'QC_AUDITOR_ASSIGNED', role: UserRole.QC_AUDITOR, userId: assignedTo.id, userName: assignedTo.name }
            : { type: 'QC_AUDITOR_POOL', role: UserRole.QC_AUDITOR }
          break
        case ReportStatus.IN_AUDIT:
          nextHandler = assignedTo
            ? { type: 'QC_AUDITOR_IN_PROGRESS', role: UserRole.QC_AUDITOR, userId: assignedTo.id, userName: assignedTo.name }
            : { type: 'QC_AUDITOR_POOL', role: UserRole.QC_AUDITOR }
          break
        case ReportStatus.AUDIT_APPROVED:
        case ReportStatus.RECTIFIED:
          nextHandler = { type: 'NONE', role: 'NONE' }
          break
        default:
          nextHandler = { type: 'DOCTOR', role: UserRole.CLINIC_DOCTOR, userId: r.submitterId, userName: r.submitter?.name }
      }

      // 超期天数：PENDING_VERIFICATION/PENDING_AUDIT 超 3 天算超期，NEEDS_REVISION 超 2 天
      let overdueDays = 0
      const verifyStatuses = [ReportStatus.PENDING_VERIFICATION, ReportStatus.PENDING_AUDIT, ReportStatus.REVISED, ReportStatus.IN_AUDIT] as string[]
      const overdueThreshold =
        st === ReportStatus.NEEDS_REVISION ? 2 :
        verifyStatuses.includes(st) ? 3 :
        0
      if (overdueThreshold > 0) {
        const diff = now.diff(dayjs(lastRevisedAt), 'day')
        overdueDays = diff > overdueThreshold ? diff - overdueThreshold : 0
      }

      return {
        ...r,
        _nextHandler: nextHandler,
        _lastRevisedAt: lastRevisedAt,
        _overdueDays: overdueDays,
        _assignedToName: assignedTo?.name || (task ? '待分配' : '无任务'),
        _rejectedCount: rejectedCount,
        _pendingVerification: pendingCount,
      } as EnrichedReport
    })

    // --- Step 4: 应用排序 ---
    const order = sortOrder === 'asc' ? 1 : -1
    enriched.sort((a: any, b: any) => {
      let av: any = null, bv: any = null
      switch (sortBy) {
        case 'assignedTo':
          av = a._assignedToName; bv = b._assignedToName
          break
        case 'overdueDays':
          av = a._overdueDays; bv = b._overdueDays
          break
        case 'lastRevisedAt':
          av = a._lastRevisedAt?.getTime() || 0; bv = b._lastRevisedAt?.getTime() || 0
          break
        case 'reportNo':
          av = a.reportNo; bv = b.reportNo
          break
        case 'updatedAt':
        default:
          av = a.updatedAt?.getTime() || 0; bv = b.updatedAt?.getTime() || 0
      }
      if (av < bv) return -order
      if (av > bv) return order
      return 0
    })

    // --- Step 5: 组装返回数据 ---
    const list = enriched.map((r: any) => {
      const fieldFeedbacks = r.auditFeedbacks.filter((fb: any) => fb.fieldName != null)
      const totalField = fieldFeedbacks.length
      const verifiedApproved = fieldFeedbacks.filter(
        (fb: any) => fb.resolvedAction === 'APPROVED' && fb.resolvedBy === 'AUDITOR'
      ).length

      return {
        id: r.id,
        reportNo: r.reportNo,
        type: r.type,
        patientName: r.patientName,
        patientId: r.patientId,
        status: r.status,
        clinic: r.clinic,
        submitter: r.submitter,
        task: r.auditTasks[0] || null,
        ruleErrors: r.ruleChecks,
        lastRevisedAt: r._lastRevisedAt,
        feedbackStats: {
          total: totalField,
          pendingVerification: r._pendingVerification,
          rejected: r._rejectedCount,
          verifiedApproved,
        },
        hasRejected: r._rejectedCount > 0,
        categories: [...new Set(r.auditFeedbacks.map((fb: any) => fb.issueCategory))],
        updatedAt: r.updatedAt,
        createdAt: r.createdAt,
        // 新增字段（v4）
        nextHandler: r._nextHandler,
        overdueDays: r._overdueDays,
      }
    })

    // --- Step 6: overview 分类统计（与 WHERE 解耦，独立统计所有队列）---
    const [overviewCounts, rejectedStableCount] = await Promise.all([
      prisma.report.groupBy({
        by: ['status'],
        where: { status: { in: [
          ReportStatus.NEEDS_REVISION,
          ReportStatus.PENDING_VERIFICATION,
          ReportStatus.RECTIFIED,
          ReportStatus.REVISED,
          ReportStatus.PENDING_AUDIT,
          ReportStatus.IN_AUDIT,
        ] } },
        _count: { status: true },
      }),
      // 稳定的已退回数量统计
      prisma.report.count({
        where: {
          status: ReportStatus.NEEDS_REVISION,
          auditFeedbacks: { some: { resolvedAction: 'REJECTED' } },
        },
      }),
    ])
    const statusMap: Record<string, number> = {}
    overviewCounts.forEach(s => { statusMap[s.status] = s._count.status })

    return res.json({
      total,
      page: pageNum,
      pageSize: size,
      sortBy,
      sortOrder,
      list,
      overview: {
        needsRevision: statusMap[ReportStatus.NEEDS_REVISION] || 0,
        pendingVerification: statusMap[ReportStatus.PENDING_VERIFICATION] || 0,
        rectified: statusMap[ReportStatus.RECTIFIED] || 0,
        pendingAudit: (statusMap[ReportStatus.PENDING_AUDIT] || 0) + (statusMap[ReportStatus.REVISED] || 0) + (statusMap[ReportStatus.IN_AUDIT] || 0),
        rejected: rejectedStableCount,  // 稳定入口统计
        total: (statusMap[ReportStatus.NEEDS_REVISION] || 0) +
               (statusMap[ReportStatus.PENDING_VERIFICATION] || 0) +
               (statusMap[ReportStatus.RECTIFIED] || 0) +
               (statusMap[ReportStatus.PENDING_AUDIT] || 0) +
               (statusMap[ReportStatus.REVISED] || 0) +
               (statusMap[ReportStatus.IN_AUDIT] || 0),
      },
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// 批量分配复核人
router.post('/workbench/batch-assign', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER), async (req: AuthRequest, res: Response) => {
  try {
    const schema = z.object({
      reportIds: z.array(z.string()).min(1),
      assignedToId: z.string().min(1),
    })
    const body = schema.parse(req.body)
    const assignedById = req.user!.userId

    // 检查目标用户身份
    const auditor = await prisma.user.findUnique({ where: { id: body.assignedToId } })
    if (!auditor) return res.status(404).json({ error: '审核员不存在' })
    const qcRoles = [UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR] as string[]
    if (!qcRoles.includes(auditor.role)) {
      return res.status(400).json({ error: '目标用户不是质控角色' })
    }

    // 找出每份报告的活跃任务，不存在则创建新任务
    const now = new Date()
    let updated = 0, created = 0, skipped = 0
    for (const reportId of body.reportIds) {
      const report = await prisma.report.findUnique({ where: { id: reportId } })
      if (!report) { skipped++; continue }

      // 只对活动状态的报告分配
      const assignableStatuses = [
        ReportStatus.PENDING_VERIFICATION,
        ReportStatus.PENDING_AUDIT,
        ReportStatus.NEEDS_REVISION,
        ReportStatus.REVISED,
        ReportStatus.IN_AUDIT,
      ] as string[]
      if (!assignableStatuses.includes(report.status)) { skipped++; continue }

      // 查找活跃任务
      let task = await prisma.auditTask.findFirst({
        where: {
          reportId,
          status: { in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS'] },
        },
      })

      if (task) {
        await prisma.auditTask.update({
          where: { id: task.id },
          data: {
            assignedToId: body.assignedToId,
            assignedById,
            assignedAt: now,
            status: 'ASSIGNED',
          },
        })
        updated++
      } else {
        await prisma.auditTask.create({
          data: {
            reportId,
            taskDate: now,
            assignedToId: body.assignedToId,
            assignedById,
            assignedAt: now,
            status: 'ASSIGNED',
            priority: 5,
          },
        })
        created++
        // 若报告还在 NEEDS_REVISION 以外（如纯 SUBMITTED 无状态变化），标记 PENDING_AUDIT
        if (report.status === ReportStatus.RULE_CHECK_PASSED || report.status === ReportStatus.RULE_CHECK_FAILED || report.status === ReportStatus.SUBMITTED) {
          await prisma.report.update({
            where: { id: reportId },
            data: { status: ReportStatus.PENDING_AUDIT },
          })
        }
      }
    }

    return res.json({
      total: body.reportIds.length,
      assigned: updated + created,
      updatedTasks: updated,
      createdTasks: created,
      skipped,
      assignedTo: { id: auditor.id, name: auditor.name, role: auditor.role },
    })
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: '参数验证失败', details: err.errors })
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// 批量提醒医生 / 审核员（根据 nextHandler 判断）
router.post('/workbench/batch-remind', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR), async (req: AuthRequest, res: Response) => {
  try {
    const schema = z.object({
      reportIds: z.array(z.string()).min(1),
      targetRole: z.enum(['AUTO', 'DOCTOR', 'QC_AUDITOR']).default('AUTO'),
      note: z.string().max(200).optional(),
    })
    const body = schema.parse(req.body)
    const now = new Date()

    // 实际业务这里会触发短信/站内信，这里模拟写入提醒记录（用 AuditTask.lastRemindedAt 标记）
    let doctorReminded = 0, auditorReminded = 0, skipped = 0
    const details: any[] = []

    for (const reportId of body.reportIds) {
      const report = await prisma.report.findUnique({
        where: { id: reportId },
        include: {
          submitter: { select: { id: true, name: true, phone: true, role: true } },
          auditTasks: {
            where: { status: { in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS'] } },
            take: 1,
            include: { assignedTo: { select: { id: true, name: true, phone: true, role: true } } },
          },
        },
      })
      if (!report) { skipped++; continue }

      // 决定提醒对象
      let target: 'DOCTOR' | 'QC_AUDITOR' | null = null
      if (body.targetRole === 'DOCTOR') target = 'DOCTOR'
      else if (body.targetRole === 'QC_AUDITOR') target = 'QC_AUDITOR'
      else {
        // AUTO: NEEDS_REVISION 提醒医生，其他状态提醒审核员
        target = report.status === ReportStatus.NEEDS_REVISION ? 'DOCTOR' : 'QC_AUDITOR'
      }

      if (target === 'DOCTOR') {
        doctorReminded++
        details.push({
          reportId: report.id, reportNo: report.reportNo,
          target: 'DOCTOR', targetUserId: report.submitterId, targetUserName: report.submitter?.name,
          phone: report.submitter?.phone,
        })
        // 用任务表的 lastRemindedAt 做统一标记（不管提醒谁）
        const task = report.auditTasks[0]
        if (task) {
          await prisma.auditTask.update({ where: { id: task.id }, data: { lastRemindedAt: now } })
        }
      } else if (target === 'QC_AUDITOR') {
        const task = report.auditTasks[0]
        if (task && task.assignedToId) {
          auditorReminded++
          details.push({
            reportId: report.id, reportNo: report.reportNo,
            target: 'QC_AUDITOR', targetUserId: task.assignedToId, targetUserName: task.assignedTo?.name,
            phone: task.assignedTo?.phone,
          })
          await prisma.auditTask.update({ where: { id: task.id }, data: { lastRemindedAt: now } })
        } else {
          // 无分配对象，计入 skipped
          skipped++
          details.push({ reportId: report.id, reportNo: report.reportNo, target: 'QC_AUDITOR', skipped: true, reason: '未分配审核员' })
        }
      }
    }

    return res.json({
      total: body.reportIds.length,
      doctorReminded,
      auditorReminded,
      skipped,
      note: body.note || null,
      lastRemindedAt: now,
      details,
    })
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: '参数验证失败', details: err.errors })
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

const createReportSchema = z.object({
  type: z.nativeEnum(ReportType),
  examName: z.string().optional(),
  patientName: z.string().optional(),
  patientId: z.string().optional(),
  description: z.string().default(''),
  diagnosis: z.string().default(''),
  conclusions: z.string().default(''),
  recommendations: z.string().default(''),
  toothPositions: z.string().default(''),
  rawContent: z.string().default(''),
  submit: z.boolean().default(false),
  parentReportId: z.string().optional(),
})

function generateReportNo(clinicCode: string, type: ReportType): string {
  const prefix = type === ReportType.CBCT ? 'CBCT' : 'PAN'
  const date = dayjs().format('YYYYMMDD')
  const random = Math.floor(Math.random() * 9000 + 1000)
  return `${clinicCode}-${prefix}-${date}-${random}`
}

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const body = createReportSchema.parse(req.body)
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } })
    if (!user) return res.status(404).json({ error: '用户不存在' })

    if (!user.clinicId) {
      return res.status(400).json({ error: '用户未关联门店，无法提交报告' })
    }

    const clinic = await prisma.clinic.findUnique({ where: { id: user.clinicId } })
    if (!clinic) return res.status(404).json({ error: '门店不存在' })

    const reportNo = generateReportNo(clinic.code, body.type)
    let version = 1
    let parentReportId = body.parentReportId || null

    if (body.parentReportId) {
      const parent = await prisma.report.findUnique({ where: { id: body.parentReportId } })
      if (!parent) {
        return res.status(404).json({ error: '原报告不存在' })
      }
      if (parent.clinicId !== user.clinicId) {
        return res.status(403).json({ error: '只能修改本门店报告' })
      }
      version = parent.version + 1
    }

    const initialStatus = body.submit ? ReportStatus.SUBMITTED : ReportStatus.DRAFT

    const report = await prisma.report.create({
      data: {
        reportNo,
        type: body.type,
        examName: body.examName,
        patientName: body.patientName,
        patientId: body.patientId,
        clinicId: user.clinicId,
        submitterId: user.id,
        description: body.description,
        diagnosis: body.diagnosis,
        conclusions: body.conclusions,
        recommendations: body.recommendations,
        toothPositions: body.toothPositions,
        rawContent: body.rawContent,
        status: initialStatus,
        version,
        parentReportId,
      },
      include: {
        clinic: true,
        submitter: { select: { id: true, name: true } },
      },
    })

    if (body.submit) {
      const { issues, configs } = await runAllRules(report as any, { useConfigs: true })
      const ruleSnapshot = configs ? JSON.stringify(configs) : null
      const dbRecords = issuesToDbRecords(report.id, issues, { ruleSnapshot })
      await prisma.ruleCheckResult.createMany({ data: dbRecords })
      const hasErrors = issues.some(i => i.severity === RuleSeverity.ERROR && !i.passed)
      const finalStatus = hasErrors ? ReportStatus.RULE_CHECK_FAILED : ReportStatus.RULE_CHECK_PASSED
      await prisma.report.update({
        where: { id: report.id },
        data: { status: finalStatus },
      })
      report.status = finalStatus
      return res.status(201).json({
        report: {
          ...report,
          ruleChecks: {
            passed: !hasErrors,
            errorCount: issues.filter(i => i.severity === RuleSeverity.ERROR && !i.passed).length,
            warningCount: issues.filter(i => i.severity === RuleSeverity.WARNING && !i.passed).length,
            details: issues,
          },
        },
      })
    }

    return res.status(201).json({ report })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: '参数验证失败', details: err.errors })
    }
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.put('/:id/submit', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } })
    if (!user) return res.status(404).json({ error: '用户不存在' })

    const report = await prisma.report.findUnique({ where: { id: req.params.id } })
    if (!report) return res.status(404).json({ error: '报告不存在' })

    if (report.clinicId !== user.clinicId) {
      return res.status(403).json({ error: '只能提交本门店报告' })
    }
    if (report.submitterId !== user.id && user.role !== UserRole.CLINIC_MANAGER) {
      return res.status(403).json({ error: '只能提交本人报告' })
    }
    if (!([ReportStatus.DRAFT, ReportStatus.REVISED, ReportStatus.RULE_CHECK_FAILED] as string[]).includes(report.status)) {
      return res.status(400).json({ error: `当前状态 ${report.status} 无法提交` })
    }

    const updated = await prisma.report.update({
      where: { id: report.id },
      data: { status: ReportStatus.SUBMITTED },
    })

    const { issues, configs } = await runAllRules(updated as any, { useConfigs: true })
    const ruleSnapshot = configs ? JSON.stringify(configs) : null
    const dbRecords = issuesToDbRecords(report.id, issues, { ruleSnapshot })
    await prisma.ruleCheckResult.deleteMany({ where: { reportId: report.id } })
    await prisma.ruleCheckResult.createMany({ data: dbRecords })

    const hasErrors = issues.some(i => i.severity === RuleSeverity.ERROR && !i.passed)
    const finalStatus = hasErrors ? ReportStatus.RULE_CHECK_FAILED : ReportStatus.RULE_CHECK_PASSED
    const finalReport = await prisma.report.update({
      where: { id: report.id },
      data: { status: finalStatus },
      include: {
        clinic: true,
        submitter: { select: { id: true, name: true } },
      },
    })

    return res.json({
      report: finalReport,
      ruleChecks: {
        passed: !hasErrors,
        errorCount: issues.filter(i => i.severity === RuleSeverity.ERROR && !i.passed).length,
        warningCount: issues.filter(i => i.severity === RuleSeverity.WARNING && !i.passed).length,
        details: issues,
      },
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.put('/:id/revise', async (req: AuthRequest, res: Response) => {
  try {
    const body = createReportSchema.partial().parse(req.body)
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } })
    if (!user) return res.status(404).json({ error: '用户不存在' })

    const report = await prisma.report.findUnique({ where: { id: req.params.id } })
    if (!report) return res.status(404).json({ error: '报告不存在' })
    if (report.clinicId !== user.clinicId) {
      return res.status(403).json({ error: '只能修改本门店报告' })
    }
    if (report.submitterId !== user.id && user.role !== UserRole.CLINIC_MANAGER) {
      return res.status(403).json({ error: '只能修改本人报告' })
    }

    const allowedStatuses = [
      ReportStatus.DRAFT,
      ReportStatus.RULE_CHECK_FAILED,
      ReportStatus.NEEDS_REVISION,
      ReportStatus.REVISED,
    ] as string[]
    if (!allowedStatuses.includes(report.status)) {
      return res.status(400).json({ error: `当前状态 ${report.status} 无法修改` })
    }

    const { submit: _submit, parentReportId: _parent, ...updateData } = body

    const updated = await prisma.report.update({
      where: { id: report.id },
      data: {
        ...updateData,
        status: report.status === ReportStatus.NEEDS_REVISION ? ReportStatus.REVISED : report.status,
      },
      include: {
        clinic: true,
        submitter: { select: { id: true, name: true } },
        ruleChecks: true,
      },
    })

    const allFeedbacks = await prisma.auditFeedback.findMany({
      where: { reportId: report.id },
    })

    const resolvedUpdates: { id: string; newValue?: string }[] = allFeedbacks
      .filter(f => {
        if (!f.fieldName) return false
        const oldVal = (f.oldValue || '').trim()
        const newVal = ((updated as any)[f.fieldName] || '').toString().trim()
        return oldVal !== newVal && newVal.length > 0
      })
      .map(f => ({
        id: f.id,
        newValue: ((updated as any)[f.fieldName!] || '').toString(),
      }))
    const resolvedIds = resolvedUpdates.map(u => u.id)

    if (resolvedIds.length > 0) {
      await prisma.$transaction(
        resolvedUpdates.map(u =>
          prisma.auditFeedback.update({
            where: { id: u.id },
            data: {
              isResolved: true,
              resolvedAt: new Date(),
              resolvedBy: 'DOCTOR',
              resolvedAction: 'AUTO',
              newValue: u.newValue,
            },
          })
        )
      )
    }

    const unresolvedFieldFeedbacks = await prisma.auditFeedback.count({
      where: { reportId: report.id, isResolved: false, fieldName: { not: null } },
    })

    const overallFeedbacks = allFeedbacks.filter(f => !f.fieldName && !f.isResolved)
    let finalResolvedCount = resolvedIds.length
    let newReportStatus = updated.status

    if (report.status === ReportStatus.NEEDS_REVISION && (resolvedIds.length > 0 || unresolvedFieldFeedbacks === 0)) {
      // 医生完成整改 → 进入待审核员确认阶段（PENDING_VERIFICATION）
      // 不自动通过总评，留到审核员逐条确认通过后再处理
      newReportStatus = ReportStatus.PENDING_VERIFICATION
      const tasks = await prisma.auditTask.findMany({
        where: { reportId: report.id, status: { in: ['IN_PROGRESS', 'PENDING'] } },
      })
      if (tasks.length > 0) {
        await prisma.auditTask.updateMany({
          where: { id: { in: tasks.map(t => t.id) } },
          data: { status: 'IN_PROGRESS' },
        })
      }
      await prisma.report.update({
        where: { id: report.id },
        data: { status: newReportStatus },
      })
      updated.status = newReportStatus
    }

    return res.json({ report: updated, resolvedCount: finalResolvedCount, nextStatus: newReportStatus })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: '参数验证失败', details: err.errors })
    }
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      status,
      type,
      clinicId,
      submitterId,
      startDate,
      endDate,
      page = '1',
      pageSize = '20',
    } = req.query

    const userRole = req.user!.role
    const qcRoles = [UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR] as string[]

    const where: any = {}

    if (!qcRoles.includes(userRole)) {
      where.clinicId = req.user!.clinicId
      if (userRole === UserRole.CLINIC_DOCTOR) {
        where.submitterId = req.user!.userId
      }
    } else {
      if (clinicId) where.clinicId = clinicId as string
      if (submitterId) where.submitterId = submitterId as string
    }

    if (status) where.status = status as ReportStatus
    if (type) where.type = type as ReportType
    if (startDate) where.createdAt = { ...where.createdAt, gte: new Date(startDate as string) }
    if (endDate) where.createdAt = { ...where.createdAt, lte: new Date(endDate as string) }

    const pageNum = Math.max(1, parseInt(page as string))
    const size = Math.min(100, Math.max(1, parseInt(pageSize as string)))
    const skip = (pageNum - 1) * size

    const [total, reports] = await Promise.all([
      prisma.report.count({ where }),
      prisma.report.findMany({
        where,
        skip,
        take: size,
        include: {
          clinic: { select: { id: true, name: true, code: true } },
          submitter: { select: { id: true, name: true } },
          ruleChecks: { orderBy: { severity: 'desc' } },
          auditTasks: {
            include: {
              assignedTo: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    return res.json({
      total,
      page: pageNum,
      pageSize: size,
      list: reports,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const report = await prisma.report.findUnique({
      where: { id: req.params.id },
      include: {
        clinic: { select: { id: true, name: true, code: true } },
        submitter: { select: { id: true, name: true, username: true } },
        ruleChecks: { orderBy: { severity: 'desc', createdAt: 'desc' } },
        auditTasks: {
          include: {
            assignedTo: { select: { id: true, name: true } },
            assignedBy: { select: { id: true, name: true } },
            feedbacks: {
              include: { auditor: { select: { id: true, name: true } } },
              orderBy: { createdAt: 'asc' },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
        parentReport: { select: { id: true, reportNo: true, version: true } },
        childReports: { select: { id: true, reportNo: true, version: true, createdAt: true, status: true } },
      },
    })

    if (!report) return res.status(404).json({ error: '报告不存在' })

    const qcRoles = [UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR] as string[]
    if (!qcRoles.includes(req.user!.role) && report.clinicId !== req.user!.clinicId) {
      return res.status(403).json({ error: '无权访问' })
    }
    return res.json(report)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.get('/:id/rule-checks', async (req: AuthRequest, res: Response) => {
  try {
    const report = await prisma.report.findUnique({ where: { id: req.params.id } })
    if (!report) return res.status(404).json({ error: '报告不存在' })

    const qcRoles = [UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR] as string[]
    if (!qcRoles.includes(req.user!.role) && report.clinicId !== req.user!.clinicId) {
      return res.status(403).json({ error: '无权访问' })
    }

    const checks = await prisma.ruleCheckResult.findMany({
      where: { reportId: req.params.id },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
    })

    const latest = checks.reduce((acc, c) => {
      if (!acc[c.ruleCode] || acc[c.ruleCode].createdAt < c.createdAt) {
        acc[c.ruleCode] = c
      }
      return acc
    }, {} as Record<string, typeof checks[0]>)

    const result = Object.values(latest)
    return res.json({
      total: result.length,
      errorCount: result.filter(c => c.severity === RuleSeverity.ERROR && !c.passed).length,
      warningCount: result.filter(c => c.severity === RuleSeverity.WARNING && !c.passed).length,
      list: result,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.get('/:id/feedbacks', async (req: AuthRequest, res: Response) => {
  try {
    const report = await prisma.report.findUnique({ where: { id: req.params.id } })
    if (!report) return res.status(404).json({ error: '报告不存在' })

    const qcRoles = [UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR] as string[]
    if (!qcRoles.includes(req.user!.role) && report.clinicId !== req.user!.clinicId) {
      return res.status(403).json({ error: '无权访问' })
    }

    const feedbacks = await prisma.auditFeedback.findMany({
      where: { reportId: req.params.id },
      include: {
        auditor: { select: { id: true, name: true } },
        task: { select: { id: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    const enriched = feedbacks.map(fb => {
      const currentValue = fb.fieldName
        ? ((report as Record<string, unknown>)[fb.fieldName]?.toString() || '')
        : undefined
      const diff = fb.fieldName ? {
        before: fb.oldValue || '',
        afterDoctorEdit: fb.newValue || '',
        currentReport: currentValue || '',
        changed: (fb.oldValue || '') !== (currentValue || ''),
      } : undefined
      return { ...fb, diff }
    })

    return res.json(enriched)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.post('/:id/rule-checks/rerun', requireRole(UserRole.QC_MANAGER, UserRole.QC_AUDITOR), async (req: AuthRequest, res: Response) => {
  try {
    const report = await prisma.report.findUnique({ where: { id: req.params.id } })
    if (!report) return res.status(404).json({ error: '报告不存在' })

    // 1) 创建批次（单报告批次）
    const batchNo = `RERUN-${dayjs().format('YYYYMMDD-HHmmss-SSS')}`
    const batch = await prisma.ruleRerunBatch.create({
      data: {
        batchNo,
        triggeredById: req.user!.userId,
        triggerType: 'MANUAL',
        note: (req.body as any)?.note || null,
      },
    })

    // 2) 读取旧检查结果（用于 diff 计算）
    const oldResults = await prisma.ruleCheckResult.findMany({ where: { reportId: report.id } })
    const oldKeySet = new Set(
      oldResults.filter(r => !r.passed).map(r => `${r.ruleCode}:${r.fieldName || 'NULL'}`)
    )

    // 3) 跑规则
    const { issues, configs } = await runAllRules(report as any, { useConfigs: true })
    const ruleSnapshot = configs ? JSON.stringify(configs) : null
    const dbRecords = issuesToDbRecords(report.id, issues, { ruleSnapshot, batchId: batch.id })

    // 4) 替换旧结果
    await prisma.ruleCheckResult.deleteMany({ where: { reportId: report.id } })
    await prisma.ruleCheckResult.createMany({ data: dbRecords })

    // 5) diff：新增问题 vs 消失问题
    const newKeySet = new Set(
      dbRecords.filter(r => !r.passed).map(r => `${r.ruleCode}:${r.fieldName || 'NULL'}`)
    )
    const newIssues: string[] = []
    const removedIssues: string[] = []
    newKeySet.forEach(k => { if (!oldKeySet.has(k)) newIssues.push(k) })
    oldKeySet.forEach(k => { if (!newKeySet.has(k)) removedIssues.push(k) })
    const changedCount = (newIssues.length > 0 || removedIssues.length > 0) ? 1 : 0

    // 6) 更新批次统计 + 状态
    const hasErrors = issues.some(i => i.severity === RuleSeverity.ERROR && !i.passed)
    const newStatus = hasErrors ? ReportStatus.RULE_CHECK_FAILED : ReportStatus.RULE_CHECK_PASSED
    await Promise.all([
      prisma.report.update({ where: { id: report.id }, data: { status: newStatus } }),
      prisma.ruleRerunBatch.update({
        where: { id: batch.id },
        data: {
          ruleSnapshot,
          reportIds: JSON.stringify([report.id]),
          affectedCount: 1,
          newIssueCount: newIssues.length,
          removedCount: removedIssues.length,
          changedCount,
        },
      }),
    ])

    return res.json({
      status: newStatus,
      total: dbRecords.length,
      batchId: batch.id,
      batchNo,
      diff: {
        new: newIssues,
        removed: removedIssues,
        changedReports: changedCount,
      },
      ruleChecks: {
        passed: !hasErrors,
        errorCount: issues.filter(i => i.severity === RuleSeverity.ERROR && !i.passed).length,
        warningCount: issues.filter(i => i.severity === RuleSeverity.WARNING && !i.passed).length,
        details: issues,
      },
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// 批量重跑（按日期范围/门店/检查类型/报告ID列表）
router.post('/rule-checks/batch-rerun', requireRole(UserRole.QC_MANAGER), async (req: AuthRequest, res: Response) => {
  try {
    const schema = z.object({
      reportIds: z.array(z.string()).optional(),
      fromDate: z.string().optional(),   // YYYY-MM-DD
      toDate: z.string().optional(),
      clinicId: z.string().optional(),
      reportType: z.string().optional(),
      statusIn: z.array(z.string()).optional(),
      includeAll: z.boolean().default(false),
      note: z.string().max(500).optional(),
      maxCount: z.number().int().min(1).max(2000).default(200),
    })
    const body = schema.parse(req.body)
    const triggeredById = req.user!.userId

    // 构造查询条件
    const where: any = {}
    if (body.reportIds && body.reportIds.length > 0) where.id = { in: body.reportIds }
    if (body.clinicId) where.clinicId = body.clinicId
    if (body.reportType) where.type = body.reportType
    if (body.fromDate) where.createdAt = { ...(where.createdAt || {}), gte: new Date(body.fromDate) }
    if (body.toDate) where.createdAt = { ...(where.createdAt || {}), lte: dayjs(body.toDate).add(1, 'day').toDate() }
    if (body.statusIn && body.statusIn.length > 0) where.status = { in: body.statusIn }

    // 至少要指定一种筛选条件，避免误操作
    const hasFilter =
      (body.reportIds && body.reportIds.length > 0) ||
      !!body.fromDate || !!body.toDate || !!body.clinicId ||
      !!body.reportType || (body.statusIn && body.statusIn.length > 0) ||
      body.includeAll === true
    if (!hasFilter) {
      return res.status(400).json({ error: '请指定至少一个筛选条件，或显式传 includeAll=true' })
    }

    const candidateReports = await prisma.report.findMany({
      where,
      select: { id: true, reportNo: true, status: true, type: true, clinicId: true, createdAt: true },
      take: body.maxCount,
      orderBy: { createdAt: 'desc' },
    })
    if (candidateReports.length === 0) {
      return res.json({ total: 0, changedCount: 0, message: '没有符合条件的报告' })
    }

    // 创建批次
    const batchNo = `BATCH-${dayjs().format('YYYYMMDD-HHmmss-SSS')}`
    const batch = await prisma.ruleRerunBatch.create({
      data: {
        batchNo,
        triggeredById,
        triggerType: 'MANUAL',
        note: body.note || null,
        reportIds: JSON.stringify(candidateReports.map(r => r.id)),
        affectedCount: candidateReports.length,
      },
    })

    // 逐份处理
    let newIssueCount = 0, removedCount = 0, changedCount = 0
    const affectedDetail: any[] = []

    for (const rpt of candidateReports as any[]) {
      const report = await prisma.report.findUnique({ where: { id: rpt.id } })
      if (!report) continue

      const oldResults = await prisma.ruleCheckResult.findMany({ where: { reportId: report.id } })
      const oldKeySet = new Set(
        oldResults.filter(r => !r.passed).map(r => `${r.ruleCode}:${r.fieldName || 'NULL'}`)
      )

      const { issues, configs } = await runAllRules(report as any, { useConfigs: true })
      const ruleSnapshot = (batch as any).ruleSnapshot || configs ? JSON.stringify(configs) : null
      if (!(batch as any).ruleSnapshot) {
        // 仅在第一次存快照，保证整批次使用同一快照
        await prisma.ruleRerunBatch.update({ where: { id: batch.id }, data: { ruleSnapshot } })
      }
      const dbRecords = issuesToDbRecords(report.id, issues, { ruleSnapshot, batchId: batch.id })

      await prisma.ruleCheckResult.deleteMany({ where: { reportId: report.id } })
      await prisma.ruleCheckResult.createMany({ data: dbRecords })

      const newKeySet = new Set(
        dbRecords.filter(r => !r.passed).map(r => `${r.ruleCode}:${r.fieldName || 'NULL'}`)
      )
      const newList: string[] = [], removedList: string[] = []
      newKeySet.forEach(k => { if (!oldKeySet.has(k)) newList.push(k) })
      oldKeySet.forEach(k => { if (!newKeySet.has(k)) removedList.push(k) })
      newIssueCount += newList.length
      removedCount += removedList.length
      if (newList.length > 0 || removedList.length > 0) {
        changedCount++
        affectedDetail.push({
          reportId: rpt.id, reportNo: rpt.reportNo,
          newIssues: newList, removedIssues: removedList,
          oldStatus: rpt.status,
        })
      }

      // 更新报告状态
      const hasErrors = issues.some(i => i.severity === RuleSeverity.ERROR && !i.passed)
      const newStatus = hasErrors ? ReportStatus.RULE_CHECK_FAILED : ReportStatus.RULE_CHECK_PASSED
      await prisma.report.update({ where: { id: report.id }, data: { status: newStatus } })
    }

    await prisma.ruleRerunBatch.update({
      where: { id: batch.id },
      data: { newIssueCount, removedCount, changedCount },
    })

    return res.json({
      batchId: batch.id,
      batchNo,
      total: candidateReports.length,
      changedCount,
      newIssueCount,
      removedCount,
      affectedSample: affectedDetail.slice(0, 50),
    })
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: '参数验证失败', details: err.errors })
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// 批次列表查询
router.get('/rule-checks/batches', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR), async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', pageSize = '20', triggeredById, triggerType } = req.query
    const pageNum = Math.max(1, parseInt(page as string))
    const size = Math.min(200, Math.max(1, parseInt(pageSize as string)))
    const skip = (pageNum - 1) * size

    const where: any = {}
    if (triggeredById) where.triggeredById = triggeredById as string
    if (triggerType) where.triggerType = triggerType as string

    const [total, list] = await Promise.all([
      prisma.ruleRerunBatch.count({ where }),
      prisma.ruleRerunBatch.findMany({
        where,
        skip, take: size,
        orderBy: { createdAt: 'desc' },
        include: {
          triggeredBy: { select: { id: true, name: true, role: true } },
          _count: { select: { ruleChecks: true } },
        },
      }),
    ])

    return res.json({
      total, page: pageNum, pageSize: size,
      list: (list as any[]).map(b => ({
        ...b,
        ruleCheckCount: b._count.ruleChecks,
        _count: undefined,
      })),
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

// 批次详情（含影响报告、差异明细、规则快照）
router.get('/rule-checks/batches/:id', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR), async (req: AuthRequest, res: Response) => {
  try {
    const batch = await prisma.ruleRerunBatch.findUnique({
      where: { id: req.params.id },
      include: { triggeredBy: { select: { id: true, name: true, role: true } } },
    })
    if (!batch) return res.status(404).json({ error: '批次不存在' })

    // 报告 ID 列表
    let reportIds: string[] = []
    try { reportIds = batch.reportIds ? JSON.parse(batch.reportIds) : [] } catch {}

    // 汇总影响的报告（及其这次规则检查结果 vs 上次的差异）
    const reports = await prisma.report.findMany({
      where: { id: { in: reportIds.slice(0, 200) } },
      include: {
        clinic: { select: { id: true, name: true, code: true } },
        submitter: { select: { id: true, name: true } },
        ruleChecks: { where: { batchId: batch.id } },
      },
    })

    return res.json({
      batch: {
        id: batch.id, batchNo: batch.batchNo,
        triggerType: batch.triggerType,
        note: batch.note, createdAt: batch.createdAt,
        triggeredBy: batch.triggeredBy,
        affectedCount: batch.affectedCount,
        newIssueCount: batch.newIssueCount,
        removedCount: batch.removedCount,
        changedCount: batch.changedCount,
        ruleSnapshot: batch.ruleSnapshot ? JSON.parse(batch.ruleSnapshot) : null,
      },
      reportCount: reportIds.length,
      reports: reports.map(r => ({
        id: r.id, reportNo: r.reportNo, type: r.type,
        status: r.status,
        clinic: r.clinic, submitter: r.submitter,
        ruleChecks: r.ruleChecks,
        errorCount: r.ruleChecks.filter(c => !c.passed && c.severity === 'ERROR').length,
        warningCount: r.ruleChecks.filter(c => !c.passed && c.severity === 'WARNING').length,
      })),
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

export default router
