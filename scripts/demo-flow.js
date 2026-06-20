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

    const genResp = await request("/audit-tasks/generate-daily", {
      method: "POST",
      token: qcManagerLogin.token,
    });
    log("", `扫描报告: ${genResp.totalReports}, 新生成任务: ${genResp.createdTasks}`, "cyan");
    (genResp.details || []).slice(0, 10).forEach((d) => {
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

    log("\n=== 端到端流程演示完成！ ===", null, "magenta");
  } catch (err) {
    console.error("\n错误:", err.message);
    process.exit(1);
  }
}

main();
