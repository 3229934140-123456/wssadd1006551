import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { UserRole, ReportType, ReportStatus } from '../src/lib/enums'
import { runAllRules, issuesToDbRecords } from '../src/services/ruleChecker'

const prisma = new PrismaClient()

const DEFAULT_PASSWORD = '123456'

async function main() {
  console.log('🌱 开始填充种子数据...')

  const hash = await bcrypt.hash(DEFAULT_PASSWORD, 10)

  const clinic1 = await prisma.clinic.upsert({
    where: { code: 'SH001' },
    update: {},
    create: {
      code: 'SH001',
      name: '上海徐汇旗舰门诊',
      address: '上海市徐汇区淮海中路1000号',
      phone: '021-12345678',
    },
  })

  const clinic2 = await prisma.clinic.upsert({
    where: { code: 'BJ001' },
    update: {},
    create: {
      code: 'BJ001',
      name: '北京朝阳分店',
      address: '北京市朝阳区建国路88号',
      phone: '010-87654321',
    },
  })

  const clinic3 = await prisma.clinic.upsert({
    where: { code: 'GZ001' },
    update: {},
    create: {
      code: 'GZ001',
      name: '广州天河分店',
      address: '广州市天河区珠江新城',
      phone: '020-55667788',
    },
  })

  console.log(`✅ 门店数据已准备: ${clinic1.name}, ${clinic2.name}, ${clinic3.name}`)

  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      passwordHash: hash,
      name: '系统管理员',
      role: UserRole.ADMIN,
      email: 'admin@dental-qc.com',
      phone: '13800000001',
    },
  })

  const qcManager = await prisma.user.upsert({
    where: { username: 'qc_manager' },
    update: {},
    create: {
      username: 'qc_manager',
      passwordHash: hash,
      name: '张质控',
      role: UserRole.QC_MANAGER,
      email: 'zhangzhikong@dental-qc.com',
      phone: '13800000002',
    },
  })

  const qcAuditor1 = await prisma.user.upsert({
    where: { username: 'qc_auditor1' },
    update: {},
    create: {
      username: 'qc_auditor1',
      passwordHash: hash,
      name: '李审核',
      role: UserRole.QC_AUDITOR,
      email: 'lishenhe@dental-qc.com',
      phone: '13800000003',
    },
  })

  const qcAuditor2 = await prisma.user.upsert({
    where: { username: 'qc_auditor2' },
    update: {},
    create: {
      username: 'qc_auditor2',
      passwordHash: hash,
      name: '王复核',
      role: UserRole.QC_AUDITOR,
      email: 'wangfuhe@dental-qc.com',
      phone: '13800000004',
    },
  })

  const doctor1 = await prisma.user.upsert({
    where: { username: 'doctor_sh' },
    update: {},
    create: {
      username: 'doctor_sh',
      passwordHash: hash,
      name: '陈上海',
      role: UserRole.CLINIC_DOCTOR,
      clinicId: clinic1.id,
      email: 'chensh@dental-clinic.com',
      phone: '13900000001',
    },
  })

  const doctor2 = await prisma.user.upsert({
    where: { username: 'doctor_bj' },
    update: {},
    create: {
      username: 'doctor_bj',
      passwordHash: hash,
      name: '刘北京',
      role: UserRole.CLINIC_DOCTOR,
      clinicId: clinic2.id,
      email: 'liubj@dental-clinic.com',
      phone: '13900000002',
    },
  })

  const doctor3 = await prisma.user.upsert({
    where: { username: 'doctor_gz' },
    update: {},
    create: {
      username: 'doctor_gz',
      passwordHash: hash,
      name: '黄广州',
      role: UserRole.CLINIC_DOCTOR,
      clinicId: clinic3.id,
      email: 'huanggz@dental-clinic.com',
      phone: '13900000003',
    },
  })

  const clinicManager1 = await prisma.user.upsert({
    where: { username: 'manager_sh' },
    update: {},
    create: {
      username: 'manager_sh',
      passwordHash: hash,
      name: '上海店长',
      role: UserRole.CLINIC_MANAGER,
      clinicId: clinic1.id,
      email: 'sh-manager@dental-clinic.com',
    },
  })

  console.log('✅ 用户数据已准备')
  console.log(`   🔑 所有账号默认密码: ${DEFAULT_PASSWORD}`)
  console.log(`   admin / qc_manager / qc_auditor1 / qc_auditor2 / doctor_sh / doctor_bj / doctor_gz / manager_sh`)

  await prisma.samplingRule.deleteMany({})

  await prisma.samplingRule.createMany({
    data: [
      {
        name: '上海徐汇门诊高抽检',
        clinicId: clinic1.id,
        auditorId: qcAuditor1.id,
        samplingRate: 0.5,
        priority: 10,
        isActive: true,
        createdById: qcManager.id,
      },
      {
        name: '北京朝阳标准抽检',
        clinicId: clinic2.id,
        auditorId: qcAuditor2.id,
        samplingRate: 0.3,
        priority: 5,
        isActive: true,
        createdById: qcManager.id,
      },
      {
        name: 'CBCT 专项检查',
        reportType: ReportType.CBCT,
        samplingRate: 0.6,
        priority: 8,
        isActive: true,
        createdById: qcManager.id,
      },
      {
        name: '新手医生高比例',
        submitterId: doctor3.id,
        samplingRate: 0.8,
        priority: 15,
        isActive: true,
        createdById: qcManager.id,
      },
      {
        name: '全部门店默认抽检',
        samplingRate: 0.15,
        priority: 0,
        isActive: true,
        createdById: qcManager.id,
      },
    ],
  })

  console.log('✅ 抽检规则已准备 (5 条)')

  const sampleReports = [
    {
      doctor: doctor1,
      clinic: clinic1,
      type: ReportType.PANORAMIC_XRAY,
      examName: '全景片检查',
      patientName: '张三',
      patientId: 'P001',
      description: '患者因左上后牙区疼痛不适3天就诊，要求影像检查。可见左上第一磨牙根尖区低密度阴影。',
      diagnosis: '有炎症，疑似牙髓炎',
      conclusions: '建议进一步检查',
      recommendations: '请结合临床',
      toothPositions: '',
      hasRuleError: true,
    },
    {
      doctor: doctor1,
      clinic: clinic1,
      type: ReportType.CBCT,
      examName: 'CBCT',
      patientName: '李四',
      patientId: 'P002',
      description: '右上后牙反复肿痛1月。CBCT示右上6近中根尖区可见约5×6mm类圆形低密度影，边界尚清，牙根吸收约1/3。',
      diagnosis: '16慢性根尖周炎伴根尖囊肿形成。25深龋近髓，探及穿髓点。',
      conclusions: '16 慢性根尖周炎；25 深龋近髓；上下颌前牙轻度牙结石',
      recommendations: '16 建议行根管治疗，术后观察3月；25 建议行充填治疗或根管治疗；全口建议洁治。',
      toothPositions: '16,25',
      hasRuleError: false,
    },
    {
      doctor: doctor2,
      clinic: clinic2,
      type: ReportType.PANORAMIC_XRAY,
      examName: '口腔全景',
      patientName: '王五',
      patientId: 'P003',
      description: '患者洗牙常规检查。全口牙槽骨不同程度吸收，下前牙区明显。38近中阻生，冠周间隙尚可。',
      diagnosis: '慢性牙周炎，38智齿近中阻生。下前牙有虫牙。',
      conclusions: '慢性牙周炎（中度）；38阻生齿；41、42 龋齿',
      recommendations: '全口洗牙+龈下刮治；38建议拔除；41、42建议补牙；牙周维护每3月。',
      toothPositions: '38,41,42',
      hasRuleError: false,
    },
    {
      doctor: doctor2,
      clinic: clinic2,
      type: ReportType.PANORAMIC_XRAY,
      examName: '',
      patientName: '赵六',
      patientId: 'P004',
      description: '患者诉牙床肿，偶有长牙包，尤其左下后牙。',
      diagnosis: '左下有问题，牙床肿可能是炎症',
      conclusions: '异常',
      recommendations: '',
      toothPositions: '',
      hasRuleError: true,
    },
    {
      doctor: doctor3,
      clinic: clinic3,
      type: ReportType.CBCT,
      examName: 'CBCT',
      patientName: '钱七',
      patientId: 'P005',
      description: '右下后牙咬物痛2周。CBCT示右下6根分叉区骨质破坏，近颊根纵折可疑。',
      diagnosis: '46根分叉病变Ⅲ度，近颊根疑似纵折。36牙神经痛表现。',
      conclusions: '46 根分叉病变（Ⅲ度），牙根纵折可能性大；36 牙髓炎；口腔卫生差',
      recommendations: '46 建议拔除后考虑种牙或镶牙；36 建议杀神经；建议全口洁治。',
      toothPositions: '46,36',
      hasRuleError: false,
    },
    {
      doctor: doctor1,
      clinic: clinic1,
      type: ReportType.PANORAMIC_XRAY,
      examName: '全景片',
      patientName: '孙八',
      patientId: 'P006',
      description: '正畸前检查。牙列基本整齐，22缺失间隙存在，牙槽骨宽度尚可。',
      diagnosis: '牙列缺损（22缺失），轻度拥挤',
      conclusions: '22先天缺失；上下颌前牙轻度拥挤；颞下颌关节未见明显异常',
      recommendations: '建议正畸评估，考虑22种植修复或关闭间隙；定期复查关节。',
      toothPositions: '22',
      hasRuleError: false,
    },
  ]

  for (const s of sampleReports) {
    const prefix = s.type === ReportType.CBCT ? 'CBCT' : 'PAN'
    const reportNo = `${s.clinic.code}-${prefix}-S${Math.floor(Math.random() * 9000 + 1000)}`

    const report = await prisma.report.create({
      data: {
        reportNo,
        type: s.type,
        examName: s.examName,
        patientName: s.patientName,
        patientId: s.patientId,
        clinicId: s.clinic.id,
        submitterId: s.doctor.id,
        description: s.description,
        diagnosis: s.diagnosis,
        conclusions: s.conclusions,
        recommendations: s.recommendations,
        toothPositions: s.toothPositions,
        rawContent: JSON.stringify({ patientInfo: s.patientName, imageType: s.type }),
        status: ReportStatus.SUBMITTED,
        version: 1,
      },
    })

    const issues = runAllRules(report as any)
    const dbRecords = issuesToDbRecords(report.id, issues)
    await prisma.ruleCheckResult.createMany({ data: dbRecords })

    const hasErrors = issues.some(i => i.severity === 'ERROR' && !i.passed)
    const finalStatus = hasErrors ? ReportStatus.RULE_CHECK_FAILED : ReportStatus.RULE_CHECK_PASSED
    await prisma.report.update({
      where: { id: report.id },
      data: { status: finalStatus },
    })

    const flags = hasErrors ? '❌ 规则不通过' : '✅ 规则通过'
    console.log(`   ${flags} ${reportNo} - ${s.patientName} (${s.doctor.name})`)
  }

  console.log('✅ 示例报告已创建并执行规则检查')
  console.log('\n🎉 种子数据填充完成！')
  console.log('')
  console.log('📌 下一步建议：')
  console.log('   1. npm run dev  启动开发服务')
  console.log('   2. npm run generate-tasks  生成当日抽检任务')
  console.log('   3. 使用 admin / qc_manager / doctor_sh 等账号登录体验')
}

main()
  .catch(e => {
    console.error('❌ 种子数据填充失败:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
