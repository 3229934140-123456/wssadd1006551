import app from './app'
import prisma from './lib/prisma'

const PORT = parseInt(process.env.PORT || '3000')

async function bootstrap() {
  try {
    await prisma.$connect()
    console.log('✅ 数据库连接成功')

    app.listen(PORT, () => {
      console.log(`🚀 口腔质控报告审核服务已启动`)
      console.log(`   服务地址: http://localhost:${PORT}`)
      console.log(`   健康检查: http://localhost:${PORT}/health`)
      console.log(`   API 前缀: http://localhost:${PORT}/api`)
      console.log('')
      console.log('📋 默认账号 (请在种子数据中查看):')
      console.log('   - 管理员 / 质控主管 / 审核员 / 门店医生')
    })
  } catch (e) {
    console.error('❌ 服务启动失败:', e)
    process.exit(1)
  }
}

process.on('SIGINT', async () => {
  console.log('\n🛑 正在关闭服务...')
  await prisma.$disconnect()
  process.exit(0)
})

bootstrap()
