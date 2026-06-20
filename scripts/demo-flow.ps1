# 端到端演示流程脚本
# 先启动服务器: npm run dev，然后在另一个终端运行此脚本

$BASE_URL = "http://localhost:3000/api"

Write-Host "=== 1. 登录各种角色账号 ===" -ForegroundColor Green

function Login($username, $password = "123456") {
    $body = @{ username = $username; password = $password } | ConvertTo-Json
    $resp = Invoke-RestMethod -Uri "$BASE_URL/auth/login" -Method Post -Body $body -ContentType "application/json"
    return $resp
}

$adminLogin = Login "admin"
$qcManagerLogin = Login "qc_manager"
$qcAuditorLogin = Login "qc_auditor1"
$doctorLogin = Login "doctor_sh"

Write-Host "admin token length: $($adminLogin.token.Length)"
Write-Host "doctor role: $($doctorLogin.user.role), clinic: $($doctorLogin.user.clinicName)" -ForegroundColor Cyan

Write-Host ""
Write-Host "=== 2. 门店医生提交一份有问题的报告（只有炎症没写牙位） ===" -ForegroundColor Green

$reportData = @{
    type           = "PANORAMIC_XRAY"
    examName       = "全景片"
    patientName    = "演示患者"
    patientId      = "DEMO-001"
    description    = "患者后牙不适1周，全景片检查发现左下后牙区阴影"
    diagnosis      = "左下后牙有炎症，需要治疗"
    conclusions    = "有问题，建议复诊"
    recommendations = "建议结合临床"
    toothPositions = ""
    submit         = $true
} | ConvertTo-Json

$resp = Invoke-RestMethod -Uri "$BASE_URL/reports" -Method Post -Body $reportData `
    -ContentType "application/json" -Headers @{ Authorization = "Bearer $($doctorLogin.token)" }

$demoReportId = $resp.report.id
Write-Host "提交报告 ID: $demoReportId" -ForegroundColor Cyan
Write-Host "报告状态: $($resp.report.status)" -ForegroundColor Yellow
$rc = $resp.ruleChecks
Write-Host "规则检查: 错误=$($rc.errorCount), 警告=$($rc.warningCount), 通过=$($rc.passed)" -ForegroundColor $(if ($rc.passed) { "Green" } else { "Red" })
$rc.details | Where-Object { !$_.passed } | ForEach-Object {
    Write-Host "  ❌ [$($_.severity)] $($_.ruleName): $($_.message)" -ForegroundColor Red
    if ($_.suggestion) { Write-Host "     💡 $($_.suggestion)" -ForegroundColor DarkGray }
}

Write-Host ""
Write-Host "=== 3. 医生自己修改一份没有问题的报告再次提交 ===" -ForegroundColor Green

$goodReportData = @{
    type           = "CBCT"
    examName       = "CBCT"
    patientName    = "规范患者"
    patientId      = "DEMO-002"
    description    = "右上后牙反复肿痛，CBCT检查。16根尖区可见低密度影。"
    diagnosis      = "16慢性根尖周炎，25深龋"
    conclusions    = "16慢性根尖周炎；25深龋近髓"
    recommendations = "16建议行根管治疗；25建议充填治疗或根管治疗"
    toothPositions = "16,25"
    submit         = $true
} | ConvertTo-Json

$resp2 = Invoke-RestMethod -Uri "$BASE_URL/reports" -Method Post -Body $goodReportData `
    -ContentType "application/json" -Headers @{ Authorization = "Bearer $($doctorLogin.token)" }
$goodReportId = $resp2.report.id
Write-Host "规范报告 ID: $goodReportId, 状态: $($resp2.report.status)" -ForegroundColor Cyan
$rc2 = $resp2.ruleChecks
Write-Host "规则检查: 错误=$($rc2.errorCount), 警告=$($rc2.warningCount), 通过=$($rc2.passed)" -ForegroundColor Green

Write-Host ""
Write-Host "=== 4. 质控主管生成当日抽检任务 ===" -ForegroundColor Green

$genResp = Invoke-RestMethod -Uri "$BASE_URL/audit-tasks/generate-daily" -Method Post `
    -Headers @{ Authorization = "Bearer $($qcManagerLogin.token)" } -ContentType "application/json"
Write-Host "扫描报告: $($genResp.totalReports), 新生成任务: $($genResp.createdTasks)" -ForegroundColor Cyan
$genResp.details | Select-Object -First 10 | ForEach-Object {
    $flag = if ($_.selected) { "✅" } else { "⬜" }
    Write-Host "  $flag $($_.reportNo) 抽检率=$([math]::Round($_.rate*100))%"
}

Write-Host ""
Write-Host "=== 5. 质控主管手动创建审核任务并分配给审核员 ===" -ForegroundColor Green

$manualTaskBody = @{ reportId = $demoReportId; assignedToId = $qcAuditorLogin.user.id } | ConvertTo-Json
$taskResp = Invoke-RestMethod -Uri "$BASE_URL/audit-tasks/manual" -Method Post -Body $manualTaskBody `
    -ContentType "application/json" -Headers @{ Authorization = "Bearer $($qcManagerLogin.token)" }
$taskId = $taskResp.id
Write-Host "创建任务 ID: $taskId, 分配给: $($taskResp.assignedTo.name)" -ForegroundColor Cyan

Write-Host ""
Write-Host "=== 6. 审核员查看自己的任务并开始审核 ===" -ForegroundColor Green

$myTasks = Invoke-RestMethod -Uri "$BASE_URL/audit-tasks?pageSize=5" `
    -Headers @{ Authorization = "Bearer $($qcAuditorLogin.token)" }
Write-Host "审核员待办: 共$($myTasks.total)条, 展示$($myTasks.list.Count)条" -ForegroundColor Cyan

$startResp = Invoke-RestMethod -Uri "$BASE_URL/audit-tasks/$taskId/start" -Method Post `
    -Headers @{ Authorization = "Bearer $($qcAuditorLogin.token)" }
Write-Host "开始审核任务: $taskId, 状态: $($startResp.status)" -ForegroundColor Yellow

Write-Host ""
Write-Host "=== 7. 审核员添加问题反馈 ===" -ForegroundColor Green

$labels = Invoke-RestMethod -Uri "$BASE_URL/audit-tasks/issue-labels" `
    -Headers @{ Authorization = "Bearer $($qcAuditorLogin.token)" }

$fbs = @(
    @{
        issueCategory = "DIAGNOSIS_INCOMPLETE"
        issueLabel    = "只写炎症没写牙位"
        fieldName     = "diagnosis"
        note          = "炎症描述必须关联具体牙位，请使用FDI编号"
    },
    @{
        issueCategory = "CONCLUSION_TOO_GENERAL"
        issueLabel    = "结论过于笼统"
        fieldName     = "conclusions"
        note          = "请给出明确的诊断，如16慢性根尖周炎"
    },
    @{
        issueCategory = "TOOTH_POSITION_FORMAT"
        issueLabel    = "未使用FDI编号"
        fieldName     = "toothPositions"
        modification  = "36,37"
        note          = "左下后牙为36、37"
    }
)

foreach ($fb in $fbs) {
    $fbBody = $fb | ConvertTo-Json
    $fbResp = Invoke-RestMethod -Uri "$BASE_URL/audit-tasks/$taskId/feedback" -Method Post -Body $fbBody `
        -ContentType "application/json" -Headers @{ Authorization = "Bearer $($qcAuditorLogin.token)" }
    Write-Host "  ✅ 添加反馈: $($fbResp.issueLabel)" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "=== 8. 审核员完成审核（打回修改） ===" -ForegroundColor Green

$completeBody = @{ action = "REJECT"; overallNote = "请完善牙位标注后再提交，整体描述质量需要提升。" } | ConvertTo-Json
$completeResp = Invoke-RestMethod -Uri "$BASE_URL/audit-tasks/$taskId/complete" -Method Post -Body $completeBody `
    -ContentType "application/json" -Headers @{ Authorization = "Bearer $($qcAuditorLogin.token)" }
Write-Host "完成审核, 报告新状态: $($completeResp.reportStatus), 问题数: $($completeResp.feedbackCount)" -ForegroundColor Yellow

Write-Host ""
Write-Host "=== 9. 门店医生查看报告反馈信息 ===" -ForegroundColor Green

$feedbacks = Invoke-RestMethod -Uri "$BASE_URL/reports/$demoReportId/feedbacks" `
    -Headers @{ Authorization = "Bearer $($doctorLogin.token)" }
Write-Host "收到反馈 $($feedbacks.Count) 条:" -ForegroundColor Cyan
$feedbacks | ForEach-Object {
    $done = if ($_.isResolved) { "[已整改]" } else { "[待整改]" }
    Write-Host "  $done $($_.issueLabel) - $($_.auditor.name): $($_.note)" -ForegroundColor $(if ($_.isResolved) { "Green" } else { "Red" })
    if ($_.modification) { Write-Host "     修改建议: $($_.modification)" -ForegroundColor DarkGray }
}

Write-Host ""
Write-Host "=== 10. 门店医生修改内容并提交 ===" -ForegroundColor Green

$reviseBody = @{
    diagnosis      = "36慢性根尖周炎，37深龋"
    conclusions    = "36 慢性根尖周炎；37 深龋近髓"
    recommendations = "36建议行根管治疗；37建议行充填治疗"
    toothPositions = "36,37"
} | ConvertTo-Json

$reviseResp = Invoke-RestMethod -Uri "$BASE_URL/reports/$demoReportId/revise" -Method Put -Body $reviseBody `
    -ContentType "application/json" -Headers @{ Authorization = "Bearer $($doctorLogin.token)" }
Write-Host "修改完成, 报告状态: $($reviseResp.report.status), 自动整改条数: $($reviseResp.resolvedCount)" -ForegroundColor Green

Write-Host ""
Write-Host "=== 11. 查看整改后反馈状态 ===" -ForegroundColor Green

$feedbacksAfter = Invoke-RestMethod -Uri "$BASE_URL/reports/$demoReportId/feedbacks" `
    -Headers @{ Authorization = "Bearer $($doctorLogin.token)" }
$resolved = ($feedbacksAfter | Where-Object { $_.isResolved }).Count
Write-Host "整改完成: $resolved/$($feedbacksAfter.Count) 条反馈已自动标记为整改" -ForegroundColor Green
if ($reviseResp.report.status -eq "RECTIFIED") {
    Write-Host "🎉 所有问题已整改，审核任务自动标记为已整改状态！" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== 12. 质控主管看板统计数据 ===" -ForegroundColor Green

$stats = Invoke-RestMethod -Uri "$BASE_URL/audit-tasks/stats" `
    -Headers @{ Authorization = "Bearer $($qcManagerLogin.token)" }
Write-Host ("审核任务汇总: 待处理={0} 进行中={1} 已完成={2} 已整改={3}" -f `
    $stats.pending, $stats.inProgress, $stats.completed, $stats.rectified) -ForegroundColor Cyan
Write-Host "今日新任务: $($stats.todayTasks), 超期任务: $($stats.overdue)" -ForegroundColor Yellow

$overview = Invoke-RestMethod -Uri "$BASE_URL/statistics/overview" `
    -Headers @{ Authorization = "Bearer $($qcManagerLogin.token)" }
Write-Host "报告总量: $($overview.totalReports), 规则错误率: $([math]::Round($overview.errorRate*100))%" -ForegroundColor Cyan
Write-Host "抽检覆盖率: $([math]::Round($overview.auditCoverage*100))%, 反馈总数: $($overview.totalFeedbacks)" -ForegroundColor Cyan

Write-Host ""
Write-Host "=== 🎉 端到端流程演示完成！ ===" -ForegroundColor Magenta
