import { Router, Response } from 'express'
import { z } from 'zod'
import prisma from '../lib/prisma'
import { authenticate, AuthRequest, requireRole } from '../middleware/auth'
import { IssueCategory, ReportStatus, TaskStatus, UserRole } from '../lib/enums'
import { generateDailyTasks, generateManualTask } from '../services/taskGenerator'

const router = Router()

router.use(authenticate)

const issueLabelMap: Record<IssueCategory, string[]> = {
  [IssueCategory.TOOTH_POSITION_FORMAT]: ['牙位标注不规范', '未使用 FDI 编号', '象限编号错误'],
  [IssueCategory.EXAM_NAME_MISSING]: ['检查名称缺失', '检查名称不统一'],
  [IssueCategory.DIAGNOSIS_INCOMPLETE]: ['诊断缺项', '只写炎症没写牙位', '诊断描述不完整'],
  [IssueCategory.RECOMMENDATION_MISMATCH]: ['建议缺项', '建议与影像不匹配'],
  [IssueCategory.TERMINOLOGY_INCONSISTENT]: ['术语不统一', '使用非标准术语', '口语化表达'],
  [IssueCategory.CONCLUSION_TOO_GENERAL]: ['结论过于笼统', '结论无具体内容', '请结合临床滥用'],
  [IssueCategory.SUGGESTION_IMAGE_MISMATCH]: ['建议与影像不匹配', '建议方案不合理'],
  [IssueCategory.OTHER]: ['其他问题'],
}

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      status,
      assignedToId,
      taskDate,
      clinicId,
      reportId,
      page = '1',
      pageSize = '20',
    } = req.query

    const userRole = req.user!.role
    const qcRoles = [UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR] as string[]
    const isAuditor = qcRoles.includes(userRole)

    const where: any = {}

    if (!isAuditor) {
      where.report = { clinicId: req.user!.clinicId }
    } else {
      if (userRole === UserRole.QC_AUDITOR && !assignedToId) {
        where.OR = [
          { assignedToId: req.user!.userId },
          { status: TaskStatus.PENDING },
        ]
      }
      if (assignedToId) where.assignedToId = assignedToId as string
      if (clinicId) where.report = { ...where.report, clinicId: clinicId as string }
    }

    if (status) where.status = status as TaskStatus
    if (reportId) where.reportId = reportId as string
    if (taskDate) where.taskDate = new Date(taskDate as string)

    const pageNum = Math.max(1, parseInt(page as string))
    const size = Math.min(100, Math.max(1, parseInt(pageSize as string)))
    const skip = (pageNum - 1) * size

    const [total, tasks] = await Promise.all([
      prisma.auditTask.count({ where }),
      prisma.auditTask.findMany({
        where,
        skip,
        take: size,
        include: {
          report: {
            include: {
              clinic: { select: { id: true, name: true, code: true } },
              submitter: { select: { id: true, name: true } },
              ruleChecks: { where: { passed: false }, take: 3 },
            },
          },
          assignedTo: { select: { id: true, name: true, username: true } },
          assignedBy: { select: { id: true, name: true } },
          _count: { select: { feedbacks: { where: { isResolved: false } } } },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      }),
    ])

    return res.json({
      total,
      page: pageNum,
      pageSize: size,
      list: tasks,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.get('/stats', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId
    const role = req.user!.role
    const auditorId = role === UserRole.QC_AUDITOR ? userId : undefined

    const whereBase: any = {}
    if (auditorId) {
      whereBase.OR = [{ assignedToId: auditorId }, { status: TaskStatus.PENDING }]
    }

    const [pending, assigned, inProgress, completed, rectified, total] = await Promise.all([
      prisma.auditTask.count({ where: { ...whereBase, status: TaskStatus.PENDING } }),
      prisma.auditTask.count({ where: { ...whereBase, status: TaskStatus.ASSIGNED } }),
      prisma.auditTask.count({ where: { ...whereBase, status: TaskStatus.IN_PROGRESS } }),
      prisma.auditTask.count({ where: { ...whereBase, status: TaskStatus.COMPLETED } }),
      prisma.auditTask.count({ where: { ...whereBase, status: TaskStatus.RECTIFIED } }),
      prisma.auditTask.count(whereBase),
    ])

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayTasks = await prisma.auditTask.count({
      where: { ...whereBase, taskDate: { gte: today } },
    })
    const overdue = await prisma.auditTask.count({
      where: {
        ...whereBase,
        status: { in: [TaskStatus.PENDING, TaskStatus.ASSIGNED, TaskStatus.IN_PROGRESS] },
        taskDate: { lt: today },
      },
    })

    const unresolvedFeedbacks = await prisma.auditFeedback.count({
      where: {
        isResolved: false,
        task: auditorId ? { assignedToId: auditorId } : undefined,
      },
    })

    return res.json({
      total,
      pending,
      assigned,
      inProgress,
      completed,
      rectified,
      todayTasks,
      overdue,
      unresolvedFeedbacks,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.get('/issue-labels', (req: AuthRequest, res: Response) => {
  return res.json(issueLabelMap)
})

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const task = await prisma.auditTask.findUnique({
      where: { id: req.params.id },
      include: {
        report: {
          include: {
            clinic: { select: { id: true, name: true, code: true } },
            submitter: { select: { id: true, name: true, username: true } },
            ruleChecks: { orderBy: { severity: 'desc', createdAt: 'desc' } },
          },
        },
        assignedTo: { select: { id: true, name: true, username: true } },
        assignedBy: { select: { id: true, name: true } },
        feedbacks: {
          include: { auditor: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!task) return res.status(404).json({ error: '任务不存在' })

    const qcRoles = [UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR] as string[]
    if (!qcRoles.includes(req.user!.role) && task.report.clinicId !== req.user!.clinicId) {
      return res.status(403).json({ error: '无权访问' })
    }

    return res.json(task)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

const assignSchema = z.object({
  assignedToId: z.string().min(1, '审核员不能为空'),
})

router.post('/:id/assign', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER), async (req: AuthRequest, res: Response) => {
  try {
    const body = assignSchema.parse(req.body)
    const task = await prisma.auditTask.findUnique({ where: { id: req.params.id } })
    if (!task) return res.status(404).json({ error: '任务不存在' })
    if (!([TaskStatus.PENDING, TaskStatus.ASSIGNED] as string[]).includes(task.status)) {
      return res.status(400).json({ error: '当前状态无法分配' })
    }

    const auditor = await prisma.user.findUnique({ where: { id: body.assignedToId } })
    if (!auditor) return res.status(404).json({ error: '审核员不存在' })
    if (!([UserRole.QC_AUDITOR, UserRole.QC_MANAGER, UserRole.ADMIN] as string[]).includes(auditor.role)) {
      return res.status(400).json({ error: '该用户不是审核员角色' })
    }

    const updated = await prisma.auditTask.update({
      where: { id: req.params.id },
      data: {
        assignedToId: body.assignedToId,
        assignedById: req.user!.userId,
        assignedAt: new Date(),
        status: TaskStatus.ASSIGNED,
      },
      include: { assignedTo: { select: { id: true, name: true } } },
    })

    await prisma.report.update({
      where: { id: task.reportId },
      data: { status: ReportStatus.PENDING_AUDIT },
    })

    return res.json(updated)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: '参数验证失败', details: err.errors })
    }
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.post('/:id/start', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR), async (req: AuthRequest, res: Response) => {
  try {
    const task = await prisma.auditTask.findUnique({ where: { id: req.params.id } })
    if (!task) return res.status(404).json({ error: '任务不存在' })

    const role = req.user!.role
    if (role === UserRole.QC_AUDITOR && task.assignedToId && task.assignedToId !== req.user!.userId) {
      return res.status(403).json({ error: '这不是分配给你的任务' })
    }
    if (!([TaskStatus.PENDING, TaskStatus.ASSIGNED] as string[]).includes(task.status)) {
      return res.status(400).json({ error: '当前状态无法开始审核' })
    }

    const updateData: any = { status: TaskStatus.IN_PROGRESS, startedAt: new Date() }
    if (!task.assignedToId) {
      updateData.assignedToId = req.user!.userId
      updateData.assignedById = req.user!.userId
      updateData.assignedAt = new Date()
    }

    const updated = await prisma.auditTask.update({ where: { id: req.params.id }, data: updateData })
    await prisma.report.update({ where: { id: task.reportId }, data: { status: ReportStatus.IN_AUDIT } })

    return res.json(updated)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

const feedbackSchema = z.object({
  issueCategory: z.nativeEnum(IssueCategory),
  issueLabel: z.string().min(1, '问题标签不能为空'),
  fieldName: z.string().optional(),
  oldValue: z.string().optional(),
  modification: z.string().default(''),
  note: z.string().default(''),
})

router.post('/:id/feedback', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR), async (req: AuthRequest, res: Response) => {
  try {
    const body = feedbackSchema.parse(req.body)
    const task = await prisma.auditTask.findUnique({ where: { id: req.params.id } })
    if (!task) return res.status(404).json({ error: '任务不存在' })

    const role = req.user!.role
    if (role === UserRole.QC_AUDITOR && task.assignedToId !== req.user!.userId) {
      return res.status(403).json({ error: '这不是分配给你的任务' })
    }
    if (!([TaskStatus.IN_PROGRESS, TaskStatus.ASSIGNED] as string[]).includes(task.status)) {
      return res.status(400).json({ error: '请先开始审核后再提交反馈' })
    }

    const report = await prisma.report.findUnique({ where: { id: task.reportId } })
    if (!report) return res.status(404).json({ error: '关联报告不存在' })

    const oldValue = body.fieldName
      ? (body.oldValue || (report as Record<string, unknown>)[body.fieldName]?.toString() || '')
      : body.oldValue || ''

    const feedback = await prisma.auditFeedback.create({
      data: {
        taskId: task.id,
        reportId: task.reportId,
        auditorId: req.user!.userId,
        issueCategory: body.issueCategory,
        issueLabel: body.issueLabel,
        fieldName: body.fieldName,
        oldValue,
        modification: body.modification,
        note: body.note,
      },
      include: { auditor: { select: { id: true, name: true } } },
    })

    return res.status(201).json(feedback)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: '参数验证失败', details: err.errors })
    }
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.delete('/feedbacks/:feedbackId', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR), async (req: AuthRequest, res: Response) => {
  try {
    const fb = await prisma.auditFeedback.findUnique({ where: { id: req.params.feedbackId } })
    if (!fb) return res.status(404).json({ error: '反馈不存在' })
    if (fb.auditorId !== req.user!.userId && req.user!.role !== UserRole.ADMIN && req.user!.role !== UserRole.QC_MANAGER) {
      return res.status(403).json({ error: '只能删除自己的反馈' })
    }
    if (fb.isResolved) return res.status(400).json({ error: '已整改的反馈无法删除' })
    await prisma.auditFeedback.delete({ where: { id: req.params.feedbackId } })
    return res.json({ success: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

const completeSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT']),
  overallNote: z.string().default(''),
})

router.post('/:id/complete', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR), async (req: AuthRequest, res: Response) => {
  try {
    const body = completeSchema.parse(req.body)
    const task = await prisma.auditTask.findUnique({ where: { id: req.params.id } })
    if (!task) return res.status(404).json({ error: '任务不存在' })

    const role = req.user!.role
    if (role === UserRole.QC_AUDITOR && task.assignedToId !== req.user!.userId) {
      return res.status(403).json({ error: '这不是分配给你的任务' })
    }
    if (task.status !== TaskStatus.IN_PROGRESS) {
      return res.status(400).json({ error: '当前状态无法完成审核' })
    }

    const feedbacks = await prisma.auditFeedback.findMany({
      where: { taskId: task.id, isResolved: false },
    })

    let newReportStatus: ReportStatus
    if (body.action === 'APPROVE') {
      newReportStatus = ReportStatus.AUDIT_APPROVED
    } else {
      newReportStatus = feedbacks.length > 0 ? ReportStatus.NEEDS_REVISION : ReportStatus.AUDIT_APPROVED
    }

    if (body.overallNote) {
      await prisma.auditFeedback.create({
        data: {
          taskId: task.id,
          reportId: task.reportId,
          auditorId: req.user!.userId,
          issueCategory: IssueCategory.OTHER,
          issueLabel: '审核员总评',
          note: body.overallNote,
        },
      })
    }

    const updatedTask = await prisma.auditTask.update({
      where: { id: req.params.id },
      data: { status: TaskStatus.COMPLETED, completedAt: new Date() },
    })

    await prisma.report.update({
      where: { id: task.reportId },
      data: { status: newReportStatus },
    })

    return res.json({ task: updatedTask, reportStatus: newReportStatus, feedbackCount: feedbacks.length })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: '参数验证失败', details: err.errors })
    }
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

const createManualTaskSchema = z.object({
  reportId: z.string().min(1, '报告ID不能为空'),
  assignedToId: z.string().optional(),
})

router.post('/manual', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER), async (req: AuthRequest, res: Response) => {
  try {
    const body = createManualTaskSchema.parse(req.body)
    const taskId = await generateManualTask(body.reportId, body.assignedToId, req.user!.userId)
    const task = await prisma.auditTask.findUnique({
      where: { id: taskId },
      include: {
        report: { include: { clinic: { select: { id: true, name: true } } } },
        assignedTo: { select: { id: true, name: true } },
      },
    })
    return res.status(201).json(task)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: '参数验证失败', details: err.errors })
    }
    if (err instanceof Error) {
      return res.status(400).json({ error: err.message })
    }
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.post('/generate-daily', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER), async (req: AuthRequest, res: Response) => {
  try {
    const { date } = req.body as { date?: string }
    const result = await generateDailyTasks(date ? new Date(date) : undefined)
    return res.json(result)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.get('/:id/feedbacks', async (req: AuthRequest, res: Response) => {
  try {
    const task = await prisma.auditTask.findUnique({ where: { id: req.params.id } })
    if (!task) return res.status(404).json({ error: '任务不存在' })

    const feedbacks = await prisma.auditFeedback.findMany({
      where: { taskId: req.params.id },
      include: { auditor: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    })

    return res.json(feedbacks)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

export default router
