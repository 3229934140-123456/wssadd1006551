import { Router, Response } from 'express'
import { z } from 'zod'
import prisma from '../lib/prisma'
import { authenticate, AuthRequest, requireRole } from '../middleware/auth'
import { UserRole } from '../lib/enums'

const router = Router()

router.use(authenticate)

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const qcRoles = [UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR] as string[]
    const where = qcRoles.includes(req.user!.role)
      ? {}
      : { id: req.user!.clinicId! }

    const clinics = await prisma.clinic.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })
    return res.json(clinics)
  } catch {
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

const createClinicSchema = z.object({
  name: z.string().min(1, '门店名称不能为空'),
  code: z.string().min(1, '门店编码不能为空'),
  address: z.string().optional(),
  phone: z.string().optional(),
})

router.post('/', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER), async (req: AuthRequest, res: Response) => {
  try {
    const body = createClinicSchema.parse(req.body)
    const existing = await prisma.clinic.findUnique({ where: { code: body.code } })
    if (existing) {
      return res.status(400).json({ error: '门店编码已存在' })
    }
    const clinic = await prisma.clinic.create({ data: body })
    return res.status(201).json(clinic)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: '参数验证失败', details: err.errors })
    }
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const clinic = await prisma.clinic.findUnique({ where: { id: req.params.id } })
    if (!clinic) {
      return res.status(404).json({ error: '门店不存在' })
    }
    const qcRoles = [UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR] as string[]
    if (!qcRoles.includes(req.user!.role) && clinic.id !== req.user!.clinicId) {
      return res.status(403).json({ error: '无权访问' })
    }
    return res.json(clinic)
  } catch {
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.get('/:id/doctors', async (req: AuthRequest, res: Response) => {
  try {
    const clinic = await prisma.clinic.findUnique({ where: { id: req.params.id } })
    if (!clinic) {
      return res.status(404).json({ error: '门店不存在' })
    }
    const qcRoles = [UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR] as string[]
    if (!qcRoles.includes(req.user!.role) && clinic.id !== req.user!.clinicId) {
      return res.status(403).json({ error: '无权访问' })
    }
    const doctors = await prisma.user.findMany({
      where: {
        clinicId: req.params.id,
        role: { in: [UserRole.CLINIC_DOCTOR, UserRole.CLINIC_MANAGER] },
      },
      select: { id: true, name: true, username: true, role: true, email: true },
    })
    return res.json(doctors)
  } catch {
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

export default router
