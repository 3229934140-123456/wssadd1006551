import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import prisma from '../lib/prisma'
import { signToken } from '../lib/jwt'
import { authenticate, AuthRequest } from '../middleware/auth'

const router = Router()

const loginSchema = z.object({
  username: z.string().min(1, '用户名不能为空'),
  password: z.string().min(1, '密码不能为空'),
})

router.post('/login', async (req: Request, res: Response) => {
  try {
    const body = loginSchema.parse(req.body)
    const user = await prisma.user.findUnique({
      where: { username: body.username },
      include: { clinic: true },
    })

    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' })
    }

    const isValid = await bcrypt.compare(body.password, user.passwordHash)
    if (!isValid) {
      return res.status(401).json({ error: '用户名或密码错误' })
    }

    const token = signToken({
      userId: user.id,
      role: user.role,
      username: user.username,
      clinicId: user.clinicId,
    })

    return res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        clinicId: user.clinicId,
        clinicName: user.clinic?.name,
        email: user.email,
        phone: user.phone,
      },
    })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: '参数验证失败', details: err.errors })
    }
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: { clinic: true },
    })
    if (!user) {
      return res.status(404).json({ error: '用户不存在' })
    }
    return res.json({
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      clinicId: user.clinicId,
      clinicName: user.clinic?.name,
      email: user.email,
      phone: user.phone,
    })
  } catch {
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

export default router
