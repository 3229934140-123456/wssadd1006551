import { Router, Response } from 'express'
import prisma from '../lib/prisma'
import { authenticate, AuthRequest, requireRole } from '../middleware/auth'
import { IssueCategory, ReportStatus, ReportType, UserRole } from '../lib/enums'
import dayjs from 'dayjs'

const router = Router()

router.use(authenticate)
router.use(requireRole(UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR))

router.get('/overview', async (req: AuthRequest, res: Response) => {
  try {
    const { startDate, endDate } = req.query
    const start = startDate ? new Date(startDate as string) : dayjs().subtract(30, 'day').toDate()
    const end = endDate ? new Date(endDate as string) : new Date()

    const where = { createdAt: { gte: start, lte: end } }

    const [
      totalReports,
      reportsByType,
      reportsByStatus,
      reportsByClinic,
      errorReports,
      auditTasks,
      feedbacks,
      unresolvedFeedbackByCategory,
    ] = await Promise.all([
      prisma.report.count({ where }),
      prisma.report.groupBy({ by: ['type'], where, _count: true }),
      prisma.report.groupBy({ by: ['status'], where, _count: true }),
      prisma.report.groupBy({ by: ['clinicId'], where, _count: true, orderBy: { _count: { id: 'desc' } }, take: 10 }),
      prisma.report.count({
        where: {
          ...where,
          ruleChecks: { some: { severity: 'ERROR', passed: false } },
        },
      }),
      prisma.auditTask.count({ where: { taskDate: { gte: start, lte: end } } }),
      prisma.auditFeedback.count({ where: { createdAt: { gte: start, lte: end } } }),
      prisma.auditFeedback.groupBy({
        by: ['issueCategory'],
        where: { createdAt: { gte: start, lte: end }, isResolved: false },
        _count: true,
        orderBy: { _count: { id: 'desc' } },
      }),
    ])

    const clinicIds = reportsByClinic.map(r => r.clinicId)
    const clinics = await prisma.clinic.findMany({
      where: { id: { in: clinicIds } },
      select: { id: true, name: true, code: true },
    })
    const clinicMap = new Map(clinics.map(c => [c.id, c]))

    return res.json({
      period: { start, end },
      totalReports,
      errorRate: totalReports > 0 ? (errorReports / totalReports) : 0,
      auditCoverage: totalReports > 0 ? (auditTasks / totalReports) : 0,
      reportsByType: reportsByType.map(r => ({ type: r.type as ReportType, count: r._count })),
      reportsByStatus: reportsByStatus.map(r => ({ status: r.status as ReportStatus, count: r._count })),
      reportsByClinic: reportsByClinic.map(r => ({
        clinicId: r.clinicId,
        clinicName: clinicMap.get(r.clinicId)?.name || '未知',
        clinicCode: clinicMap.get(r.clinicId)?.code,
        count: r._count,
      })),
      auditTasks,
      totalFeedbacks: feedbacks,
      unresolvedFeedbackByCategory: unresolvedFeedbackByCategory.map(r => ({
        category: r.issueCategory as IssueCategory,
        count: r._count,
      })),
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.get('/by-clinic/:clinicId', async (req: AuthRequest, res: Response) => {
  try {
    const { startDate, endDate } = req.query
    const start = startDate ? new Date(startDate as string) : dayjs().subtract(30, 'day').toDate()
    const end = endDate ? new Date(endDate as string) : new Date()

    const where = { createdAt: { gte: start, lte: end }, clinicId: req.params.clinicId }

    const [total, byDoctor, byStatus, withErrors, taskCount] = await Promise.all([
      prisma.report.count({ where }),
      prisma.report.groupBy({
        by: ['submitterId'],
        where,
        _count: true,
        orderBy: { _count: { id: 'desc' } },
      }),
      prisma.report.groupBy({ by: ['status'], where, _count: true }),
      prisma.report.count({
        where: {
          ...where,
          ruleChecks: { some: { severity: 'ERROR', passed: false } },
        },
      }),
      prisma.auditTask.count({
        where: { report: { clinicId: req.params.clinicId }, taskDate: { gte: start, lte: end } },
      }),
    ])

    const doctorIds = byDoctor.map(d => d.submitterId)
    const doctors = await prisma.user.findMany({
      where: { id: { in: doctorIds } },
      select: { id: true, name: true, username: true },
    })
    const doctorMap = new Map(doctors.map(d => [d.id, d]))

    const feedbacksByDoctor = await prisma.$queryRaw`
      SELECT u.id, u.name as "doctorName", COUNT(af.id) as "feedbackCount",
             SUM(CASE WHEN af."isResolved" = 0 THEN 1 ELSE 0 END) as "unresolvedCount"
      FROM "AuditFeedback" af
      JOIN "Report" r ON af."reportId" = r.id
      JOIN "User" u ON r."submitterId" = u.id
      WHERE r."clinicId" = ${req.params.clinicId}
        AND af."createdAt" >= ${start}
        AND af."createdAt" <= ${end}
      GROUP BY u.id, u.name
      ORDER BY "unresolvedCount" DESC
    ` as Array<{ id: string; doctorName: string; feedbackCount: number; unresolvedCount: number }>

    return res.json({
      period: { start, end },
      totalReports: total,
      reportsWithRuleErrors: withErrors,
      ruleErrorRate: total > 0 ? withErrors / total : 0,
      auditTaskCount: taskCount,
      byDoctor: byDoctor.map(d => ({
        doctorId: d.submitterId,
        doctorName: doctorMap.get(d.submitterId)?.name || '未知',
        reportCount: d._count,
      })),
      byStatus: byStatus.map(s => ({ status: s.status as ReportStatus, count: s._count })),
      feedbacksByDoctor,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.get('/issue-trends', async (req: AuthRequest, res: Response) => {
  try {
    const { days = '30' } = req.query
    const dayCount = Math.max(1, Math.min(90, parseInt(days as string)))
    const start = dayjs().subtract(dayCount - 1, 'day').startOf('day').toDate()

    const allCategories = Object.values(IssueCategory)
    const result = [] as Array<{ date: string; [key: string]: number | string }>

    for (let i = 0; i < dayCount; i++) {
      const d = dayjs(start).add(i, 'day')
      const dayStart = d.toDate()
      const dayEnd = d.add(1, 'day').toDate()
      const counts = await prisma.auditFeedback.groupBy({
        by: ['issueCategory'],
        where: { createdAt: { gte: dayStart, lt: dayEnd } },
        _count: true,
      })
      const dayRow: any = { date: d.format('YYYY-MM-DD') }
      allCategories.forEach(cat => (dayRow[cat] = 0))
      counts.forEach(c => (dayRow[c.issueCategory] = c._count))
      result.push(dayRow)
    }

    const categoryTotals = allCategories.map(cat => ({
      category: cat,
      total: result.reduce((acc, r) => acc + ((r[cat] as number) || 0), 0),
    })).sort((a, b) => b.total - a.total)

    return res.json({
      categories: allCategories,
      trends: result,
      categoryTotals,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

export default router
