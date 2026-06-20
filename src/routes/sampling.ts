import { Router, Response } from 'express'
import { z } from 'zod'
import prisma from '../lib/prisma'
import { authenticate, AuthRequest, requireRole } from '../middleware/auth'
import { ReportType, UserRole } from '../lib/enums'

const router = Router()

router.use(authenticate)
router.use(requireRole(UserRole.ADMIN, UserRole.QC_MANAGER))

const createRuleSchema = z.object({
  name: z.string().min(1, '规则名称不能为空'),
  clinicId: z.string().optional().nullable(),
  auditorId: z.string().optional().nullable(),
  reportType: z.nativeEnum(ReportType).optional().nullable(),
  submitterId: z.string().optional().nullable(),
  samplingRate: z.number().min(0).max(1, '抽检比例必须在 0-1 之间'),
  priority: z.number().int().default(0),
  isActive: z.boolean().default(true),
})

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const body = createRuleSchema.parse(req.body)
    const rule = await prisma.samplingRule.create({
      data: {
        ...body,
        createdById: req.user!.userId,
      },
      include: {
        clinic: { select: { id: true, name: true } },
        auditor: { select: { id: true, name: true } },
        submitter: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
    })
    return res.status(201).json(rule)
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
    const { clinicId, isActive } = req.query
    const where: any = {}
    if (clinicId) where.clinicId = clinicId as string
    if (isActive !== undefined) where.isActive = isActive === 'true'

    const rules = await prisma.samplingRule.findMany({
      where,
      include: {
        clinic: { select: { id: true, name: true } },
        auditor: { select: { id: true, name: true } },
        submitter: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    })
    return res.json(rules)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const body = createRuleSchema.partial().parse(req.body)
    const { name, ...rest } = body
    const rule = await prisma.samplingRule.update({
      where: { id: req.params.id },
      data: { ...(name ? { name } : {}), ...rest },
      include: {
        clinic: { select: { id: true, name: true } },
        auditor: { select: { id: true, name: true } },
        submitter: { select: { id: true, name: true } },
      },
    })
    return res.json(rule)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: '参数验证失败', details: err.errors })
    }
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    await prisma.samplingRule.delete({ where: { id: req.params.id } })
    return res.json({ success: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

export default router
