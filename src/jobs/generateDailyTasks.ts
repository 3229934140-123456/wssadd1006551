import { generateDailyTasks } from '../services/taskGenerator'
import prisma from '../lib/prisma'

async function main() {
  console.log(`[${new Date().toISOString()}] 开始生成每日抽检任务...`)

  const targetDateStr = process.argv[2]
  const targetDate = targetDateStr ? new Date(targetDateStr) : undefined

  const result = await generateDailyTasks(targetDate)

  console.log(`扫描报告数量: ${result.totalReports}`)
  console.log(`新生成任务数: ${result.createdTasks}`)
  console.log('---')

  result.details.forEach(d => {
    const flag = d.selected ? '✅' : '⬜'
    console.log(`${flag} ${d.reportNo} 抽检率=${(d.rate * 100).toFixed(0)}%`)
  })

  await prisma.$disconnect()
  console.log('完成。')
}

main().catch(e => {
  console.error('生成任务失败:', e)
  process.exit(1)
})
