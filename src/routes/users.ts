import { Router, Response } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import prisma from '../lib/prisma'
import { authenticate, AuthRequest, requireRole } from '../middleware/auth'
import { UserRole } from '../lib/enums'

const router = Router()

router.use(authenticate)

router.get('/', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER), async (req: AuthRequest, res: Response) => {
  try {
    const { role, clinicId } = req.query
    const where: any = {}
    if (role) where.role = role as UserRole
    if (clinicId) where.clinicId = clinicId as string

    const users = await prisma.user.findMany({
      where,
      include: { clinic: true },
      orderBy: { createdAt: 'desc' },
    })

    return res.json(
      users.map(u => ({
        id: u.id,
        username: u.username,
        name: u.name,
        role: u.role,
        clinicId: u.clinicId,
        clinicName: u.clinic?.name,
        email: u.email,
        phone: u.phone,
        createdAt: u.createdAt,
      })),
    )
  } catch {
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.get('/auditors', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER), async (req: AuthRequest, res: Response) => {
  try {
    const auditors = await prisma.user.findMany({
      where: { role: { in: [UserRole.QC_MANAGER, UserRole.QC_AUDITOR] } },
      select: { id: true, name: true, username: true, role: true },
      orderBy: { name: 'asc' },
    })
    return res.json(auditors)
  } catch {
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

const createUserSchema = z.object({
  username: z.string().min(3, '用户名至少3位'),
  password: z.string().min(6, '密码至少6位'),
  name: z.string().min(1, '姓名不能为空'),
  role: z.nativeEnum(UserRole),
  clinicId: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
})

router.post('/', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER), async (req: AuthRequest, res: Response) => {
  try {
    const body = createUserSchema.parse(req.body)

    if (([UserRole.CLINIC_DOCTOR, UserRole.CLINIC_MANAGER] as string[]).includes(body.role) && !body.clinicId) {
      return res.status(400).json({ error: '门店医生必须关联门店' })
    }

    const existing = await prisma.user.findUnique({ where: { username: body.username } })
    if (existing) {
      return res.status(400).json({ error: '用户名已存在' })
    }

    const passwordHash = await bcrypt.hash(body.password, 10)
    const { password, ...data } = body
    const user = await prisma.user.create({
      data: { ...data, passwordHash },
      include: { clinic: true },
    })

    return res.status(201).json({
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      clinicId: user.clinicId,
      clinicName: user.clinic?.name,
    })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: '参数验证失败', details: err.errors })
    }
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

export default router
