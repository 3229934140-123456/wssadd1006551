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
router.use(requireRole(UserRole.ADMIN, UserRole.QC_MANAGER))

async function recordRuleConfigChange(
  ruleConfigId: string,
  ruleCode: string,
  reportType: string | null,
  fieldName: string,
  oldValue: string | boolean | null,
  newValue: string | boolean | null,
  changedById: string,
) {
  await prisma.ruleConfigChangeLog.create({
    data: {
      ruleConfigId,
      ruleCode,
      reportType,
      fieldName,
      oldValue: oldValue !== null ? String(oldValue) : null,
      newValue: newValue !== null ? String(newValue) : null,
      changedById,
    },
  })
}

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
      const changes: { field: string; old: any; new: any }[] = []
      if (existing.enabled !== body.enabled) {
        changes.push({ field: 'enabled', old: existing.enabled, new: body.enabled })
      }
      if (existing.severity !== body.severity) {
        changes.push({ field: 'severity', old: existing.severity, new: body.severity })
      }
      const updated = await prisma.ruleConfig.update({
        where: { id: existing.id },
        data: {
          enabled: body.enabled,
          severity: body.severity,
          ruleName: def.name,
        },
        include: { createdBy: { select: { id: true, name: true } } },
      })
      await Promise.all(changes.map(c =>
        recordRuleConfigChange(
          existing.id, body.ruleCode, body.reportType ?? null,
          c.field, c.old, c.new, req.user!.userId,
        )
      ))
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
    await Promise.all([
      recordRuleConfigChange(created.id, body.ruleCode, body.reportType ?? null,
        'enabled', null, body.enabled, req.user!.userId),
      recordRuleConfigChange(created.id, body.ruleCode, body.reportType ?? null,
        'severity', null, body.severity, req.user!.userId),
    ])
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
    // 先查出所有现有配置用于比较变更
    const existingConfigs = await prisma.ruleConfig.findMany({
      where: {
        OR: body.map(item => ({
          ruleCode: item.ruleCode,
          reportType: item.reportType ?? null,
        })),
      },
    })
    const existingMap = new Map(
      existingConfigs.map(c => [`${c.ruleCode}|${c.reportType || 'GLOBAL'}`, c])
    )

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

    // 写入变更日志
    const changePromises: Promise<any>[] = []
    for (let i = 0; i < body.length; i++) {
      const item = body[i]
      const result = results[i]
      const existing = existingMap.get(`${item.ruleCode}|${(item.reportType || 'GLOBAL')}`)
      if (!existing) {
        // 新建，记录初始值
        changePromises.push(recordRuleConfigChange(
          result.id, item.ruleCode, item.reportType ?? null,
          'enabled', null, item.enabled, req.user!.userId,
        ))
        changePromises.push(recordRuleConfigChange(
          result.id, item.ruleCode, item.reportType ?? null,
          'severity', null, item.severity, req.user!.userId,
        ))
      } else {
        if (existing.enabled !== item.enabled) {
          changePromises.push(recordRuleConfigChange(
            result.id, item.ruleCode, item.reportType ?? null,
            'enabled', existing.enabled, item.enabled, req.user!.userId,
          ))
        }
        if (existing.severity !== item.severity) {
          changePromises.push(recordRuleConfigChange(
            result.id, item.ruleCode, item.reportType ?? null,
            'severity', existing.severity, item.severity, req.user!.userId,
          ))
        }
      }
    }
    await Promise.all(changePromises)

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

    const changes: { field: string; old: any; new: any }[] = []
    if (body.enabled !== undefined && existing.enabled !== body.enabled) {
      changes.push({ field: 'enabled', old: existing.enabled, new: body.enabled })
    }
    if (body.severity && existing.severity !== body.severity) {
      changes.push({ field: 'severity', old: existing.severity, new: body.severity })
    }

    const updated = await prisma.ruleConfig.update({
      where: { id: req.params.id },
      data,
      include: { createdBy: { select: { id: true, name: true } } },
    })
    await Promise.all(changes.map(c =>
      recordRuleConfigChange(
        existing.id, existing.ruleCode, existing.reportType,
        c.field, c.old, c.new, req.user!.userId,
      )
    ))
    return res.json(updated)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: '参数验证失败', details: err.errors })
    }
    console.error(err)
    return res.status(500).json({ error: '服务器内部错误' })
  }
})

router.get('/:id/changelogs', requireRole(UserRole.ADMIN, UserRole.QC_MANAGER), async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', pageSize = '50' } = req.query
    const pageNum = Math.max(1, parseInt(page as string))
    const size = Math.min(200, Math.max(1, parseInt(pageSize as string)))
    const skip = (pageNum - 1) * size

    const [total, logs] = await Promise.all([
      prisma.ruleConfigChangeLog.count({ where: { ruleConfigId: req.params.id } }),
      prisma.ruleConfigChangeLog.findMany({
        where: { ruleConfigId: req.params.id },
        skip,
        take: size,
        include: {
          changedBy: { select: { id: true, name: true, username: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    return res.json({ total, page: pageNum, pageSize: size, list: logs })
  } catch (err) {
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
