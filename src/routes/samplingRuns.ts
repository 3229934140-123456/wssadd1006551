import { Router, Request, Response } from 'express'
import { z } from 'zod'
import prisma from '../lib/prisma'
import { authenticate, AuthRequest, requireRole } from '../middleware/auth'
import { UserRole, SamplingTriggerType } from '../lib/enums'
import { generateDailyTasks } from '../services/taskGenerator'

const router = Router()
router.use(authenticate)
router.use(requireRole(UserRole.ADMIN, UserRole.QC_MANAGER))

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      page = '1',
      pageSize = '20',
      startDate,
      endDate,
      triggerType,
      status,
    } = req.query
    const where: any = {}
    if (startDate || endDate) {
      where.taskDate = {}
      if (startDate) where.taskDate.gte = new Date(startDate as string)
      if (endDate) where.taskDate.lt = new Date(new Date(endDate as string).getTime() + 86400000)
    }
    if (triggerType) where.triggerType = triggerType as string
    if (status) where.status = status as string

    const pageNum = Math.max(1, parseInt(page as string))
    const size = Math.min(100, Math.max(1, parseInt(pageSize as string)))
    const skip = (pageNum - 1) * size

    const [total, runs] = await Promise.all([
      prisma.samplingRun.count({ where }),
      prisma.samplingRun.findMany({
        where,
        skip,
        take: size,
        include: {
          triggeredBy: { select: { id: true, name: true, username: true } },
          _count: { select: { items: true } },
        },
        orderBy: [{ taskDate: 'desc' }, { createdAt: 'desc' }],
      }),
    ])

    const list = (runs as any[]).map((r: any) => ({
      ...r,
      selectedCount: r._count.items,
    }))

    return res.json({
      total,
      page: pageNum,
      pageSize: size,
      list,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const run = await prisma.samplingRun.findUnique({
      where: { id: req.params.id },
      include: {
        triggeredBy: { select: { id: true, name: true, username: true } },
      },
    })
    if (!run) return res.status(404).json({ error: '记录不存在' })

    const items = await prisma.samplingRunItem.findMany({
      where: { runId: req.params.id },
      orderBy: [{ selected: 'desc' }, { createdAt: 'asc' }],
      take: 500,
    })

    const stats = {
      totalItems: items.length,
      selectedCount: items.filter((i: any) => i.selected).length,
      existingCount: items.filter((i: any) => i.existingTask).length,
      newCreatedCount: items.filter((i: any) => i.selected && !i.existingTask).length,
      byRule: items
        .filter((i: any) => i.selected)
        .reduce((acc: Record<string, number>, i: any) => {
          const k = i.matchedRuleName || '默认兜底规则(10%)'
          acc[k] = (acc[k] || 0) + 1
          return acc
        }, {}),
    }

    return res.json({ run, items, stats })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.get('/:id/items', async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', pageSize = '50', selected } = req.query
    const where: any = { runId: req.params.id }
    if (selected !== undefined) where.selected = selected === 'true'

    const pageNum = Math.max(1, parseInt(page as string))
    const size = Math.min(500, Math.max(1, parseInt(pageSize as string)))
    const skip = (pageNum - 1) * size

    const [total, items] = await Promise.all([
      prisma.samplingRunItem.count({ where }),
      prisma.samplingRunItem.findMany({
        where,
        skip,
        take: size,
        orderBy: [{ selected: 'desc' }, { priority: 'desc' }],
      }),
    ])

    return res.json({ total, page: pageNum, pageSize: size, list: items })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

const regenerateSchema = z.object({
  date: z.string().optional(),
  regenerateExisting: z.boolean().default(false),
  note: z.string().max(500).optional(),
})

router.post('/regenerate', async (req: AuthRequest, res: Response) => {
  try {
    const body = regenerateSchema.parse(req.body)
    const result = await generateDailyTasks(body.date ? new Date(body.date) : undefined, {
      triggeredById: req.user!.userId,
      triggerType: SamplingTriggerType.MANUAL,
      note: body.note || '人工按日期重新生成',
      regenerateExisting: body.regenerateExisting,
    })
    return res.json(result)
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

export default router
