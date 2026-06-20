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
      status, // NEEDS_REVISION | PENDING_VERIFICATION | RECTIFIED | REJECTED
      clinicId,
      submitterId,
      reportType,
      issueCategory,
      page = '1',
      pageSize = '20',
    } = req.query

    // 构造基础查询条件
    const baseWhere: any = {}
    if (clinicId) baseWhere.clinicId = clinicId as string
    if (submitterId) baseWhere.submitterId = submitterId as string
    if (reportType) baseWhere.type = reportType as string

    // 根据 status 过滤（REJECTED 是虚拟状态：有 resolvedAction='REJECTED' 的反馈）
    let statusWhere: any = {}
    if (status === 'REJECTED') {
      // 已退回：有被审核员退回的反馈
      baseWhere.OR = [
        { status: ReportStatus.NEEDS_REVISION },
        { status: ReportStatus.PENDING_VERIFICATION },
      ]
    } else if (status) {
      baseWhere.status = status as string
    }

    const pageNum = Math.max(1, parseInt(page as string))
    const size = Math.min(100, Math.max(1, parseInt(pageSize as string)))
    const skip = (pageNum - 1) * size

    // 查询报告，包含相关统计信息
    const reports = await prisma.report.findMany({
      where: baseWhere,
      skip,
      take: size,
      include: {
        clinic: { select: { id: true, name: true, code: true } },
        submitter: { select: { id: true, name: true } },
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
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    })

    // 如果指定了 issueCategory，进一步过滤
    let filteredReports = reports
    if (issueCategory) {
      filteredReports = reports.filter(r =>
        r.auditFeedbacks.some(fb => fb.issueCategory === issueCategory)
      )
    }
    // 如果是 REJECTED 状态，过滤出有被退回反馈的报告
    if (status === 'REJECTED') {
      filteredReports = filteredReports.filter(r =>
        r.auditFeedbacks.some(fb => fb.resolvedAction === 'REJECTED')
      )
    }

    // 计算总数（使用相同过滤逻辑）
    const totalQuery: any = { ...baseWhere }
    let total = await prisma.report.count({ where: totalQuery })
    if (issueCategory || status === 'REJECTED') {
      // 复杂过滤，用全量数据估算（或单独查询）
      const allIds = await prisma.report.findMany({
        where: baseWhere,
        select: { id: true, auditFeedbacks: true },
      })
      total = allIds.filter(r => {
        if (issueCategory && !r.auditFeedbacks.some(fb => fb.issueCategory === issueCategory)) return false
        if (status === 'REJECTED' && !r.auditFeedbacks.some(fb => fb.resolvedAction === 'REJECTED')) return false
        return true
      }).length
    }

    // 组装每条报告的汇总信息
    const list = filteredReports.map(r => {
      const fieldFeedbacks = r.auditFeedbacks.filter(fb => fb.fieldName != null)
      const totalField = fieldFeedbacks.length
      // 待确认数 = 未整改 或 已整改但审核员还没确认通过
      const pendingCount = fieldFeedbacks.filter(fb =>
        !fb.isResolved ||
        (fb.isResolved && fb.resolvedBy !== 'AUDITOR')
      ).length
      // 已退回数
      const rejectedCount = fieldFeedbacks.filter(fb => fb.resolvedAction === 'REJECTED').length
      // 最近整改时间
      const lastResolvedAt = fieldFeedbacks
        .filter(fb => fb.resolvedAt)
        .sort((a, b) => (b.resolvedAt?.getTime() || 0) - (a.resolvedAt?.getTime() || 0))[0]?.resolvedAt

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
        lastRevisedAt: lastResolvedAt || r.updatedAt,
        feedbackStats: {
          total: totalField,
          pendingVerification: pendingCount,
          rejected: rejectedCount,
          verifiedApproved: totalField - pendingCount - rejectedCount,
        },
        hasRejected: rejectedCount > 0,
        categories: [...new Set(r.auditFeedbacks.map(fb => fb.issueCategory))],
        updatedAt: r.updatedAt,
        createdAt: r.createdAt,
      }
    })

    // 状态分类统计
    const [totalReports, statsByStatus] = await Promise.all([
      prisma.report.count({
        where: { status: { in: ['NEEDS_REVISION', 'PENDING_VERIFICATION', 'RECTIFIED', 'REVISED'] } },
      }),
      prisma.report.groupBy({
        by: ['status'],
        where: { status: { in: ['NEEDS_REVISION', 'PENDING_VERIFICATION', 'RECTIFIED', 'REVISED'] } },
        _count: { status: true },
      }),
    ])

    // 有退回反馈的报告数（独立统计）
    const rejectedCount = await prisma.auditFeedback.findMany({
      where: { resolvedAction: 'REJECTED', isResolved: false },
      select: { reportId: true },
      distinct: ['reportId'],
    })

    const statusCounts: Record<string, number> = {}
    statsByStatus.forEach(s => { statusCounts[s.status] = s._count.status })

    return res.json({
      total,
      page: pageNum,
      pageSize: size,
      list,
      overview: {
        total: totalReports,
        needsRevision: statusCounts['NEEDS_REVISION'] || 0,
        pendingVerification: statusCounts['PENDING_VERIFICATION'] || 0,
        rectified: statusCounts['RECTIFIED'] || 0,
        rejected: rejectedCount.length,
      },
    })
  } catch (err) {
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

    const { issues, configs } = await runAllRules(report as any, { useConfigs: true })
    const ruleSnapshot = configs ? JSON.stringify(configs) : null
    const dbRecords = issuesToDbRecords(report.id, issues, { ruleSnapshot })
    await prisma.ruleCheckResult.deleteMany({ where: { reportId: report.id } })
    await prisma.ruleCheckResult.createMany({ data: dbRecords })

    const hasErrors = issues.some(i => i.severity === RuleSeverity.ERROR && !i.passed)
    const newStatus = hasErrors ? ReportStatus.RULE_CHECK_FAILED : ReportStatus.RULE_CHECK_PASSED
    await prisma.report.update({ where: { id: report.id }, data: { status: newStatus } })

    return res.json({
      status: newStatus,
      total: dbRecords.length,
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

export default router
