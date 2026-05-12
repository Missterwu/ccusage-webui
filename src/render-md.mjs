import os from "node:os";
import { cleanName } from "./render-html.mjs";

const fmtNum  = v => Number(v || 0).toLocaleString("en-US");
const fmtCost = v => `$${Number(v || 0).toFixed(2)}`;
const pct     = (part, total) => total ? `${((Number(part||0)/Number(total))*100).toFixed(1)}%` : "0.0%";
const shortModel = m => String(m || "").replace(/^claude-/, "").replace(/-202\d{5,8}$/, "");
const sum = (items, key) => items.reduce((t, i) => t + Number(i[key] || 0), 0);

const table = (headers, rows) => [
  `| ${headers.join(" | ")} |`,
  `| ${headers.map(() => "---").join(" | ")} |`,
  ...rows.map(row => `| ${row.join(" | ")} |`),
].join("\n");

const bar = (value, total, width = 18) => {
  const filled = total ? Math.max(1, Math.round((Number(value||0)/Number(total))*width)) : 0;
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
};

export function renderDailyMd(data) {
  const dailyTotals   = data.daily?.totals || {};
  const sessionTotals = data.sessions?.totals || {};
  const sessionRows   = [...(data.sessions?.sessions || [])].sort((a,b) => Number(b.totalCost||0) - Number(a.totalCost||0));
  const projectRows   = Object.entries(data.daily?.projects || {})
    .map(([project, entries]) => ({
      name: cleanName(project),
      inputTokens:          sum(entries, "inputTokens"),
      outputTokens:         sum(entries, "outputTokens"),
      cacheCreationTokens:  sum(entries, "cacheCreationTokens"),
      cacheReadTokens:      sum(entries, "cacheReadTokens"),
      totalTokens:          sum(entries, "totalTokens"),
      totalCost:            sum(entries, "totalCost"),
      modelsUsed: [...new Set(entries.flatMap(e => e.modelsUsed || []))],
    })).sort((a,b) => Number(b.totalCost||0) - Number(a.totalCost||0));

  const modelTotals = new Map();
  for (const s of sessionRows) {
    for (const m of s.modelBreakdowns || []) {
      const k = shortModel(m.modelName);
      const r = modelTotals.get(k) || { model:k, inputTokens:0, outputTokens:0, cacheCreationTokens:0, cacheReadTokens:0, totalCost:0 };
      r.inputTokens += Number(m.inputTokens||0); r.outputTokens += Number(m.outputTokens||0);
      r.cacheCreationTokens += Number(m.cacheCreationTokens||0); r.cacheReadTokens += Number(m.cacheReadTokens||0);
      r.totalCost += Number(m.cost||0);
      modelTotals.set(k, r);
    }
  }
  const modelRows = [...modelTotals.values()].sort((a,b) => Number(b.totalCost||0) - Number(a.totalCost||0));

  const md = [];
  md.push(`# Claude Code 使用报告 - ${data.date || "未知日期"}`, "");
  md.push("## 概要", "");
  md.push(table(
    ["范围","输入","输出","缓存写入","缓存读取","总 Token","费用"],
    [
      ["今天", fmtNum(dailyTotals.inputTokens), fmtNum(dailyTotals.outputTokens), fmtNum(dailyTotals.cacheCreationTokens), fmtNum(dailyTotals.cacheReadTokens), fmtNum(dailyTotals.totalTokens), fmtCost(dailyTotals.totalCost)],
    ]
  ), "");
  md.push(`- 今天费用：**${fmtCost(dailyTotals.totalCost)}**，覆盖 **${projectRows.length} 个项目**。`);
  md.push(`- 缓存读取：**${fmtNum(sessionTotals.cacheReadTokens)} tokens**，占全部会话 token 的 **${pct(sessionTotals.cacheReadTokens, sessionTotals.totalTokens)}**。`, "");

  md.push("## 各会话统计费用", "");
  md.push(table(
    ["排名","会话","模型","费用","占比","总 Token","缓存读取","最后活跃"],
    sessionRows.map((s,i) => [String(i+1), cleanName(s.sessionId), (s.modelsUsed||[]).map(shortModel).join("<br>"), fmtCost(s.totalCost), pct(s.totalCost, sessionTotals.totalCost), fmtNum(s.totalTokens), fmtNum(s.cacheReadTokens), s.lastActivity||""])
  ), "");

  md.push("## 费用分布", "");
  for (const s of sessionRows) {
    md.push(`- **${cleanName(s.sessionId)}** ${bar(s.totalCost, sessionTotals.totalCost)} ${fmtCost(s.totalCost)} (${pct(s.totalCost, sessionTotals.totalCost)})`);
  }
  md.push("");

  md.push("## 今天各项目统计", "");
  md.push(table(
    ["项目","费用","占比","总 Token","输出","缓存写入","缓存读取","模型"],
    projectRows.map(p => [p.name, fmtCost(p.totalCost), pct(p.totalCost, dailyTotals.totalCost), fmtNum(p.totalTokens), fmtNum(p.outputTokens), fmtNum(p.cacheCreationTokens), fmtNum(p.cacheReadTokens), p.modelsUsed.map(shortModel).join("<br>")])
  ), "");

  md.push("## 各模型统计费用", "");
  md.push(table(
    ["模型","费用","占比","输入","输出","缓存写入","缓存读取"],
    modelRows.map(m => [m.model, fmtCost(m.totalCost), pct(m.totalCost, sessionTotals.totalCost), fmtNum(m.inputTokens), fmtNum(m.outputTokens), fmtNum(m.cacheCreationTokens), fmtNum(m.cacheReadTokens)])
  ), "");

  md.push("## Token 构成", "");
  md.push(table(
    ["类型","Token 数","占比"],
    [["输入",fmtNum(sessionTotals.inputTokens),pct(sessionTotals.inputTokens,sessionTotals.totalTokens)],["输出",fmtNum(sessionTotals.outputTokens),pct(sessionTotals.outputTokens,sessionTotals.totalTokens)],["缓存写入",fmtNum(sessionTotals.cacheCreationTokens),pct(sessionTotals.cacheCreationTokens,sessionTotals.totalTokens)],["缓存读取",fmtNum(sessionTotals.cacheReadTokens),pct(sessionTotals.cacheReadTokens,sessionTotals.totalTokens)]]
  ), "");

  md.push("## 说明", "");
  md.push("- `费用` 是基于 ccusage/LiteLLM 价格数据计算的估算值，不一定等于最终服务商账单。");
  md.push("- `缓存读取` 可能异常大，因为长时间编码会话会反复复用缓存上下文，它实际上比普通输入/输出 token 便宜很多。");
  md.push("- 为了便于阅读，报告里的会话名经过简化，原始 JSON 中仍保留完整 ID。", "");

  return md.join("\n") + "\n";
}
