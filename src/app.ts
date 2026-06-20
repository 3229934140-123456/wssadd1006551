import express from 'express'
import cors from 'cors'
import cron from 'node-cron'
import authRouter from './routes/auth'
import clinicsRouter from './routes/clinics'
import usersRouter from './routes/users'
import reportsRouter from './routes/reports'
import samplingRouter from './routes/sampling'
import auditTasksRouter from './routes/auditTasks'
import statisticsRouter from './routes/statistics'
import { generateDailyTasks } from './services/taskGenerator'

const app = express()

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'dental-qc-report-service',
    version: '1.0.0',
  })
})

app.use('/api/auth', authRouter)
app.use('/api/clinics', clinicsRouter)
app.use('/api/users', usersRouter)
app.use('/api/reports', reportsRouter)
app.use('/api/sampling-rules', samplingRouter)
app.use('/api/audit-tasks', auditTasksRouter)
app.use('/api/statistics', statisticsRouter)

app.use((_req, res) => {
  res.status(404).json({ error: '接口不存在' })
})

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Unhandled Error]', err)
  res.status(500).json({
    error: '服务器内部错误',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  })
})

cron.schedule('0 2 * * *', async () => {
  console.log(`[Cron] ${new Date().toISOString()} 触发每日抽检任务生成`)
  try {
    const result = await generateDailyTasks()
    console.log(`[Cron] 任务生成完成：扫描 ${result.totalReports} 份，新生成 ${result.createdTasks} 个任务`)
  } catch (e) {
    console.error('[Cron] 任务生成失败：', e)
  }
}, {
  timezone: 'Asia/Shanghai',
})

export default app
