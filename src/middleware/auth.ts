import { Request, Response, NextFunction } from 'express'
import { verifyToken, JwtPayload } from '../lib/jwt'
import { UserRole } from '../lib/enums'

export interface AuthRequest extends Request {
  user?: JwtPayload
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未授权，请先登录' })
  }

  const token = authHeader.split(' ')[1]
  try {
    const payload = verifyToken(token)
    req.user = payload
    next()
  } catch {
    return res.status(401).json({ error: 'Token 无效或已过期' })
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: '未授权' })
    }
    const hasRole = roles.includes(req.user.role as UserRole)
    if (!hasRole) {
      return res.status(403).json({ error: '权限不足，无法执行此操作' })
    }
    next()
  }
}

export function requireSameClinicOrQc(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: '未授权' })
  }
  const qcRoles = [UserRole.ADMIN, UserRole.QC_MANAGER, UserRole.QC_AUDITOR] as string[]
  if (qcRoles.includes(req.user.role)) {
    return next()
  }
  const targetClinicId = req.params.clinicId || req.body.clinicId
  if (targetClinicId && req.user.clinicId === targetClinicId) {
    return next()
  }
  return res.status(403).json({ error: '只能访问本门店数据' })
}
