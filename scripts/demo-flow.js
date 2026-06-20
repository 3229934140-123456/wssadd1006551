// 端到端演示流程脚本
// 先启动服务器: npm run dev，然后在另一个终端: node scripts/demo-flow.js

const BASE_URL = "http://localhost:3000/api";

async function request(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(BASE_URL + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${path}: ${text}`);
  }
  return res.json();
}

function log(title, msg, color = "") {
  const colors = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    magenta: "\x1b[35m",
    gray: "\x1b[90m",
  };
  const c = colors[color] || "";
  console.log(`${c}${title}${colors.reset} ${msg ?? ""}`);
}

async function main() {
  try {
    // 1. 登录
    log("=== 1. 登录各种角色账号 ===", null, "green");

    async function Login(username, password = "123456") {
      return request("/auth/login", {
        method: "POST",
        body: { username, password },
      });
    }

    const adminLogin = await Login("admin");
    const qcManagerLogin = await Login("qc_manager");
    const qcAuditorLogin = await Login("qc_auditor1");
    const doctorLogin = await Login("doctor_sh");

    console.log(`admin token length: ${adminLogin.token.length}`);
    log("", `doctor role: ${doctorLogin.user.role}, clinic: ${doctorLogin.user.clinicName}`, "cyan");

    // 2. 提交有问题的报告
    log("\n=== 2. 门店医生提交一份有问题的报告（只有炎症没写牙位） ===", null, "green");

    const resp = await request("/reports", {
      method: "POST",
      body: {
        type: "PANORAMIC_XRAY",
        examName: "全景片",
        patientName: "演示患者",
        patientId: "DEMO-001",
        description: "患者后牙不适1周，全景片检查发现左下后牙区阴影",
        diagnosis: "左下后牙有炎症，需要治疗",
        conclusions: "有问题，建议复诊",
        recommendations: "建议结合临床",
        toothPositions: "",
        submit: true,
      },
      token: doctorLogin.token,
    });
    const demoReportId = resp.report.id;
    log("", `提交报告 ID: ${demoReportId}`, "cyan");
    log("", `报告状态: ${resp.report.status}`, "yellow");
    const rc = resp.report.ruleChecks;
    const color = rc.passed ? "green" : "red";
    log("", `规则检查: 错误=${rc.errorCount}, 警告=${rc.warningCount}, 通过=${rc.passed}`, color);
    rc.details
      .filter((d) => !d.passed)
      .forEach((d) => {
        log("  X ", `[${d.severity}] ${d.ruleName}: ${d.message}`, "red");
        if (d.suggestion) log("    -> ", d.suggestion, "gray");
      });

    // 3. 提交规范报告
    log("\n=== 3. 医生自己修改一份没有问题的报告再次提交 ===", null, "green");

    const resp2 = await request("/reports", {
      method: "POST",
      body: {
        type: "CBCT",
        examName: "CBCT",
        patientName: "规范患者",
        patientId: "DEMO-002",
        description: "右上后牙反复肿痛，CBCT检查。16根尖区可见低密度影。",
        diagnosis: "16慢性根尖周炎，25深龋",
        conclusions: "16慢性根尖周炎；25深龋近髓",
        recommendations: "16建议行根管治疗；25建议充填治疗或根管治疗",
        toothPositions: "16,25",
        submit: true,
      },
      token: doctorLogin.token,
    });
    const goodReportId = resp2.report.id;
    log("", `规范报告 ID: ${goodReportId}, 状态: ${resp2.report.status}`, "cyan");
    const rc2 = resp2.report.ruleChecks;
    log("", `规则检查: 错误=${rc2.errorCount}, 警告=${rc2.warningCount}, 通过=${rc2.passed}`, "green");

    // 4. 生成抽检任务
    log("\n=== 4. 质控主管生成当日抽检任务 ===", null, "green");

    const genRespV1 = await request("/audit-tasks/generate-daily", {
      method: "POST",
      token: qcManagerLogin.token,
    });
    log("", `扫描报告: ${genRespV1.totalReports}, 新生成任务: ${genRespV1.createdTasks}`, "cyan");
    (genRespV1.details || []).slice(0, 10).forEach((d) => {
      const flag = d.selected ? "V " : "  ";
      log(`  ${flag}`, `${d.reportNo} 抽检率=${Math.round(d.rate * 100)}%`, d.selected ? "green" : "gray");
    });

    // 5. 手动创建审核任务（如果已被抽检，则直接用已有的任务）
    log("\n=== 5. 质控主管手动创建审核任务并分配给审核员 ===", null, "green");

    let taskResp;
    try {
      taskResp = await request("/audit-tasks/manual", {
        method: "POST",
        body: { reportId: demoReportId, assignedToId: qcAuditorLogin.user.id },
        token: qcManagerLogin.token,
      });
    } catch (e) {
      // 如果已经有任务了，则查找已有的任务
      log("", `已自动抽检存在，直接复用任务`, "yellow");
      const tasks = await request(`/audit-tasks?pageSize=20&reportId=${demoReportId}`, {
        token: qcManagerLogin.token,
      });
      if (tasks.list.length === 0) throw e;
      taskResp = tasks.list[0];
      // 如果任务还没分配，先分配给审核员
      if (!taskResp.assignedToId) {
        taskResp = await request(`/audit-tasks/${taskResp.id}/assign`, {
          method: "POST",
          body: { assignedToId: qcAuditorLogin.user.id },
          token: qcManagerLogin.token,
        });
      }
    }
    const taskId = taskResp.id;
    const assignedToName = taskResp.assignedTo ? taskResp.assignedTo.name : (taskResp.assignedToId || "未分配");
    log("", `使用任务 ID: ${taskId}, 分配给: ${assignedToName}`, "cyan");

    // 6. 审核员开始审核
    log("\n=== 6. 审核员查看自己的任务并开始审核 ===", null, "green");

    const myTasks = await request(`/audit-tasks?pageSize=5`, {
      token: qcAuditorLogin.token,
    });
    log("", `审核员待办: 共${myTasks.total}条, 展示${myTasks.list.length}条`, "cyan");

    const startResp = await request(`/audit-tasks/${taskId}/start`, {
      method: "POST",
      token: qcAuditorLogin.token,
    });
    log("", `开始审核任务: ${taskId}, 状态: ${startResp.status}`, "yellow");

    // 7. 添加反馈
    log("\n=== 7. 审核员添加问题反馈 ===", null, "green");

    const labels = await request("/audit-tasks/issue-labels", {
      token: qcAuditorLogin.token,
    });
    console.log("可选问题标签示例:", Object.keys(labels).slice(0, 3).join(", "));

    const fbs = [
      {
        issueCategory: "DIAGNOSIS_INCOMPLETE",
        issueLabel: "只写炎症没写牙位",
        fieldName: "diagnosis",
        note: "炎症描述必须关联具体牙位，请使用FDI编号",
      },
      {
        issueCategory: "CONCLUSION_TOO_GENERAL",
        issueLabel: "结论过于笼统",
        fieldName: "conclusions",
        note: "请给出明确的诊断，如16慢性根尖周炎",
      },
      {
        issueCategory: "TOOTH_POSITION_FORMAT",
        issueLabel: "未使用FDI编号",
        fieldName: "toothPositions",
        modification: "36,37",
        note: "左下后牙为36、37",
      },
    ];
    for (const fb of fbs) {
      const fbResp = await request(`/audit-tasks/${taskId}/feedback`, {
        method: "POST",
        body: fb,
        token: qcAuditorLogin.token,
      });
      log("  V ", `添加反馈: ${fbResp.issueLabel}`, "cyan");
    }

    // 8. 完成审核
    log("\n=== 8. 审核员完成审核（打回修改） ===", null, "green");

    const completeResp = await request(`/audit-tasks/${taskId}/complete`, {
      method: "POST",
      body: { action: "REJECT", overallNote: "请完善牙位标注后再提交，整体描述质量需要提升。" },
      token: qcAuditorLogin.token,
    });
    log(
      "",
      `完成审核, 报告新状态: ${completeResp.reportStatus}, 问题数: ${completeResp.feedbackCount}`,
      "yellow"
    );

    // 9. 医生查看反馈
    log("\n=== 9. 门店医生查看报告反馈信息 ===", null, "green");

    const feedbacks = await request(`/reports/${demoReportId}/feedbacks`, {
      token: doctorLogin.token,
    });
    log("", `收到反馈 ${feedbacks.length} 条:`, "cyan");
    feedbacks.forEach((f) => {
      const done = f.isResolved ? "[已整改]" : "[待整改]";
      const c = f.isResolved ? "green" : "red";
      log(`  ${done} `, `${f.issueLabel} - ${f.auditor.name}: ${f.note}`, c);
      if (f.modification) log("     修改建议: ", f.modification, "gray");
    });

    // 10. 医生修改内容
    log("\n=== 10. 门店医生修改内容并提交 ===", null, "green");

    const reviseResp = await request(`/reports/${demoReportId}/revise`, {
      method: "PUT",
      body: {
        diagnosis: "36慢性根尖周炎，37深龋",
        conclusions: "36 慢性根尖周炎；37 深龋近髓",
        recommendations: "36建议行根管治疗；37建议行充填治疗",
        toothPositions: "36,37",
      },
      token: doctorLogin.token,
    });
    log(
      "",
      `修改完成, 报告状态: ${reviseResp.report.status}, 自动整改条数: ${reviseResp.resolvedCount}`,
      "green"
    );

    // 11. 查看整改后状态
    log("\n=== 11. 查看整改后反馈状态 ===", null, "green");

    const feedbacksAfter = await request(`/reports/${demoReportId}/feedbacks`, {
      token: doctorLogin.token,
    });
    const resolved = feedbacksAfter.filter((f) => f.isResolved).length;
    log("", `整改完成: ${resolved}/${feedbacksAfter.length} 条反馈已自动标记为整改`, "green");
    if (reviseResp.report.status === "RECTIFIED") {
      log("", "所有问题已整改，审核任务自动标记为已整改状态！", "green");
    }

    // 12. 质控看板
    log("\n=== 12. 质控主管看板统计数据 ===", null, "green");

    const stats = await request("/audit-tasks/stats", {
      token: qcManagerLogin.token,
    });
    log(
      "",
      `审核任务汇总: 待处理=${stats.pending} 进行中=${stats.inProgress} 已完成=${stats.completed} 已整改=${stats.rectified}`,
      "cyan"
    );
    log("", `今日新任务: ${stats.todayTasks}, 超期任务: ${stats.overdue}`, "yellow");

    const overview = await request("/statistics/overview", {
      token: qcManagerLogin.token,
    });
    log("", `报告总量: ${overview.totalReports}, 规则错误率: ${Math.round(overview.errorRate * 100)}%`, "cyan");
    log(
      "",
      `抽检覆盖率: ${Math.round(overview.auditCoverage * 100)}%, 反馈总数: ${overview.totalFeedbacks}`,
      "cyan"
    );

    // 13. 规则配置开关和严重级别
    log("\n=== 13. 质控主管配置规则开关 / 严重级别 ===", null, "green");

    const ruleMeta = await request("/rule-configs/meta", { token: qcManagerLogin.token });
    log("", `共定义 ${ruleMeta.length} 条规则，支持按检查类型启停`, "cyan");

    const initialConfigs = await request("/rule-configs", { token: qcManagerLogin.token });
    const diagnoRule = initialConfigs.list.find(
      (c) => c.ruleCode === "DIAGNOSIS_WITH_TOOTH" && c.reportType === "PANORAMIC_XRAY"
    );
    log(
      "",
      `[规则改动前] 诊断缺牙位规则(PAN): enabled=${diagnoRule.enabled}, severity=${diagnoRule.severity}, isConfigured=${diagnoRule.isConfigured}`,
      "yellow"
    );

    // 关闭"诊断缺牙位"规则(PANORAMIC_XRAY)
    const toggleResp = await request("/rule-configs", {
      method: "POST",
      body: {
        ruleCode: "DIAGNOSIS_WITH_TOOTH",
        reportType: "PANORAMIC_XRAY",
        enabled: false,
        severity: "WARNING",
      },
      token: qcManagerLogin.token,
    });
    log("", `[关闭规则] DIAGNOSIS_WITH_TOOTH(PAN) → enabled=${toggleResp.enabled}`, "green");

    // 提交同样的缺牙位问题报告，检查是否该规则不再报错
    const ruleTestResp = await request("/reports", {
      method: "POST",
      body: {
        type: "PANORAMIC_XRAY",
        examName: "全景片",
        patientName: "规则验证患者",
        patientId: "DEMO-RULE-001",
        description: "不适1周，无牙位标注",
        diagnosis: "有炎症，需要治疗",
        conclusions: "有问题",
        recommendations: "请结合临床",
        toothPositions: "",
        submit: true,
      },
      token: doctorLogin.token,
    });
    const rcAfter = ruleTestResp.report.ruleChecks;
    const toothIssues = rcAfter.details.filter(
      (d) => d.ruleCode === "DIAGNOSIS_WITH_TOOTH" && !d.passed
    );
    log(
      "",
      `提交相同缺牙位报告: 缺牙位规则命中=${toothIssues.length > 0} (预期 false), 总错误=${rcAfter.errorCount}`,
      toothIssues.length === 0 ? "green" : "red"
    );

    // 历史报告手动重跑规则
    const rerunResp = await request(`/reports/${demoReportId}/rule-checks/rerun`, {
      method: "POST",
      token: qcManagerLogin.token,
    });
    log("", `历史报告(${demoReportId.slice(0,8)}...)手动重跑规则: ${rerunResp.total} 条`, "cyan");

    // 14. 抽检生成记录(SamplingRun)
    log("\n=== 14. 抽检生成记录: 手动生成 + 列表查询 ===", null, "green");

    const genResp = await request("/audit-tasks/generate-daily", {
      method: "POST",
      body: { regenerateExisting: true, note: "演示流程: 手动生成" },
      token: qcManagerLogin.token,
    });
    log(
      "",
      `[generate-daily] runId=${(genResp.runId || "").slice(0, 8)}..., total=${genResp.totalReports}, created=${genResp.createdTasks}, skipped=${genResp.skippedTasks}`,
      "cyan"
    );

    const runsResp = await request("/sampling-runs?page=1&pageSize=5", {
      token: qcManagerLogin.token,
    });
    log("", `[抽检记录] 共 ${runsResp.total} 次生成，最近 ${runsResp.list.length} 条:`, "cyan");
    runsResp.list.slice(0, 3).forEach((r) => {
      log(
        `  - `,
        `日期=${r.taskDate.slice(0, 10)} 触发=${r.triggerType} 状态=${r.status} 扫描=${r.totalReports} 新任务=${r.createdTasks} 跳过=${r.skippedTasks}`,
        "gray"
      );
    });

    if (runsResp.list.length > 0) {
      const run = runsResp.list[0];
      const runDetail = await request(`/sampling-runs/${run.id}`, {
        token: qcManagerLogin.token,
      });
      const rulesHit = Object.keys(runDetail.stats.byRule || {});
      log(
        "",
        `[最近一次运行] 选中=${runDetail.stats.selectedCount}，按命中规则分布: ${rulesHit.join(", ") || "(无)"}`,
        "yellow"
      );
    }

    // 15. 审核员手动确认/退回整改（功能3: 反馈闭环细化）
    log("\n=== 15. 审核员手动确认整改 APPROVED / REJECTED 流程 ===", null, "green");

    const feedbacksBeforeVerify = await request(`/reports/${demoReportId}/feedbacks`, {
      token: qcAuditorLogin.token,
    });
    const fieldFeedbacks = feedbacksBeforeVerify.filter((f) => f.fieldName != null);
    log(
      "",
      `整改反馈数: 总 ${feedbacksBeforeVerify.length} / 有字段 ${fieldFeedbacks.length} / 已整改 ${feedbacksBeforeVerify.filter((f) => f.isResolved).length}`,
      "cyan"
    );
    const anyWithDiff = fieldFeedbacks.find((f) => f.diff && f.diff.changed);
    if (anyWithDiff) {
      log(
        "  + ",
        `整改对比示例 [${anyWithDiff.fieldName}]: before="${anyWithDiff.diff.before.slice(0, 15)}...", after="${anyWithDiff.diff.afterDoctorEdit.slice(0, 15)}...", changed=${anyWithDiff.diff.changed}`,
        "gray"
      );
    }

    // 审核员逐条确认
    let remain = fieldFeedbacks.length;
    let lastVerifyResp = null;
    for (let i = 0; i < fieldFeedbacks.length; i++) {
      const fb = fieldFeedbacks[i];
      if (!fb.isResolved) continue;
      const verifyResp = await request(`/audit-tasks/feedbacks/${fb.id}/verify`, {
        method: "POST",
        body: { action: "APPROVED", note: `已确认整改通过 (第${i + 1}条)` },
        token: qcAuditorLogin.token,
      });
      lastVerifyResp = verifyResp;
      remain = verifyResp.remainingUnverified ?? 0;
      log(
        "  V ",
        `确认通过反馈 ${fb.id.slice(0, 8)}... [${fb.fieldName}] ${i + 1}/${fieldFeedbacks.length}`,
        verifyResp.reportStatus === "RECTIFIED" ? "green" : "cyan"
      );
      if (verifyResp.reportStatus === "RECTIFIED") break;
    }
    // 16. 两阶段整改复核: 医生改完进入 PENDING_VERIFICATION，审核员逐条确认后才闭环
    log("\n=== 16. 两阶段整改复核 (PENDING_VERIFICATION -> 逐条确认 -> RECTIFIED) ===", null, "green");

    // 先创建一份新报告，走完审核打回流程
    const reviseDemoResp = await request("/reports", {
      method: "POST",
      body: {
        type: "PANORAMIC_XRAY",
        examName: "全景片",
        patientName: "复核演示患者",
        patientId: "DEMO-VERIFY-001",
        description: "后牙不适",
        diagnosis: "有炎症",
        conclusions: "有问题",
        recommendations: "请结合临床",
        toothPositions: "",
        submit: true,
      },
      token: doctorLogin.token,
    });
    const verifyDemoReportId = reviseDemoResp.report.id;
    log("", `提交报告 ID: ${verifyDemoReportId.slice(0, 8)}...`, "cyan");

    // 手动创建审核任务并打回
    let manualTask;
    try {
      manualTask = await request("/audit-tasks/manual", {
        method: "POST",
        body: { reportId: verifyDemoReportId, assignedToId: qcAuditorLogin.user.id },
        token: qcManagerLogin.token,
      });
    } catch (e) {
      const tasks = await request(`/audit-tasks?pageSize=20&reportId=${verifyDemoReportId}`, {
        token: qcManagerLogin.token,
      });
      manualTask = tasks.list[0];
      if (!manualTask.assignedToId) {
        manualTask = await request(`/audit-tasks/${manualTask.id}/assign`, {
          method: "POST",
          body: { assignedToId: qcAuditorLogin.user.id },
          token: qcManagerLogin.token,
        });
      }
    }
    const verifyTaskId = manualTask.id;
    log("", `创建任务并分配给审核员, 任务 ID: ${verifyTaskId.slice(0, 8)}...`, "cyan");

    await request(`/audit-tasks/${verifyTaskId}/start`, { method: "POST", token: qcAuditorLogin.token });
    await request(`/audit-tasks/${verifyTaskId}/feedback`, {
      method: "POST",
      body: {
        issueLabel: "只写炎症没写牙位",
        issueCategory: "DIAGNOSIS_INCOMPLETE",
        note: "请补充具体牙位，如36、37",
        modification: "36,37",
        fieldName: "diagnosis",
        oldValue: "有炎症",
      },
      token: qcAuditorLogin.token,
    });
    await request(`/audit-tasks/${verifyTaskId}/feedback`, {
      method: "POST",
      body: {
        issueLabel: "未使用FDI编号",
        issueCategory: "TOOTH_POSITION_FORMAT",
        note: "牙位字段需使用FDI编号",
        modification: "36,37",
        fieldName: "toothPositions",
        oldValue: "",
      },
      token: qcAuditorLogin.token,
    });
    await request(`/audit-tasks/${verifyTaskId}/complete`, {
      method: "POST",
      body: { action: "REJECT", overallNote: "请补充牙位信息" },
      token: qcAuditorLogin.token,
    });
    log("", `审核打回完成, 报告进入 NEEDS_REVISION`, "yellow");

    // 医生提交整改 -> 进入 PENDING_VERIFICATION
    const reviseResp2 = await request(`/reports/${verifyDemoReportId}/revise`, {
      method: "PUT",
      body: {
        diagnosis: "36慢性根尖周炎",
        toothPositions: "36",
      },
      token: doctorLogin.token,
    });
    log(
      "",
      `医生提交整改后, 报告状态: ${reviseResp2.report.status} (预期 PENDING_VERIFICATION)`,
      reviseResp2.report.status === "PENDING_VERIFICATION" ? "green" : "red"
    );

    // 审核员逐条确认：第一条 APPROVED，第二条 REJECTED
    const feedbacksV2 = await request(`/reports/${verifyDemoReportId}/feedbacks`, { token: qcAuditorLogin.token });
    const fieldFbsV2 = feedbacksV2.filter((f) => f.fieldName != null);
    log("", `待确认反馈 ${fieldFbsV2.length} 条`, "cyan");

    // 第一条确认通过
    const verify1 = await request(`/audit-tasks/feedbacks/${fieldFbsV2[0].id}/verify`, {
      method: "POST",
      body: { action: "APPROVED", note: "牙位已补充" },
      token: qcAuditorLogin.token,
    });
    log(
      "  V ",
      `反馈1 APPROVED, 剩余待确认: ${verify1.remainingUnverified}`,
      "cyan"
    );

    // 第二条退回 -> 报告回到 NEEDS_REVISION
    const verify2 = await request(`/audit-tasks/feedbacks/${fieldFbsV2[1].id}/verify`, {
      method: "POST",
      body: { action: "REJECTED", note: "牙位37也需要补充，不只36" },
      token: qcAuditorLogin.token,
    });
    log(
      "  X ",
      `反馈2 REJECTED, 报告状态: ${verify2.action === "REJECTED" ? "NEEDS_REVISION" : "?"} (医生需继续改)`,
      "yellow"
    );

    // 医生再次修改 -> PENDING_VERIFICATION
    const reviseResp3 = await request(`/reports/${verifyDemoReportId}/revise`, {
      method: "PUT",
      body: {
        diagnosis: "36慢性根尖周炎，37深龋",
        toothPositions: "36,37",
      },
      token: doctorLogin.token,
    });
    log(
      "",
      `医生再次整改后, 状态: ${reviseResp3.report.status} (预期 PENDING_VERIFICATION)`,
      reviseResp3.report.status === "PENDING_VERIFICATION" ? "green" : "red"
    );

    // 审核员全部确认通过 -> 闭环 RECTIFIED
    const feedbacksV3 = await request(`/reports/${verifyDemoReportId}/feedbacks`, { token: qcAuditorLogin.token });
    const fieldFbsV3 = feedbacksV3.filter((f) => f.fieldName != null && f.isResolved && f.resolvedBy === "DOCTOR");
    for (let i = 0; i < fieldFbsV3.length; i++) {
      const vResp = await request(`/audit-tasks/feedbacks/${fieldFbsV3[i].id}/verify`, {
        method: "POST",
        body: { action: "APPROVED", note: `确认通过 ${i + 1}` },
        token: qcAuditorLogin.token,
      });
      log(
        "  V ",
        `确认 ${i + 1}/${fieldFbsV3.length}: ${vResp.reportStatus || `剩余${vResp.remainingUnverified}`}`,
        vResp.reportStatus === "RECTIFIED" ? "green" : "cyan"
      );
      if (vResp.reportStatus === "RECTIFIED") break;
    }

    // 17. 复核工作台
    log("\n=== 17. 复核工作台: 多维度筛选 + 状态统计 ===", null, "green");

    const wb = await request("/reports/workbench?page=1&pageSize=5", { token: qcManagerLogin.token });
    log(
      "",
      `工作台统计: 共${wb.overview.total}份 / 待整改${wb.overview.needsRevision} / 待确认${wb.overview.pendingVerification} / 已退回${wb.overview.rejected} / 已闭环${wb.overview.rectified}`,
      "cyan"
    );
    log("", `列表 ${wb.list.length} 份，展示前3份：`, "cyan");
    wb.list.slice(0, 3).forEach((r) => {
      const stColor = r.status === "PENDING_VERIFICATION" ? "yellow" : r.status === "RECTIFIED" ? "green" : "gray";
      log(
        `  - `,
        `${r.reportNo} | ${r.status} | 待确认${r.feedbackStats.pendingVerification} / 已退回${r.feedbackStats.rejected} | 最近整改 ${new Date(r.lastRevisedAt).toLocaleString().slice(0, 10)}`,
        stColor
      );
    });

    // 18. 抽检重生成防重复
    log("\n=== 18. 抽检重生成防重复: 同日同报告不重复创建 ===", null, "green");

    const gen1 = await request("/audit-tasks/generate-daily", {
      method: "POST",
      body: { regenerateExisting: true, note: "测试防重复-第1次" },
      token: qcManagerLogin.token,
    });
    log(
      "",
      `第1次生成: total=${gen1.totalReports}, created=${gen1.createdTasks}, skipped=${gen1.skippedTasks}`,
      "cyan"
    );

    const gen2 = await request("/audit-tasks/generate-daily", {
      method: "POST",
      body: { regenerateExisting: true, note: "测试防重复-第2次" },
      token: qcManagerLogin.token,
    });
    log(
      "",
      `第2次生成: total=${gen2.totalReports}, created=${gen2.createdTasks}, skipped=${gen2.skippedTasks} (预期 skipped = 第1次 created)`,
      gen2.skippedTasks > 0 ? "green" : "yellow"
    );

    const runDetail = await request(`/sampling-runs/${gen2.runId}`, { token: qcManagerLogin.token });
    log(
      "",
      `第2次运行明细: 已存在任务=${runDetail.stats.existingCount}, 新抽中=${runDetail.stats.newCreatedCount}, 选中总计=${runDetail.stats.selectedCount}`,
      runDetail.stats.existingCount > 0 ? "green" : "yellow"
    );

    // 19. 规则变更记录 + 规则快照
    log("\n=== 19. 规则变更记录 + 规则快照追溯 ===", null, "green");

    const rcList = await request("/rule-configs", { token: qcManagerLogin.token });
    const toothRule = rcList.list.find(
      (c) => c.ruleCode === "TOOTH_POSITION_FORMAT" && c.reportType === "PANORAMIC_XRAY"
    );
    log("", `目标规则: TOOTH_POSITION_FORMAT(PAN), current ID: ${toothRule.id.slice(0, 8)}...`, "cyan");

    // 改规则
    await request(`/rule-configs/${toothRule.id}`, {
      method: "PUT",
      body: { enabled: false, severity: "WARNING" },
      token: qcManagerLogin.token,
    });
    log("  V ", `修改规则: enabled=false, severity=WARNING`, "cyan");

    // 查变更日志
    const cl = await request(`/rule-configs/${toothRule.id}/changelogs?pageSize=10`, { token: qcManagerLogin.token });
    log("", `变更记录共 ${cl.total} 条, 最近 2 条:`, "cyan");
    cl.list.slice(0, 2).forEach((l) => {
      log(
        `  - `,
        `${new Date(l.createdAt).toLocaleString().slice(0, 17)} | ${l.changedBy.name} | ${l.fieldName}: ${l.oldValue} → ${l.newValue}`,
        "gray"
      );
    });

    // 重跑规则，验证 ruleSnapshot 被保存
    const rerunRespV2 = await request(`/reports/${verifyDemoReportId}/rule-checks/rerun`, {
      method: "POST",
      token: qcManagerLogin.token,
    });
    log(
      "",
      `重跑规则, total=${rerunRespV2.total}, TOOTH_POSITION_FORMAT 已关闭规则理应不命中`,
      "cyan"
    );

    // 恢复规则
    await request(`/rule-configs/${toothRule.id}`, {
      method: "PUT",
      body: { enabled: true, severity: "ERROR" },
      token: qcManagerLogin.token,
    });
    log("  V ", `恢复规则: enabled=true, severity=ERROR`, "green");

    // 20. 工作台增强: 排序 + nextHandler + 已退回稳定入口 + issueCategory 筛选分页
    log("\n=== 20. 工作台 v4: 队列视图排序 / nextHandler / 稳定入口 / 分页筛选 ===", null, "green");

    // 20a. 各种排序
    const sortCases = [
      { by: "overdueDays", order: "desc", label: "超期天数(降序)" },
      { by: "lastRevisedAt", order: "asc", label: "最近整改时间(升序)" },
      { by: "assignedTo", order: "asc", label: "负责人(升序)" },
      { by: "reportNo", order: "desc", label: "报告编号(降序)" },
    ];
    for (const sc of sortCases) {
      const res = await request(`/reports/workbench?status=ALL_ACTIVE&pageSize=3&sortBy=${sc.by}&sortOrder=${sc.order}`, {
        token: qcManagerLogin.token,
      });
      const top = res.list[0] || {};
      const nh = top.nextHandler || {};
      log(
        "",
        `${sc.label} | top1=${top.reportNo || "-"} | nextHandler=${nh.type || "-"}${nh.userName ? "(" + nh.userName + ")" : ""} | overdue=${top.overdueDays || 0}d`,
        "cyan"
      );
    }

    // 20b. 已退回稳定入口 (REJECTED)
    // 先制造一份 NEEDS_REVISION + REJECTED 反馈的报告
    const rejectedDemo = await request("/reports", {
      method: "POST",
      body: {
        type: "CBCT",
        examName: "CBCT",
        patientName: "退回稳定入口测试",
        patientId: "REJECTED-STABLE-001",
        diagnosis: "有炎症",
        description: "疼痛",
        recommendations: "建议治疗",
        conclusions: "异常",
        toothPositions: "",
        submit: true,
      },
      token: doctorLogin.token,
    });
    const rejReportId = rejectedDemo.report.id;
    let rejTaskId;
    try {
      const t = await request("/audit-tasks/manual", {
        method: "POST",
        body: { reportId: rejReportId, assignedToId: qcAuditorLogin.user.id },
        token: qcManagerLogin.token,
      });
      rejTaskId = t.id;
    } catch (e) {
      const tasks = await request(`/audit-tasks?pageSize=20&reportId=${rejReportId}`, { token: qcManagerLogin.token });
      rejTaskId = tasks.list[0].id;
      if (!tasks.list[0].assignedToId) {
        await request(`/audit-tasks/${rejTaskId}/assign`, {
          method: "POST", body: { assignedToId: qcAuditorLogin.user.id },
          token: qcManagerLogin.token,
        });
      }
    }
    await request(`/audit-tasks/${rejTaskId}/start`, { method: "POST", token: qcAuditorLogin.token });
    await request(`/audit-tasks/${rejTaskId}/feedback`, {
      method: "POST",
      body: { issueLabel: "缺牙位", issueCategory: "DIAGNOSIS_INCOMPLETE", note: "缺牙位", fieldName: "diagnosis", oldValue: "有炎症", modification: "36炎症" },
      token: qcAuditorLogin.token,
    });
    await request(`/audit-tasks/${rejTaskId}/complete`, {
      method: "POST", body: { action: "REJECT", overallNote: "打回" },
      token: qcAuditorLogin.token,
    });
    // 医生先整改 -> PENDING_VERIFICATION -> 审核员退回 -> NEEDS_REVISION 稳定
    await request(`/reports/${rejReportId}/revise`, {
      method: "PUT", body: { diagnosis: "36炎症" },
      token: doctorLogin.token,
    });
    const rejFbs = await request(`/reports/${rejReportId}/feedbacks`, { token: qcAuditorLogin.token });
    const fieldFb = rejFbs.find((f) => f.fieldName != null && f.isResolved);
    if (fieldFb) {
      await request(`/audit-tasks/feedbacks/${fieldFb.id}/verify`, {
        method: "POST", body: { action: "REJECTED", note: "还是不对" },
        token: qcAuditorLogin.token,
      });
    }
    const rejectedWB = await request("/reports/workbench?status=REJECTED&pageSize=5", { token: qcManagerLogin.token });
    log(
      "",
      `已退回稳定入口: list.length=${rejectedWB.list.length}, overview.rejected=${rejectedWB.overview.rejected}, status 过滤正确性=${rejectedWB.list.every((r) => r.status === "NEEDS_REVISION")}`,
      rejectedWB.overview.rejected > 0 && rejectedWB.list.length >= 1 ? "green" : "yellow"
    );

    // 20c. issueCategory 筛选分页: 总数 == list.length(第一页) == 实际带该类别的数量
    const cat = "DIAGNOSIS_INCOMPLETE";
    const wbCat = await request(`/reports/workbench?issueCategory=${cat}&pageSize=5`, { token: qcManagerLogin.token });
    const listMatchesCat = wbCat.list.every((r) => (r.categories || []).includes(cat));
    log(
      "",
      `类别筛选: ${cat} | total=${wbCat.total}, page1.len=${wbCat.list.length}, 结果类别全部匹配=${listMatchesCat}`,
      wbCat.total > 0 && listMatchesCat ? "green" : "yellow"
    );

    // 20d. 批量分配复核人 + 批量提醒
    log("\n=== 20d. 批量分配 + 批量提醒 ===", null, "green");
    const activeIds = wbCat.list.slice(0, 3).map((r) => r.id);
    if (activeIds.length > 0) {
      const assignResp = await request("/reports/workbench/batch-assign", {
        method: "POST",
        body: { reportIds: activeIds, assignedToId: qcAuditorLogin.user.id },
        token: qcManagerLogin.token,
      });
      log(
        "",
        `批量分配 ${activeIds.length} 份: assigned=${assignResp.assigned}, updated=${assignResp.updatedTasks}, created=${assignResp.createdTasks}, skipped=${assignResp.skipped}, 分配给=${assignResp.assignedTo.name}`,
        assignResp.assigned > 0 ? "green" : "yellow"
      );
      const remindResp = await request("/reports/workbench/batch-remind", {
        method: "POST",
        body: { reportIds: activeIds, targetRole: "AUTO", note: "请尽快处理" },
        token: qcManagerLogin.token,
      });
      log(
        "",
        `批量提醒 AUTO: 医生=${remindResp.doctorReminded}, 审核员=${remindResp.auditorReminded}, skipped=${remindResp.skipped}, 最近提醒=${new Date(remindResp.lastRemindedAt).toLocaleTimeString().slice(0, 5)}`,
        remindResp.doctorReminded + remindResp.auditorReminded > 0 ? "green" : "yellow"
      );
    }

    // 21. 规则追溯批次化: 单报告重跑批次 + 批量重跑批次 + 批次详情(规则快照/差异对比)
    log("\n=== 21. 规则追溯批次化: 单报告批次 / 批量批次 / 差异对比 ===", null, "green");

    // 先改一条规则，再对多份报告重跑，观察差异
    const diagnoRuleV2 = rcList.list.find(
      (c) => c.ruleCode === "DIAGNOSIS_WITH_TOOTH" && c.reportType === "PANORAMIC_XRAY"
    );
    if (diagnoRuleV2) {
      await request(`/rule-configs/${diagnoRuleV2.id}`, {
        method: "PUT", body: { enabled: true, severity: "ERROR" },
        token: qcManagerLogin.token,
      });
      log("  V ", `开启 DIAGNOSIS_WITH_TOOTH(PAN): severity=ERROR`, "cyan");
    }
    const singleRerun = await request(`/reports/${rejReportId}/rule-checks/rerun`, {
      method: "POST", body: { note: "v4-单报告批次测试" },
      token: qcManagerLogin.token,
    });
    log(
      "",
      `单报告批次: batchNo=${singleRerun.batchNo?.slice(0, 14)}..., 新增问题=${singleRerun.diff?.new?.length || 0}, 消失问题=${singleRerun.diff?.removed?.length || 0}`,
      singleRerun.batchNo ? "cyan" : "red"
    );

    // 批量重跑: 针对近 30 天的 PANORAMIC_XRAY 报告
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const batchRerun = await request("/reports/rule-checks/batch-rerun", {
      method: "POST",
      body: {
        reportType: "PANORAMIC_XRAY",
        fromDate: thirtyDaysAgo,
        note: "v4-批量批次: PAN近30天",
        maxCount: 5,
      },
      token: qcManagerLogin.token,
    });
    log(
      "",
      `批量批次: batchNo=${batchRerun.batchNo?.slice(0, 14)}..., total=${batchRerun.total}, changed=${batchRerun.changedCount}, newIssues=${batchRerun.newIssueCount}, removed=${batchRerun.removedCount}`,
      batchRerun.batchId ? "cyan" : "red"
    );

    // 批次列表查询
    const bl = await request("/reports/rule-checks/batches?pageSize=5", { token: qcManagerLogin.token });
    log(
      "",
      `批次列表: 共 ${bl.total} 个批次, 最近 2 个:`,
      bl.total > 0 ? "cyan" : "red"
    );
    bl.list.slice(0, 2).forEach((b) => {
      log(
        "  - ",
        `${b.batchNo.slice(0, 14)}... | ${new Date(b.createdAt).toLocaleString().slice(0, 10)} | ${b.triggeredBy?.name} | affected=${b.affectedCount}, changed=${b.changedCount}, newIssues=${b.newIssueCount}, removed=${b.removedCount}`,
        "gray"
      );
    });

    // 批次详情: 看规则快照 + 影响的报告
    if (batchRerun.batchId) {
      const bd = await request(`/reports/rule-checks/batches/${batchRerun.batchId}`, { token: qcManagerLogin.token });
      log(
        "",
        `批次详情: 规则快照 ${bd.batch.ruleSnapshot ? "已保存 (" + bd.batch.ruleSnapshot.length + " 条配置)" : "无"}, 影响 ${bd.reportCount} 份, 本次规则检查生成了 ${bd.reports.reduce((s, r) => s + r.ruleChecks.length, 0)} 条记录`,
        bd.batch.ruleSnapshot ? "green" : "yellow"
      );
    }

    // 恢复 diagnoRule
    if (diagnoRuleV2) {
      await request(`/rule-configs/${diagnoRuleV2.id}`, {
        method: "PUT", body: { enabled: false, severity: "WARNING" },
        token: qcManagerLogin.token,
      });
      log("  V ", `恢复 DIAGNOSIS_WITH_TOOTH(PAN): enabled=false`, "green");
    }

    log("\n=== 端到端流程演示完成！ ===", null, "magenta");
  } catch (err) {
    console.error("\n错误:", err.message);
    process.exit(1);
  }
}

main();
