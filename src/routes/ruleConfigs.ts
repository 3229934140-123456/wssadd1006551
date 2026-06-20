import { Router, Request, Response } from 'express'
import { z } from 'zod'
import prisma from '../lib/prisma'
import { authenticate, AuthRequest, requireRole } from '../middleware/auth'
import {
  RuleCode,
  RuleDefinitions,
  RuleSeverity,
  ReportType,
  UserRole,
} from '../lib/enums'

const router = Router()
router.use(authenticate)

function getRuleMetaList(): {
  ruleCode: RuleCode
  ruleName: string
  description: string
  defaultSeverity: RuleSeverity
  reportTypes: (ReportType | null)[]
}[] {
  return (Object.values(RuleCode) as RuleCode[]).map(code => ({
    ruleCode: code,
    ruleName: RuleDefinitions[code].name,
    description: RuleDefinitions[code].description,
    defaultSeverity: RuleDefinitions[code].defaultSeverity,
    reportTypes: [null, ReportType.PANORAMIC_XRAY, ReportType.CBCT],
  }))
}

const createOrUpdateSchema = z.object({
  ruleCode: z.string().min(1),
  reportType: z.string().nullable().optional(),
  enabled: z.boolean(),
  severity: z.string().refine(s => Object.values(RuleSeverity).includes(s as any), '严重级别无效'),
})

const bulkUpdateSchema = z.array(createOrUpdateSchema)

router.get('/meta', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER), async (_req: Request, res: Response) => {
  try {
    return res.json(getRuleMetaList())
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.get('/', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER), async (req: AuthRequest, res: Response) => {
  try {
    const { reportType } = req.query
    const where: any = {}
    if (reportType) {
      where.OR = [{ reportType: reportType as string }, { reportType: null }]
    }
    const configs = await prisma.ruleConfig.findMany({
      where,
      include: { createdBy: { select: { id: true, name: true, username: true } } },
      orderBy: [{ ruleCode: 'asc' }, { reportType: 'asc' }],
    })
    const defaults = getRuleMetaList()
    const existingMap = new Map((configs as any[]).map((c: any) => [c.ruleCode + '|' + (c.reportType || 'GLOBAL'), c]))
    const merged: any[] = []
    for (const meta of defaults) {
      for (const rt of meta.reportTypes) {
        const key = meta.ruleCode + '|' + (rt || 'GLOBAL')
        const existing = existingMap.get(key)
        merged.push({
          ruleCode: meta.ruleCode,
          ruleName: meta.ruleName,
          description: meta.description,
          defaultSeverity: meta.defaultSeverity,
          reportType: rt,
          isConfigured: !!existing,
          ...(existing
            ? {
                id: existing.id,
                enabled: existing.enabled,
                severity: existing.severity,
                createdAt: existing.createdAt,
                updatedAt: existing.updatedAt,
                createdBy: existing.createdBy,
              }
            : {
                enabled: true,
                severity: meta.defaultSeverity,
              }),
        })
      }
    }
    return res.json({ total: merged.length, list: merged })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.post('/', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER), async (req: AuthRequest, res: Response) => {
  try {
    const body = createOrUpdateSchema.parse(req.body)
    if (!Object.values(RuleCode).includes(body.ruleCode as RuleCode)) {
      return res.status(400).json({ error: '无效的规则代码' })
    }
    if (body.reportType && !Object.values(ReportType).includes(body.reportType as ReportType)) {
      return res.status(400).json({ error: '无效的检查类型' })
    }
    const existing = await prisma.ruleConfig.findFirst({
      where: { ruleCode: body.ruleCode, reportType: body.reportType ?? null },
    })
    const def = RuleDefinitions[body.ruleCode as RuleCode]
    if (existing) {
      const updated = await prisma.ruleConfig.update({
        where: { id: existing.id },
        data: {
          enabled: body.enabled,
          severity: body.severity,
          ruleName: def.name,
        },
        include: { createdBy: { select: { id: true, name: true } } },
      })
      return res.json(updated)
    }
    const created = await prisma.ruleConfig.create({
      data: {
        ruleCode: body.ruleCode,
        ruleName: def.name,
        reportType: body.reportType ?? null,
        enabled: body.enabled,
        severity: body.severity,
        createdById: req.user!.userId,
      },
      include: { createdBy: { select: { id: true, name: true } } },
    })
    return res.status(201).json(created)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: '参数验证失败', details: err.errors })
    }
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.post('/bulk', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER), async (req: AuthRequest, res: Response) => {
  try {
    const body = bulkUpdateSchema.parse(req.body)
    for (const item of body) {
      if (!Object.values(RuleCode).includes(item.ruleCode as RuleCode)) {
        return res.status(400).json({ error: `无效的规则代码: ${item.ruleCode}` })
      }
      if (item.reportType && !Object.values(ReportType).includes(item.reportType as ReportType)) {
        return res.status(400).json({ error: `无效的检查类型: ${item.reportType}` })
      }
    }
    const results = await prisma.$transaction(
      body.map(item => {
        const def = RuleDefinitions[item.ruleCode as RuleCode]
        return prisma.ruleConfig.upsert({
          where: {
            RuleConfigRuleCodeReportTypeKey: {
              ruleCode: item.ruleCode,
              reportType: item.reportType ?? null,
            },
          } as any,
          create: {
            ruleCode: item.ruleCode,
            ruleName: def.name,
            reportType: item.reportType ?? null,
            enabled: item.enabled,
            severity: item.severity,
            createdById: req.user!.userId,
          },
          update: {
            enabled: item.enabled,
            severity: item.severity,
            ruleName: def.name,
          },
        })
      })
    )
    return res.json({ updated: results.length, list: results })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: '参数验证失败', details: err.errors })
    }
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.put('/:id', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER), async (req: AuthRequest, res: Response) => {
  try {
    const body = createOrUpdateSchema.partial().parse(req.body)
    const existing = await prisma.ruleConfig.findUnique({ where: { id: req.params.id } })
    if (!existing) return res.status(404).json({ error: '规则配置不存在' })
    const data: any = {}
    if (body.enabled !== undefined) data.enabled = body.enabled
    if (body.severity) data.severity = body.severity
    const updated = await prisma.ruleConfig.update({
      where: { id: req.params.id },
      data,
      include: { createdBy: { select: { id: true, name: true } } },
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

router.delete('/:id', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER), async (_req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.ruleConfig.findUnique({ where: { id: _req.params.id } })
    if (!existing) return res.status(404).json({ error: '规则配置不存在' })
    await prisma.ruleConfig.delete({ where: { id: _req.params.id } })
    return res.json({ deleted: true, id: _req.params.id })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

export default router
