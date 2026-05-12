#!/usr/bin/env node
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { renderDailyHtml } from "./render-html.mjs";
import { renderDailyMd } from "./render-md.mjs";

// Data directory: env override or ~/.ccusage-webui
const DIR = process.env.CCUSAGE_DATA_DIR || path.join(os.homedir(), ".ccusage-webui");
fs.mkdirSync(DIR, { recursive: true });

// Auto-discover ccusage binary
function findCcusage() {
  if (process.env.CCUSAGE_BIN) return process.env.CCUSAGE_BIN;
  try {
    const r = spawnSync("which", ["ccusage"], { encoding: "utf8", timeout: 3000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {}
  for (const c of [
    path.join(os.homedir(), ".npm-global", "bin", "ccusage"),
    path.join(os.homedir(), ".local",     "bin", "ccusage"),
    "/usr/local/bin/ccusage",
    "/opt/homebrew/bin/ccusage",
  ]) { if (fs.existsSync(c)) return c; }
  return "ccusage";
}
const CCUSAGE = findCcusage();
const PORT = Number(process.env.PORT || process.env.CCUSAGE_PORT || 7788);
const PROJECTS_DIR = path.join(os.homedir(), ".claude/projects");

// ── Helpers ──
const dateKey   = () => new Date().toISOString().slice(0,10).replace(/-/g,"");
const dateLabel = () => new Date().toISOString().slice(0,10);

// Strips project root prefix from Claude project directory slugs.
// Set CCUSAGE_PROJECT_ROOT to the parent dir of your projects for cleaner names.
const _projectRoot = (process.env.CCUSAGE_PROJECT_ROOT || os.homedir())
  .replace(/^\//, "").replace(/\//g, "-").replace(/-+$/, "");
const cleanName = raw => {
  const s = String(raw || "Unknown");
  if (s === "subagents") return "subagents";
  return s.replace(new RegExp(`^-?${_projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-?`), "")
           .replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-") || s;
};

// ── Daily export (inline, replaces export.sh) ──
function runJsonSync(args) {
  const r = spawnSync(CCUSAGE, args, { encoding: "utf8", timeout: 60000, env: { ...process.env, FORCE_COLOR: "0" } });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout);
}

function writeDailyFiles(combined) {
  const today = combined.date;
  fs.writeFileSync(path.join(DIR, `usage-${today}.json`), JSON.stringify(combined, null, 2));
  fs.writeFileSync(path.join(DIR, `usage-${today}.md`),   renderDailyMd(combined));
  fs.writeFileSync(path.join(DIR, `usage-${today}.html`), renderDailyHtml(combined, `usage-${today}.json`));
}

async function backgroundExport() {
  try {
    const dk = dateKey(), today = dateLabel();
    const runAsync = args => new Promise((res, rej) => {
      const chunks = [];
      const c = spawn(CCUSAGE, args, { env: { ...process.env, FORCE_COLOR: "0" } });
      c.stdout.on("data", d => chunks.push(d));
      c.on("close", code => {
        if (code !== 0) return rej(new Error(`exit ${code}`));
        try { res(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch(e) { rej(e); }
      });
    });
    const [daily, sessions, monthly] = await Promise.all([
      runAsync(["daily",   "--json","--no-color","--offline","--breakdown","--instances","--since",dk,"--until",dk]),
      runAsync(["session", "--json","--no-color","--offline","--breakdown","--since",dk,"--until",dk]),
      runAsync(["monthly", "--json","--no-color","--offline"]),
    ]);
    writeDailyFiles({ date: today, daily, sessions, monthly });
  } catch(e) { console.error("backgroundExport:", e.message); }
}

// args as functions so dateKey() is evaluated at request time, not server start
const COMMANDS = {
  export: {
    label: "导出今日报告", desc: "生成完整 JSON + MD + HTML 仪表盘",
    openAfter: () => `http://localhost:${PORT}/dashboard/usage-${dateLabel()}.html`,
  },
  daily: {
    label: "今日日报", desc: "按项目细分，当天数据",
    cmd: CCUSAGE,
    buildJsonArgs: () => ["daily","--json","--no-color","--offline","--breakdown","--instances","--since",dateKey(),"--until",dateKey()],
    buildArgs: () => ["daily","--no-color","--offline","--breakdown","--instances","--since",dateKey(),"--until",dateKey()],
  },
  weekly: {
    label: "本周周报", desc: "本周汇总",
    cmd: CCUSAGE,
    buildJsonArgs: () => ["weekly","--json","--no-color","--offline","--breakdown","--order","desc"],
    buildArgs: () => ["weekly","--no-color","--offline","--breakdown","--order","desc"],
  },
  monthly: {
    label: "本月月报", desc: "当月汇总",
    cmd: CCUSAGE,
    buildJsonArgs: () => ["monthly","--json","--no-color","--offline","--breakdown","--order","desc"],
    buildArgs: () => ["monthly","--no-color","--offline","--breakdown","--order","desc"],
  },
  session: {
    label: "会话明细", desc: "今日每条会话",
    cmd: CCUSAGE,
    buildJsonArgs: () => ["session","--json","--no-color","--offline","--breakdown","--since",dateKey(),"--until",dateKey(),"--order","desc"],
    buildArgs: () => ["session","--no-color","--offline","--breakdown","--since",dateKey(),"--until",dateKey(),"--order","desc"],
  },
  blocks: {
    label: "计费块总览", desc: "近期计费窗口",
    cmd: CCUSAGE, buildArgs: () => ["blocks","--no-color","--offline","--recent"],
  },
  "blocks-active": {
    label: "当前活跃块", desc: "正在进行的计费窗口",
    cmd: CCUSAGE, buildArgs: () => ["blocks","--no-color","--offline","--active"],
  },
};

const TYPE_LABELS = { daily:"日报", weekly:"周报", monthly:"月报", session:"会话", blocks:"计费块" };

// ── Project listing ──
function listProjects() {
  try {
    return fs.readdirSync(PROJECTS_DIR)
      .filter(f => { try { return fs.statSync(path.join(PROJECTS_DIR, f)).isDirectory(); } catch { return false; } })
      .map(raw => ({ raw, name: cleanName(raw) }))
      .filter(p => p.name && p.name.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

// ── Report listing ──
function listAllReports() {
  const reports = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith(".html")) continue;
    if (f.startsWith("usage-")) {
      const date = f.replace("usage-","").replace(".html","");
      reports.push({ file: f, date, time: "", sortKey: date + "T23:59", type: "dashboard", label: "完整仪表盘", mdFile: f.replace(".html",".md") });
    } else if (f.startsWith("report-")) {
      // type can contain hyphens (e.g. "blocks-active"), use non-greedy match before timestamp
      const m = f.match(/^report-(.+?)-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2})\.html$/);
      if (!m) continue;
      const typeKey = m[1], ts = m[2];
      const date = ts.slice(0,10), time = ts.slice(11).replace("-",":");
      const sortKey = date + "T" + time;
      reports.push({ file: f, date, time, sortKey, type: typeKey, label: TYPE_LABELS[typeKey] || typeKey, mdFile: f.replace(".html",".md") });
    }
  }
  return reports.sort((a, b) => b.sortKey.localeCompare(a.sortKey)).slice(0, 40);
}

// ── Report filename (pre-computed at request time) ──
function makeReportBasename(typeKey) {
  const ts = new Date().toISOString().slice(0,16).replace("T","-").replace(":","-");
  return `report-${typeKey}-${ts}`;
}

// ── JSON → HTML renderers ──
const CHART_COLORS = ["#3b82f6","#8b5cf6","#10b981","#f59e0b","#ec4899","#14b8a6","#6366f1","#ef4444","#f97316","#06b6d4"];

function fmtMoney(n) { return `$${Number(n||0).toFixed(2)}`; }
function fmtNum(n) {
  n = Number(n||0);
  if (n >= 1e9) return (n/1e9).toFixed(2)+"B";
  if (n >= 1e6) return (n/1e6).toFixed(1)+"M";
  if (n >= 1e3) return (n/1e3).toFixed(1)+"K";
  return String(n);
}
function fmtModel(m) { return String(m).replace("claude-","").replace(/-\d{8}$/,""); }
function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

const REPORT_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f1f5f9;color:#1e293b;min-height:100vh}
.hero{background:linear-gradient(135deg,#fff 0%,#f8faff 50%,#faf5ff 100%);padding:40px 48px 36px;border-bottom:1px solid #e2e8f0;position:relative;overflow:hidden}
.hero::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse 60% 80% at 20% 60%,#bfdbfe30,transparent),radial-gradient(ellipse 40% 60% at 85% 20%,#ddd6fe30,transparent);pointer-events:none}
.hero-inner{position:relative;display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:24px}
.hero-left .hero-type{font-size:13px;color:#94a3b8;font-weight:500;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
.hero-left .hero-title{font-size:40px;font-weight:800;background:linear-gradient(90deg,#2563eb,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;line-height:1.1}
.hero-left .hero-meta{font-size:15px;color:#94a3b8;margin-top:10px}
.stats{display:flex;gap:16px;flex-wrap:wrap}
.stat{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px 22px;min-width:130px;box-shadow:0 1px 3px #0000000a}
.stat-label{font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.stat-value{font-size:22px;font-weight:700;color:#1e293b;font-variant-numeric:tabular-nums}
.stat-sub{font-size:11px;color:#94a3b8;margin-top:3px}
.body{padding:36px 48px;max-width:1400px;margin:0 auto}
.panel{background:#fff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;box-shadow:0 1px 4px #0000000a;margin-bottom:24px}
.panel-head{padding:14px 24px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-size:14px;color:#64748b;font-weight:600;display:flex;align-items:center;justify-content:space-between}
.panel-head .count{font-size:12px;color:#94a3b8;font-weight:400}
table{width:100%;border-collapse:collapse}
th{padding:11px 16px;text-align:left;font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #e2e8f0;background:#fafafa;white-space:nowrap}
th.r,td.r{text-align:right}
td{padding:12px 16px;font-size:14px;color:#334155;border-bottom:1px solid #f1f5f9;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#f8fafc}
.rk{font-size:12px;color:#94a3b8;font-weight:500;width:30px;display:inline-block;text-align:right}
.nc{display:flex;align-items:center;gap:10px}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.badges{display:flex;flex-wrap:wrap;gap:4px}
.badge{font-size:11px;padding:2px 7px;border-radius:4px;background:#f1f5f9;color:#64748b;font-weight:500;white-space:nowrap}
.cost{font-weight:600;color:#1d4ed8;font-variant-numeric:tabular-nums}
.footer{text-align:center;font-size:13px;color:#cbd5e1;padding:24px 48px}
.lang-toggle{padding:5px 13px;border-radius:7px;border:1px solid #e2e8f0;background:#f8fafc;color:#64748b;cursor:pointer;font-size:12px;font-weight:600;letter-spacing:.05em;transition:all .15s;line-height:1}
.lang-toggle:hover{background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe}
`;

const I18N_SCRIPT = `<script>
(function(){
const D={
zh:{
  "page.title":"ccusage-webui","page.subtitle":"Claude Code 用量分析工具",
  "section.quick":"快捷操作","section.query":"自定义查询","section.history":"历史记录",
  "query.type":"报告类型","query.dateRange":"日期范围","query.to":"至",
  "query.blocksRange":"计费范围","query.project":"项目过滤","query.order":"排序方式",
  "tab.daily":"日报","tab.weekly":"周报","tab.monthly":"月报","tab.session":"会话","tab.blocks":"计费块",
  "blocks.recent":"近期记录","blocks.active":"当前活跃",
  "project.all":"全部项目","order.desc":"降序（最新在前）","order.asc":"升序（最旧在前）",
  "btn.run":"执行查询","out.placeholder":"— 点击按钮或执行查询 —","out.view":"查看报告 →",
  "history.empty":"暂无历史记录。","history.view":"查看报告","history.md":"MD 存档","history.today":"今天",
  "badge.dashboard":"仪表盘","badge.daily":"日报","badge.weekly":"周报","badge.monthly":"月报","badge.session":"会话","badge.blocks":"计费块",
  "cmd.export":"导出今日报告","cmd.export.d":"生成完整 JSON + MD + HTML 仪表盘",
  "cmd.daily":"今日日报","cmd.daily.d":"按项目细分，当天数据",
  "cmd.weekly":"本周周报","cmd.weekly.d":"本周汇总",
  "cmd.monthly":"本月月报","cmd.monthly.d":"当月汇总",
  "cmd.session":"会话明细","cmd.session.d":"今日每条会话",
  "cmd.blocks":"计费块总览","cmd.blocks.d":"近期计费窗口",
  "cmd.blocks-active":"当前活跃块","cmd.blocks-active.d":"正在进行的计费窗口",
  "rpt.subtitle":"ccusage 查询报告","rpt.source":"来源：ccusage CLI",
  "st.cost":"总费用","st.projects":"项目数","st.tokens":"总 Tokens","st.cacheRead":"缓存读取",
  "st.sessions":"会话数","st.allTime":"历史总计","st.months":"月份数","st.weeks":"周数",
  "st.in":"输入","st.out":"输出","st.cacheWrite":"写入",
  "th.rank":"#","th.project":"项目","th.date":"日期","th.cost":"费用","th.tokens":"总 Tokens",
  "th.in":"输入","th.out":"输出","th.cacheW":"缓存写","th.cacheR":"缓存读","th.models":"模型",
  "th.lastAct":"最后活跃","th.month":"月份","th.week":"周起始日",
  "panel.projects":"各项目明细","panel.sessions":"会话列表","panel.monthly":"月度明细","panel.weekly":"周度明细",
  "unit.items":"条","unit.months":"个月","unit.weeks":"周"
},
en:{
  "page.title":"ccusage-webui","page.subtitle":"Claude Code Usage Analytics",
  "section.quick":"Quick Actions","section.query":"Custom Query","section.history":"History",
  "query.type":"Report Type","query.dateRange":"Date Range","query.to":"to",
  "query.blocksRange":"Billing Range","query.project":"Project Filter","query.order":"Sort Order",
  "tab.daily":"Daily","tab.weekly":"Weekly","tab.monthly":"Monthly","tab.session":"Sessions","tab.blocks":"Blocks",
  "blocks.recent":"Recent","blocks.active":"Active",
  "project.all":"All Projects","order.desc":"Newest first","order.asc":"Oldest first",
  "btn.run":"Run Query","out.placeholder":"— Click a button or run a query —","out.view":"View Report →",
  "history.empty":"No reports yet.","history.view":"View Report","history.md":"MD Archive","history.today":"Today",
  "badge.dashboard":"Dashboard","badge.daily":"Daily","badge.weekly":"Weekly","badge.monthly":"Monthly","badge.session":"Session","badge.blocks":"Blocks",
  "cmd.export":"Export Today","cmd.export.d":"Generate full JSON + MD + HTML dashboard",
  "cmd.daily":"Today's Report","cmd.daily.d":"Per-project breakdown for today",
  "cmd.weekly":"This Week","cmd.weekly.d":"Weekly summary",
  "cmd.monthly":"This Month","cmd.monthly.d":"Monthly summary",
  "cmd.session":"Sessions","cmd.session.d":"Today's conversation sessions",
  "cmd.blocks":"Billing Blocks","cmd.blocks.d":"Recent billing windows",
  "cmd.blocks-active":"Active Block","cmd.blocks-active.d":"Current billing window",
  "rpt.subtitle":"ccusage Query Report","rpt.source":"Source: ccusage CLI",
  "st.cost":"Total Cost","st.projects":"Projects","st.tokens":"Total Tokens","st.cacheRead":"Cache Read",
  "st.sessions":"Sessions","st.allTime":"All Time","st.months":"Months","st.weeks":"Weeks",
  "st.in":"Input","st.out":"Output","st.cacheWrite":"Write",
  "th.rank":"#","th.project":"Project","th.date":"Date","th.cost":"Cost","th.tokens":"Total Tokens",
  "th.in":"Input","th.out":"Output","th.cacheW":"Cache Write","th.cacheR":"Cache Read","th.models":"Models",
  "th.lastAct":"Last Active","th.month":"Month","th.week":"Week Start",
  "panel.projects":"Project Breakdown","panel.sessions":"Session List","panel.monthly":"Monthly Breakdown","panel.weekly":"Weekly Breakdown",
  "unit.items":"items","unit.months":"months","unit.weeks":"weeks"
}};
let _L=localStorage.getItem("ccusage-lang")||"zh";
window.t=k=>(D[_L]||D.zh)[k]||k;
window.setLang=function(l){
  _L=l;localStorage.setItem("ccusage-lang",l);
  document.querySelectorAll("[data-i18n]").forEach(el=>el.textContent=window.t(el.dataset.i18n));
  document.documentElement.lang=l==="zh"?"zh-CN":"en";
  const b=document.getElementById("lang-toggle");if(b)b.textContent=l==="zh"?"EN":"中文";
};
document.addEventListener("DOMContentLoaded",()=>window.setLang(_L));
})();
<\/script>`;

function buildReportPage(typeLabel, date, time, params, statsHTML, bodyHTML) {
  const paramStr = Object.entries(params).filter(([,v])=>v).map(([k,v])=>`${k}: ${v}`).join("　·　");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ccusage ${esc(typeLabel)} · ${esc(date)}</title>
<style>${REPORT_CSS}</style></head>
<body>
<div class="hero"><div class="hero-inner">
  <div class="hero-left">
    <div class="hero-type" data-i18n="rpt.subtitle">ccusage 查询报告</div>
    <div class="hero-title">${esc(typeLabel)}</div>
    <div class="hero-meta"><b>${esc(date)}</b>${time?" "+esc(time):""}${paramStr?"　·　"+paramStr:""}</div>
  </div>
  <div style="display:flex;flex-direction:column;align-items:flex-end;gap:12px">
    <button id="lang-toggle" class="lang-toggle" onclick="setLang(this.textContent==='EN'?'en':'zh')">EN</button>
    <div class="stats">${statsHTML}</div>
  </div>
</div></div>
<div class="body">${bodyHTML}</div>
<div class="footer" data-i18n="rpt.source">来源：ccusage CLI</div>
${I18N_SCRIPT}
</body></html>`;
}

function renderDailyWeeklyHTML(jsonData, typeLabel, date, time, params) {
  const projects = jsonData.projects || {};
  const rows = [];
  let totCost=0, totTok=0, totIn=0, totOut=0, totCC=0, totCR=0;
  for (const [rawPath, days] of Object.entries(projects)) {
    for (const day of (Array.isArray(days)?days:[])) {
      const cost=Number(day.totalCost||0), tok=Number(day.totalTokens||0);
      rows.push({ name:cleanName(rawPath), date:day.date||"", cost, tok,
        inp:day.inputTokens||0, out:day.outputTokens||0,
        cc:day.cacheCreationTokens||0, cr:day.cacheReadTokens||0,
        models:day.modelsUsed||[] });
      totCost+=cost; totTok+=tok;
      totIn+=day.inputTokens||0; totOut+=day.outputTokens||0;
      totCC+=day.cacheCreationTokens||0; totCR+=day.cacheReadTokens||0;
    }
  }
  rows.sort((a,b)=>b.cost-a.cost);
  const multiDay = rows.some(r=>r.date) && new Set(rows.map(r=>r.date)).size > 1;
  const statsHTML = `
    <div class="stat"><div class="stat-label" data-i18n="st.cost">总费用</div><div class="stat-value">${fmtMoney(totCost)}</div></div>
    <div class="stat"><div class="stat-label" data-i18n="st.projects">项目数</div><div class="stat-value">${Object.keys(projects).length}</div></div>
    <div class="stat"><div class="stat-label" data-i18n="st.tokens">总 Tokens</div><div class="stat-value">${fmtNum(totTok)}</div><div class="stat-sub"><span data-i18n="st.in">输入</span> ${fmtNum(totIn)} · <span data-i18n="st.out">输出</span> ${fmtNum(totOut)}</div></div>
    <div class="stat"><div class="stat-label" data-i18n="st.cacheRead">缓存读取</div><div class="stat-value">${fmtNum(totCR)}</div><div class="stat-sub"><span data-i18n="st.cacheWrite">写入</span> ${fmtNum(totCC)}</div></div>`;
  const tableHTML = `<div class="panel">
    <div class="panel-head"><span data-i18n="panel.projects">各项目明细</span> <span class="count">${rows.length} <span data-i18n="unit.items">条</span></span></div>
    <table><thead><tr>
      <th data-i18n="th.rank">#</th><th data-i18n="th.project">项目</th>${multiDay?'<th data-i18n="th.date">日期</th>':""}
      <th class="r" data-i18n="th.cost">费用</th><th class="r" data-i18n="th.tokens">总 Tokens</th>
      <th class="r" data-i18n="th.in">输入</th><th class="r" data-i18n="th.out">输出</th>
      <th class="r" data-i18n="th.cacheW">缓存写</th><th class="r" data-i18n="th.cacheR">缓存读</th><th data-i18n="th.models">模型</th>
    </tr></thead><tbody>${rows.map((r,i)=>`<tr>
      <td><span class="rk">${i+1}</span></td>
      <td><div class="nc"><span class="dot" style="background:${CHART_COLORS[i%CHART_COLORS.length]}"></span>${esc(r.name)}</div></td>
      ${multiDay?`<td>${esc(r.date)}</td>`:""}
      <td class="r cost">${fmtMoney(r.cost)}</td><td class="r">${fmtNum(r.tok)}</td>
      <td class="r">${fmtNum(r.inp)}</td><td class="r">${fmtNum(r.out)}</td>
      <td class="r">${fmtNum(r.cc)}</td><td class="r">${fmtNum(r.cr)}</td>
      <td><div class="badges">${r.models.map(m=>`<span class="badge">${esc(fmtModel(m))}</span>`).join("")}</div></td>
    </tr>`).join("")}</tbody></table></div>`;
  return buildReportPage(typeLabel, date, time, params, statsHTML, tableHTML);
}

function renderSessionHTML(jsonData, typeLabel, date, time, params) {
  const sessions = [...(jsonData.sessions||[])].sort((a,b)=>Number(b.totalCost||0)-Number(a.totalCost||0));
  const totals = jsonData.totals||{};
  const statsHTML = `
    <div class="stat"><div class="stat-label" data-i18n="st.cost">总费用</div><div class="stat-value">${fmtMoney(totals.totalCost)}</div></div>
    <div class="stat"><div class="stat-label" data-i18n="st.sessions">会话数</div><div class="stat-value">${sessions.length}</div></div>
    <div class="stat"><div class="stat-label" data-i18n="st.tokens">总 Tokens</div><div class="stat-value">${fmtNum(totals.totalTokens)}</div><div class="stat-sub"><span data-i18n="st.in">输入</span> ${fmtNum(totals.inputTokens)} · <span data-i18n="st.out">输出</span> ${fmtNum(totals.outputTokens)}</div></div>
    <div class="stat"><div class="stat-label" data-i18n="st.cacheRead">缓存读取</div><div class="stat-value">${fmtNum(totals.cacheReadTokens)}</div><div class="stat-sub"><span data-i18n="st.cacheWrite">写入</span> ${fmtNum(totals.cacheCreationTokens)}</div></div>`;
  const tableHTML = `<div class="panel">
    <div class="panel-head"><span data-i18n="panel.sessions">会话列表</span> <span class="count">${sessions.length} <span data-i18n="unit.items">条</span></span></div>
    <table><thead><tr>
      <th data-i18n="th.rank">#</th><th data-i18n="th.project">项目</th><th data-i18n="th.lastAct">最后活跃</th>
      <th class="r" data-i18n="th.cost">费用</th><th class="r" data-i18n="th.tokens">总 Tokens</th>
      <th class="r" data-i18n="th.out">输出</th><th class="r" data-i18n="th.cacheR">缓存读</th><th data-i18n="th.models">模型</th>
    </tr></thead><tbody>${sessions.map((s,i)=>`<tr>
      <td><span class="rk">${i+1}</span></td>
      <td><div class="nc"><span class="dot" style="background:${CHART_COLORS[i%CHART_COLORS.length]}"></span>${esc(cleanName(s.sessionId||s.projectPath||"?"))}</div></td>
      <td>${esc(s.lastActivity||"")}</td>
      <td class="r cost">${fmtMoney(s.totalCost)}</td>
      <td class="r">${fmtNum(s.totalTokens)}</td>
      <td class="r">${fmtNum(s.outputTokens)}</td>
      <td class="r">${fmtNum(s.cacheReadTokens)}</td>
      <td><div class="badges">${(s.modelsUsed||[]).map(m=>`<span class="badge">${esc(fmtModel(m))}</span>`).join("")}</div></td>
    </tr>`).join("")}</tbody></table></div>`;
  return buildReportPage(typeLabel, date, time, params, statsHTML, tableHTML);
}

function renderMonthlyHTML(jsonData, typeLabel, date, time, params) {
  const monthly = [...(jsonData.monthly||[])].sort((a,b)=>(b.month||"").localeCompare(a.month||""));
  const totals = jsonData.totals||{};
  const statsHTML = `
    <div class="stat"><div class="stat-label" data-i18n="st.allTime">历史总计</div><div class="stat-value">${fmtMoney(totals.totalCost)}</div></div>
    <div class="stat"><div class="stat-label" data-i18n="st.months">月份数</div><div class="stat-value">${monthly.length}</div></div>
    <div class="stat"><div class="stat-label" data-i18n="st.tokens">总 Tokens</div><div class="stat-value">${fmtNum(totals.totalTokens)}</div><div class="stat-sub"><span data-i18n="st.in">输入</span> ${fmtNum(totals.inputTokens)} · <span data-i18n="st.out">输出</span> ${fmtNum(totals.outputTokens)}</div></div>
    <div class="stat"><div class="stat-label" data-i18n="st.cacheRead">缓存读取</div><div class="stat-value">${fmtNum(totals.cacheReadTokens)}</div><div class="stat-sub"><span data-i18n="st.cacheWrite">写入</span> ${fmtNum(totals.cacheCreationTokens)}</div></div>`;
  const tableHTML = `<div class="panel">
    <div class="panel-head"><span data-i18n="panel.monthly">月度明细</span> <span class="count">${monthly.length} <span data-i18n="unit.months">个月</span></span></div>
    <table><thead><tr>
      <th data-i18n="th.rank">#</th><th data-i18n="th.month">月份</th>
      <th class="r" data-i18n="th.cost">费用</th><th class="r" data-i18n="th.tokens">总 Tokens</th>
      <th class="r" data-i18n="th.in">输入</th><th class="r" data-i18n="th.out">输出</th>
      <th class="r" data-i18n="th.cacheW">缓存写</th><th class="r" data-i18n="th.cacheR">缓存读</th><th data-i18n="th.models">模型</th>
    </tr></thead><tbody>${monthly.map((m,i)=>`<tr>
      <td><span class="rk">${i+1}</span></td>
      <td><b>${esc(m.month||"")}</b></td>
      <td class="r cost">${fmtMoney(m.totalCost)}</td>
      <td class="r">${fmtNum(m.totalTokens)}</td>
      <td class="r">${fmtNum(m.inputTokens)}</td>
      <td class="r">${fmtNum(m.outputTokens)}</td>
      <td class="r">${fmtNum(m.cacheCreationTokens)}</td>
      <td class="r">${fmtNum(m.cacheReadTokens)}</td>
      <td><div class="badges">${(m.modelsUsed||[]).map(mo=>`<span class="badge">${esc(fmtModel(mo))}</span>`).join("")}</div></td>
    </tr>`).join("")}</tbody></table></div>`;
  return buildReportPage(typeLabel, date, time, params, statsHTML, tableHTML);
}

function renderWeeklyHTML(jsonData, typeLabel, date, time, params) {
  const weekly = [...(jsonData.weekly||[])].sort((a,b)=>(b.week||"").localeCompare(a.week||""));
  const totals = jsonData.totals||{};
  const statsHTML = `
    <div class="stat"><div class="stat-label" data-i18n="st.allTime">历史总计</div><div class="stat-value">${fmtMoney(totals.totalCost)}</div></div>
    <div class="stat"><div class="stat-label" data-i18n="st.weeks">周数</div><div class="stat-value">${weekly.length}</div></div>
    <div class="stat"><div class="stat-label" data-i18n="st.tokens">总 Tokens</div><div class="stat-value">${fmtNum(totals.totalTokens)}</div><div class="stat-sub"><span data-i18n="st.in">输入</span> ${fmtNum(totals.inputTokens)} · <span data-i18n="st.out">输出</span> ${fmtNum(totals.outputTokens)}</div></div>
    <div class="stat"><div class="stat-label" data-i18n="st.cacheRead">缓存读取</div><div class="stat-value">${fmtNum(totals.cacheReadTokens)}</div><div class="stat-sub"><span data-i18n="st.cacheWrite">写入</span> ${fmtNum(totals.cacheCreationTokens)}</div></div>`;
  const tableHTML = `<div class="panel">
    <div class="panel-head"><span data-i18n="panel.weekly">周度明细</span> <span class="count">${weekly.length} <span data-i18n="unit.weeks">周</span></span></div>
    <table><thead><tr>
      <th data-i18n="th.rank">#</th><th data-i18n="th.week">周起始日</th>
      <th class="r" data-i18n="th.cost">费用</th><th class="r" data-i18n="th.tokens">总 Tokens</th>
      <th class="r" data-i18n="th.in">输入</th><th class="r" data-i18n="th.out">输出</th>
      <th class="r" data-i18n="th.cacheW">缓存写</th><th class="r" data-i18n="th.cacheR">缓存读</th><th data-i18n="th.models">模型</th>
    </tr></thead><tbody>${weekly.map((w,i)=>`<tr>
      <td><span class="rk">${i+1}</span></td>
      <td><b>${esc(w.week||"")}</b></td>
      <td class="r cost">${fmtMoney(w.totalCost)}</td>
      <td class="r">${fmtNum(w.totalTokens)}</td>
      <td class="r">${fmtNum(w.inputTokens)}</td>
      <td class="r">${fmtNum(w.outputTokens)}</td>
      <td class="r">${fmtNum(w.cacheCreationTokens)}</td>
      <td class="r">${fmtNum(w.cacheReadTokens)}</td>
      <td><div class="badges">${(w.modelsUsed||[]).map(mo=>`<span class="badge">${esc(fmtModel(mo))}</span>`).join("")}</div></td>
    </tr>`).join("")}</tbody></table></div>`;
  return buildReportPage(typeLabel, date, time, params, statsHTML, tableHTML);
}

function renderQueryHTML(type, jsonData, typeLabel, date, time, params) {
  if (type==="daily") return renderDailyWeeklyHTML(jsonData, typeLabel, date, time, params);
  if (type==="weekly") return renderWeeklyHTML(jsonData, typeLabel, date, time, params);
  if (type==="session") return renderSessionHTML(jsonData, typeLabel, date, time, params);
  if (type==="monthly") return renderMonthlyHTML(jsonData, typeLabel, date, time, params);
  return null;
}

function formatJsonSummary(type, typeLabel, jsonData) {
  const lines = [`◆ ${typeLabel}`, ""];
  try {
    if (type==="daily") {
      const projects = jsonData.projects||{};
      let totCost=0, totTok=0;
      const rows = [];
      for (const [rawPath, days] of Object.entries(projects)) {
        for (const day of (Array.isArray(days)?days:[])) {
          const cost=Number(day.totalCost||0);
          totCost+=cost; totTok+=Number(day.totalTokens||0);
          rows.push({ name:cleanName(rawPath), cost, date:day.date||"" });
        }
      }
      rows.sort((a,b)=>b.cost-a.cost);
      const multiDay = new Set(rows.map(r=>r.date)).size > 1;
      lines.push(`总费用：${fmtMoney(totCost)}　 总 Tokens：${fmtNum(totTok)}　 项目数：${Object.keys(projects).length}`, "");
      rows.slice(0,15).forEach((r,i)=>lines.push(`  ${String(i+1).padStart(2)}. ${(multiDay?r.date+" ":"")+r.name.padEnd(30)} ${fmtMoney(r.cost)}`));
    } else if (type==="weekly") {
      const weekly = [...(jsonData.weekly||[])].sort((a,b)=>(b.week||"").localeCompare(a.week||""));
      const t = jsonData.totals||{};
      lines.push(`历史总计：${fmtMoney(t.totalCost)}　 总 Tokens：${fmtNum(t.totalTokens)}　 周数：${weekly.length}`, "");
      weekly.forEach((w,i)=>lines.push(`  ${String(i+1).padStart(2)}. ${(w.week||"").padEnd(12)} ${fmtMoney(w.totalCost)}`));
    } else if (type==="session") {
      const sessions = [...(jsonData.sessions||[])].sort((a,b)=>Number(b.totalCost||0)-Number(a.totalCost||0));
      const t = jsonData.totals||{};
      lines.push(`总费用：${fmtMoney(t.totalCost)}　 总 Tokens：${fmtNum(t.totalTokens)}　 会话数：${sessions.length}`, "");
      sessions.slice(0,15).forEach((s,i)=>lines.push(`  ${String(i+1).padStart(2)}. ${cleanName(s.sessionId||"?").padEnd(30)} ${fmtMoney(s.totalCost)}`));
    } else if (type==="monthly") {
      const monthly = [...(jsonData.monthly||[])].sort((a,b)=>(b.month||"").localeCompare(a.month||""));
      const t = jsonData.totals||{};
      lines.push(`历史总计：${fmtMoney(t.totalCost)}　 总 Tokens：${fmtNum(t.totalTokens)}　 月份数：${monthly.length}`, "");
      monthly.forEach((m,i)=>lines.push(`  ${String(i+1).padStart(2)}. ${(m.month||"").padEnd(10)} ${fmtMoney(m.totalCost)}`));
    }
  } catch(e) { lines.push(`(解析错误: ${e.message})`); }
  lines.push("", "✓ 报告已生成，点击「查看报告」查看详情。");
  return lines.join("\n");
}

// ── Simple report HTML (fallback for blocks / text-only) ──
function generateReportHTML(typeLabel, date, time, params, outputText) {
  const paramStr = Object.entries(params).filter(([,v])=>v).map(([k,v])=>`${k}: ${v}`).join("　·　");
  const escaped = outputText.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ccusage ${typeLabel} · ${date}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f1f5f9;color:#1e293b;min-height:100vh}
.hero{background:linear-gradient(135deg,#fff 0%,#f8faff 50%,#faf5ff 100%);padding:40px 48px 36px;border-bottom:1px solid #e2e8f0;position:relative;overflow:hidden}
.hero::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse 60% 80% at 20% 60%,#bfdbfe30,transparent),radial-gradient(ellipse 40% 60% at 85% 20%,#ddd6fe30,transparent);pointer-events:none}
.hero-inner{position:relative}
.hero-type{font-size:13px;color:#94a3b8;font-weight:500;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
.hero-title{font-size:40px;font-weight:800;background:linear-gradient(90deg,#2563eb,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;line-height:1.1}
.hero-meta{font-size:15px;color:#94a3b8;margin-top:10px}
.hero-meta b{color:#475569}
.body{padding:36px 48px;max-width:1400px;margin:0 auto}
.panel{background:#fff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;box-shadow:0 1px 4px #0000000a}
.panel-head{padding:14px 24px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-size:14px;color:#64748b;font-weight:500}
pre{padding:28px;font-size:14px;line-height:1.75;overflow-x:auto;white-space:pre-wrap;word-break:break-all;color:#334155;font-family:"SF Mono",Monaco,Consolas,monospace;background:#f8fafc;min-height:80px}
.footer{text-align:center;font-size:13px;color:#cbd5e1;padding:24px 48px}
</style>
</head>
<body>
<div class="hero"><div class="hero-inner">
  <div class="hero-type">ccusage 查询报告</div>
  <div class="hero-title">${typeLabel}</div>
  <div class="hero-meta"><b>${date}</b> ${time}${paramStr ? "　·　" + paramStr : ""}</div>
</div></div>
<div class="body">
  <div class="panel">
    <div class="panel-head">查询输出</div>
    <pre>${escaped}</pre>
  </div>
</div>
<div class="footer">来源：ccusage CLI</div>
</body></html>`;
}

function saveReport(basename, typeLabel, params, outputText, jsonData) {
  try {
    const date = basename.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || dateLabel();
    const timePart = basename.match(/\d{4}-\d{2}-\d{2}-(\d{2}-\d{2})$/)?.[1] || "";
    const time = timePart.replace("-",":");
    const paramLines = Object.entries(params).filter(([,v])=>v).map(([k,v])=>`- **${k}**: ${v}`).join("\n");
    fs.writeFileSync(path.join(DIR, basename+".md"), `# ${typeLabel}\n\n**日期：** ${date} ${time}\n${paramLines}\n\n\`\`\`\n${outputText}\n\`\`\`\n`, "utf8");
    let html = null;
    if (jsonData) {
      const type = basename.match(/^report-(.+?)-\d{4}/)?.[1] || "";
      try { html = renderQueryHTML(type, jsonData, typeLabel, date, time, params); } catch(e) { console.error("renderQueryHTML:", e.message); }
    }
    fs.writeFileSync(path.join(DIR, basename+".html"), html || generateReportHTML(typeLabel, date, time, params, outputText), "utf8");
  } catch(e) { console.error("saveReport:", e.message); }
}

// ── HOME HTML ──
const HOME_HTML = () => {
  const today = dateLabel();
  const todayFile = `usage-${today}.html`;
  const reports = listAllReports();

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ccusage-webui</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f1f5f9;color:#1e293b;min-height:100vh;font-size:16px}

.header{background:linear-gradient(135deg,#fff 0%,#f8faff 50%,#faf5ff 100%);padding:36px 48px 32px;border-bottom:1px solid #e2e8f0;position:relative;overflow:hidden}
.header::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse 60% 100% at 20% 50%,#bfdbfe20,transparent),radial-gradient(ellipse 40% 80% at 85% 30%,#ddd6fe20,transparent);pointer-events:none}
.header-inner{position:relative;display:flex;justify-content:space-between;align-items:center;gap:24px;flex-wrap:wrap}
.header-title{font-size:28px;font-weight:800;background:linear-gradient(90deg,#2563eb,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;letter-spacing:-.02em}
.header-sub{font-size:15px;color:#94a3b8;margin-top:6px}
.header-date{font-size:15px;color:#64748b;background:#f8fafc;border:1px solid #e2e8f0;padding:8px 18px;border-radius:8px;font-variant-numeric:tabular-nums}
.lang-toggle{padding:5px 13px;border-radius:7px;border:1px solid #e2e8f0;background:#f8fafc;color:#64748b;cursor:pointer;font-size:12px;font-weight:600;letter-spacing:.05em;transition:all .15s;line-height:1}
.lang-toggle:hover{background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe}

.body{padding:32px 48px;max-width:1400px;margin:0 auto}
.section{margin-bottom:32px}
.section-title{font-size:20px;font-weight:600;color:#475569;margin-bottom:18px}

/* ── Quick Buttons ── */
.btn-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.btn{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:20px 22px;cursor:pointer;text-align:left;transition:background .15s,border-color .15s,box-shadow .15s,transform .1s;color:#1e293b;width:100%;box-shadow:0 1px 3px #0000000a}
.btn:hover{background:#f8fafc;border-color:#cbd5e1;box-shadow:0 4px 12px #0000001a}
.btn:active{transform:scale(.98)}
.btn.primary{border-color:#bfdbfe;background:linear-gradient(135deg,#eff6ff,#f5f3ff)}
.btn-label{font-size:16px;font-weight:600;display:block;margin-bottom:5px;color:#334155}
.btn.primary .btn-label{color:#1d4ed8}
.btn-desc{font-size:13px;color:#94a3b8;line-height:1.4}

/* ── Custom Query Panel ── */
.panel{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:24px 28px;box-shadow:0 1px 4px #0000000a}
.query-grid{display:grid;grid-template-columns:auto 1fr;gap:14px 20px;align-items:center}
.query-label{font-size:14px;font-weight:500;color:#64748b;white-space:nowrap}
.type-tabs{display:flex;gap:8px;flex-wrap:wrap}
.type-tab{padding:7px 16px;border-radius:8px;border:1px solid #e2e8f0;background:#f8fafc;color:#64748b;cursor:pointer;font-size:14px;font-weight:500;transition:all .15s}
.type-tab:hover{border-color:#cbd5e1;color:#334155}
.type-tab.active{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8}
.date-row{display:flex;align-items:center;gap:10px}
.date-row input[type=date],.date-row input[type=month]{padding:7px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;color:#334155;background:#f8fafc;outline:none;transition:border-color .15s}
.date-row input:focus{border-color:#93c5fd}
.date-sep{color:#94a3b8;font-size:14px}
select{padding:7px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;color:#334155;background:#f8fafc;outline:none;cursor:pointer;transition:border-color .15s;min-width:180px}
select:focus{border-color:#93c5fd}
.radio-row{display:flex;gap:16px}
.radio-row label{display:flex;align-items:center;gap:6px;font-size:14px;color:#475569;cursor:pointer}
.exec-btn{padding:9px 24px;border-radius:9px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;border:none;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .15s,transform .1s;box-shadow:0 2px 8px #2563eb30}
.exec-btn:hover{opacity:.9}
.exec-btn:active{transform:scale(.98)}
.hidden{display:none}

/* ── Output ── */
.output-box{background:#fff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;box-shadow:0 1px 4px #0000000a}
.output-head{padding:14px 22px;background:#f8fafc;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;gap:12px}
.output-label{font-size:15px;font-weight:500;color:#94a3b8}
.output-label.active{color:#2563eb}
.output-actions{display:flex;align-items:center;gap:12px}
.view-report-btn{font-size:13px;padding:5px 14px;border-radius:6px;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;cursor:pointer;text-decoration:none;display:none;white-space:nowrap}
pre{padding:22px;font-size:14px;line-height:1.7;overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:520px;overflow-y:auto;color:#475569;font-family:"SF Mono",Monaco,monospace;min-height:56px;background:#f8fafc}

/* ── History ── */
.dash-list{display:flex;flex-direction:column;gap:9px}
.dash-item{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;transition:border-color .15s,box-shadow .15s;box-shadow:0 1px 3px #0000000a;gap:12px;flex-wrap:wrap}
.dash-item:hover{border-color:#cbd5e1;box-shadow:0 4px 12px #0000001a}
.dash-left{display:flex;align-items:center;gap:12px}
.report-badge{font-size:12px;padding:3px 10px;border-radius:6px;font-weight:600;white-space:nowrap;flex-shrink:0}
.badge-dashboard{background:#d1fae5;color:#065f46;border:1px solid #a7f3d0}
.badge-daily{background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe}
.badge-weekly{background:#ede9fe;color:#5b21b6;border:1px solid #ddd6fe}
.badge-monthly{background:#fef3c7;color:#92400e;border:1px solid #fde68a}
.badge-session{background:#fce7f3;color:#9d174d;border:1px solid #fbcfe8}
.badge-blocks{background:#ccfbf1;color:#134e4a;border:1px solid #99f6e4}
.dash-info{min-width:0}
.dash-date{font-size:16px;font-weight:600;color:#334155;font-variant-numeric:tabular-nums}
.dash-time{font-size:13px;color:#94a3b8;margin-top:1px}
.dash-actions{display:flex;gap:8px;align-items:center;flex-shrink:0}
.link-btn{font-size:13px;padding:6px 14px;border-radius:7px;background:#f8fafc;color:#64748b;border:1px solid #e2e8f0;cursor:pointer;text-decoration:none;transition:all .15s;white-space:nowrap}
.link-btn:hover{background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe}
.today-tag{font-size:12px;padding:3px 10px;border-radius:6px;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;font-weight:600}
.empty{font-size:15px;color:#94a3b8;padding:20px 0}

/* ── Spinner ── */
.spinner{display:none;width:16px;height:16px;border:2px solid #e2e8f0;border-top-color:#2563eb;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
.spinner.show{display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>

<div class="header">
  <div class="header-inner">
    <div>
      <div class="header-title" data-i18n="page.title">ccusage-webui</div>
      <div class="header-sub" data-i18n="page.subtitle">Claude Code 用量分析工具</div>
    </div>
    <div style="display:flex;align-items:center;gap:12px">
      <button id="lang-toggle" class="lang-toggle" onclick="setLang(this.textContent==='EN'?'en':'zh')">EN</button>
      <div class="header-date">${today}</div>
    </div>
  </div>
</div>

<div class="body">

  <!-- Quick Actions -->
  <div class="section">
    <div class="section-title" data-i18n="section.quick">快捷操作</div>
    <div class="btn-grid">
      ${Object.entries(COMMANDS).map(([key, cmd]) => `
      <button class="btn${key==="export"?" primary":""}" onclick="runQuick('${key}','cmd.${key}')">
        <span class="btn-label" data-i18n="cmd.${key}">${cmd.label}</span>
        <span class="btn-desc" data-i18n="cmd.${key}.d">${cmd.desc}</span>
      </button>`).join("")}
    </div>
  </div>

  <!-- Custom Query -->
  <div class="section">
    <div class="section-title" data-i18n="section.query">自定义查询</div>
    <div class="panel">
      <div class="query-grid">

        <span class="query-label" data-i18n="query.type">报告类型</span>
        <div class="type-tabs">
          <button class="type-tab active" data-type="daily" onclick="setType('daily',this)" data-i18n="tab.daily">日报</button>
          <button class="type-tab" data-type="weekly" onclick="setType('weekly',this)" data-i18n="tab.weekly">周报</button>
          <button class="type-tab" data-type="monthly" onclick="setType('monthly',this)" data-i18n="tab.monthly">月报</button>
          <button class="type-tab" data-type="session" onclick="setType('session',this)" data-i18n="tab.session">会话</button>
          <button class="type-tab" data-type="blocks" onclick="setType('blocks',this)" data-i18n="tab.blocks">计费块</button>
        </div>

        <span class="query-label" id="label-date" data-i18n="query.dateRange">日期范围</span>
        <div class="date-row" id="row-date">
          <input type="date" id="q-since" value="${today}">
          <span class="date-sep" data-i18n="query.to">至</span>
          <input type="date" id="q-until" value="${today}">
        </div>

        <span class="query-label hidden" id="label-blocks" data-i18n="query.blocksRange">计费范围</span>
        <div class="radio-row hidden" id="row-blocks">
          <label><input type="radio" name="bmode" value="recent" checked> <span data-i18n="blocks.recent">近期记录</span></label>
          <label><input type="radio" name="bmode" value="active"> <span data-i18n="blocks.active">当前活跃</span></label>
        </div>

        <span class="query-label" id="label-project" data-i18n="query.project">项目过滤</span>
        <div id="row-project">
          <select id="q-project">
            <option value="" data-i18n="project.all">全部项目</option>
          </select>
        </div>

        <span class="query-label" id="label-order" data-i18n="query.order">排序方式</span>
        <div id="row-order">
          <select id="q-order">
            <option value="desc" data-i18n="order.desc">降序（最新在前）</option>
            <option value="asc" data-i18n="order.asc">升序（最旧在前）</option>
          </select>
        </div>

        <span></span>
        <div>
          <button class="exec-btn" onclick="runQuery()" data-i18n="btn.run">执行查询</button>
        </div>

      </div>
    </div>
  </div>

  <!-- Output -->
  <div class="section">
    <div class="output-box">
      <div class="output-head">
        <span class="output-label" id="cmd-label" data-i18n="out.placeholder">— 点击按钮或执行查询 —</span>
        <div class="output-actions">
          <a class="view-report-btn" id="view-report-btn" target="_blank" data-i18n="out.view">查看报告 →</a>
          <div class="spinner" id="spinner"></div>
        </div>
      </div>
      <pre id="output"></pre>
    </div>
  </div>

  <!-- History -->
  <div class="section">
    <div class="section-title" data-i18n="section.history">历史记录</div>
    <div class="dash-list" id="history-list">
      ${renderHistoryItems(reports, todayFile)}
    </div>
  </div>

</div>

<script>
const TODAY = "${today}";
const TODAY_FILE = "${todayFile}";
let running = false;
let currentType = "daily";

// ── Type switching ──
function setType(type, btn) {
  currentType = type;
  document.querySelectorAll(".type-tab").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");

  const isBlocks = type === "blocks";
  toggle("row-date", "label-date", !isBlocks);
  toggle("row-blocks", "label-blocks", isBlocks);
  toggle("row-project", "label-project", !isBlocks);
  toggle("row-order", "label-order", !isBlocks);
}

function toggle(rowId, labelId, show) {
  document.getElementById(rowId).classList.toggle("hidden", !show);
  document.getElementById(labelId).classList.toggle("hidden", !show);
}

// ── Load projects ──
async function loadProjects() {
  try {
    const list = await fetch("/api/projects").then(r => r.json());
    const sel = document.getElementById("q-project");
    list.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.raw;
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
  } catch {}
}

// ── Refresh history ──
async function refreshHistory() {
  try {
    const reports = await fetch("/api/reports").then(r => r.json());
    document.getElementById("history-list").innerHTML = buildHistoryHTML(reports);
  } catch {}
}

function buildHistoryHTML(reports) {
  if (!reports.length) return '<p class="empty" data-i18n="history.empty">' + t('history.empty') + '</p>';
  return reports.map(r => {
    const badge = '<span class="report-badge badge-' + r.type + '" data-i18n="badge.' + r.type + '">' + t('badge.' + r.type) + '</span>';
    const todayTag = (r.type === "dashboard" && r.file === TODAY_FILE)
      ? '<span class="today-tag" data-i18n="history.today">' + t('history.today') + '</span>' : "";
    return '<div class="dash-item">'
      + '<div class="dash-left">' + badge
      + '<div class="dash-info"><div class="dash-date">' + r.date + '</div>'
      + (r.time ? '<div class="dash-time">' + r.time + '</div>' : '')
      + '</div></div>'
      + '<div class="dash-actions">' + todayTag
      + '<a class="link-btn" href="/dashboard/' + r.file + '" target="_blank" data-i18n="history.view">' + t('history.view') + '</a>'
      + '<a class="link-btn" href="/archive/' + r.mdFile + '" target="_blank" data-i18n="history.md">' + t('history.md') + '</a>'
      + '</div></div>';
  }).join("");
}

// ── Stream helper ──
async function streamRun(url, label) {
  if (running) return;
  running = true;
  document.querySelectorAll(".btn,.exec-btn").forEach(b => b.style.opacity = ".4");
  const lbl = document.getElementById("cmd-label");
  lbl.textContent = label + "…";
  lbl.classList.add("active");
  document.getElementById("spinner").classList.add("show");
  document.getElementById("view-report-btn").style.display = "none";
  const out = document.getElementById("output");
  out.textContent = "";

  const res = await fetch(url);
  const openAfter = res.headers.get("X-Open-After");
  const reportFile = res.headers.get("X-Report-File");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.textContent += dec.decode(value);
    out.scrollTop = out.scrollHeight;
  }

  lbl.textContent = label + " ✓";
  lbl.classList.remove("active");
  document.getElementById("spinner").classList.remove("show");
  document.querySelectorAll(".btn,.exec-btn").forEach(b => b.style.opacity = "");
  running = false;

  if (reportFile) {
    const btn = document.getElementById("view-report-btn");
    btn.href = "/dashboard/" + reportFile;
    btn.style.display = "inline-block";
  }

  await refreshHistory();

  if (openAfter) setTimeout(() => { window.open(openAfter, "_blank"); location.reload(); }, 400);
}

function runQuick(key, labelKey) {
  streamRun("/run/" + key, t(labelKey));
}

function runQuery() {
  const type = currentType;
  const params = new URLSearchParams({ type });

  if (type === "blocks") {
    params.set("mode", document.querySelector("input[name=bmode]:checked").value);
  } else {
    const since = document.getElementById("q-since").value.replace(/-/g,"");
    const until = document.getElementById("q-until").value.replace(/-/g,"");
    const project = document.getElementById("q-project").value;
    const order = document.getElementById("q-order").value;
    if (since) params.set("since", since);
    if (until) params.set("until", until);
    if (project) params.set("project", project);
    params.set("order", order);
  }

  const labelKeys = { daily:"tab.daily", weekly:"tab.weekly", monthly:"tab.monthly", session:"tab.session", blocks:"tab.blocks" };
  streamRun("/run-query?" + params, t(labelKeys[type] || type));
}

// ── Init ──
loadProjects();
</script>
${I18N_SCRIPT}
</body>
</html>`;
};

function renderHistoryItems(reports, todayFile) {
  if (!reports.length) return '<p class="empty" data-i18n="history.empty">暂无历史记录。</p>';
  return reports.map(r => {
    const todayTag = (r.type === "dashboard" && r.file === todayFile) ? '<span class="today-tag" data-i18n="history.today">今天</span>' : "";
    return `<div class="dash-item">
      <div class="dash-left">
        <span class="report-badge badge-${r.type}" data-i18n="badge.${r.type}">${r.type === "dashboard" ? "仪表盘" : r.label}</span>
        <div class="dash-info">
          <div class="dash-date">${r.date}</div>
          ${r.time ? `<div class="dash-time">${r.time}</div>` : ""}
        </div>
      </div>
      <div class="dash-actions">
        ${todayTag}
        <a class="link-btn" href="/dashboard/${r.file}" target="_blank" data-i18n="history.view">查看报告</a>
        <a class="link-btn" href="/archive/${r.mdFile}" target="_blank" data-i18n="history.md">MD 存档</a>
      </div>
    </div>`;
  }).join("");
}

// ── HTTP Server ──
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HOME_HTML());
    return;
  }

  if (url.pathname === "/api/projects") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(listProjects()));
    return;
  }

  if (url.pathname === "/api/reports") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(listAllReports()));
    return;
  }

  if (url.pathname.startsWith("/dashboard/")) {
    let file = path.basename(url.pathname);
    if (!file.endsWith(".html")) { res.writeHead(404); res.end("not found"); return; }
    const candidates = [file, file.startsWith("usage-") ? file : `usage-${file}`];
    const target = candidates.map(f => path.join(DIR, f)).find(f => fs.existsSync(f));
    if (!target) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(target));
    return;
  }

  if (url.pathname.startsWith("/archive/")) {
    const file = path.basename(url.pathname);
    const fp = path.join(DIR, file);
    if (!file.endsWith(".md") || !fs.existsSync(fp)) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(fs.readFileSync(fp));
    return;
  }

  if (url.pathname.startsWith("/run/")) {
    const key = url.pathname.slice(5);
    const cmd = COMMANDS[key];
    if (!cmd) { res.writeHead(404); res.end("unknown command"); return; }

    const headers = { "Content-Type": "text/plain; charset=utf-8", "Transfer-Encoding": "chunked", "Cache-Control": "no-cache" };
    if (cmd.openAfter) headers["X-Open-After"] = cmd.openAfter();

    // ── Export: inline, no external script ──
    if (key === "export") {
      res.writeHead(200, headers);
      try {
        const dk = dateKey(), today = dateLabel();
        res.write("正在获取今日日报...\n");
        const daily    = runJsonSync(["daily",   "--json","--no-color","--offline","--breakdown","--instances","--since",dk,"--until",dk]);
        res.write("正在获取会话数据...\n");
        const sessions = runJsonSync(["session", "--json","--no-color","--offline","--breakdown","--since",dk,"--until",dk]);
        res.write("正在获取月度数据...\n");
        const monthly  = runJsonSync(["monthly", "--json","--no-color","--offline"]);
        writeDailyFiles({ date: today, daily, sessions, monthly });
        res.write(`\n✓ 已生成 usage-${today}.html\n`);
      } catch(e) { res.write(`✗ 错误：${e.message}\n`); }
      res.end();
      return;
    }

    const basename = makeReportBasename(key);
    headers["X-Report-File"] = basename + ".html";
    res.writeHead(200, headers);

    if (cmd.buildJsonArgs) {
      const jsonArgs = cmd.buildJsonArgs();
      const chunks = [];
      const child = spawn(CCUSAGE, jsonArgs, { env: { ...process.env, FORCE_COLOR: "0" } });
      child.stdout.on("data", d => chunks.push(d));
      child.stderr.on("data", d => res.write(d));
      child.on("close", () => {
        const jsonStr = Buffer.concat(chunks).toString("utf8");
        let jsonData = null, summary = "";
        try { jsonData = JSON.parse(jsonStr); summary = formatJsonSummary(key, cmd.label, jsonData); }
        catch(e) { summary = jsonStr; }
        res.write(summary); res.end();
        saveReport(basename, cmd.label, {}, summary, jsonData);
        backgroundExport();
      });
    } else {
      // Text streaming (blocks)
      const args = cmd.buildArgs();
      const chunks = [];
      const child = spawn(CCUSAGE, args, { env: { ...process.env, FORCE_COLOR: "0" } });
      child.stdout.on("data", d => { res.write(d); chunks.push(d); });
      child.stderr.on("data", d => { res.write(d); chunks.push(d); });
      child.on("close", () => {
        res.end();
        saveReport(basename, cmd.label, {}, Buffer.concat(chunks).toString("utf8"), null);
        backgroundExport();
      });
    }
    return;
  }

  if (url.pathname === "/run-query") {
    const type = url.searchParams.get("type") || "daily";
    const since = url.searchParams.get("since") || "";
    const until = url.searchParams.get("until") || "";
    const project = url.searchParams.get("project") || "";
    const order = url.searchParams.get("order") || "desc";
    const blocksMode = url.searchParams.get("mode") || "recent";

    const fmtDate = d => d.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
    const params = {
      ...(since ? { 开始: fmtDate(since) } : {}),
      ...(until ? { 结束: fmtDate(until) } : {}),
      ...(project ? { 项目: cleanName(project) } : {}),
      ...(type !== "blocks" ? { 排序: order === "desc" ? "降序" : "升序" } : {}),
    };
    const typeLabel = TYPE_LABELS[type] || type;
    const basename = makeReportBasename(type);

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
      "X-Report-File": basename + ".html",
    });

    if (type === "blocks") {
      const args = ["blocks","--no-color","--offline", blocksMode === "active" ? "--active" : "--recent"];
      const chunks = [];
      const child = spawn(CCUSAGE, args, { env: { ...process.env, FORCE_COLOR: "0" } });
      child.stdout.on("data", d => { res.write(d); chunks.push(d); });
      child.stderr.on("data", d => { res.write(d); chunks.push(d); });
      child.on("close", () => {
        res.end();
        saveReport(basename, typeLabel, params, Buffer.concat(chunks).toString("utf8"), null);
        backgroundExport();
      });
    } else {
      const jsonArgs = [type,"--json","--no-color","--offline","--breakdown","--order",order];
      if (type === "daily") jsonArgs.push("--instances");
      if (since) jsonArgs.push("--since", since);
      if (until) jsonArgs.push("--until", until);
      if (project) jsonArgs.push("--project", project);

      const chunks = [];
      const child = spawn(CCUSAGE, jsonArgs, { env: { ...process.env, FORCE_COLOR: "0" } });
      child.stdout.on("data", d => chunks.push(d));
      child.stderr.on("data", d => res.write(d));
      child.on("close", () => {
        const jsonStr = Buffer.concat(chunks).toString("utf8");
        let jsonData = null, summary = "";
        try { jsonData = JSON.parse(jsonStr); summary = formatJsonSummary(type, typeLabel, jsonData); }
        catch(e) { summary = jsonStr; }
        res.write(summary); res.end();
        saveReport(basename, typeLabel, params, summary, jsonData);
        backgroundExport();
      });
    }
    return;
  }

  res.writeHead(404); res.end();
});

// ── Startup check ──
function checkCcusage() {
  const r = spawnSync(CCUSAGE, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0 || r.error) {
    console.warn(`\n⚠  未检测到 ccusage（路径：${CCUSAGE}）`);
    console.warn("   请先安装：npm install -g ccusage");
    console.warn("   或通过 CCUSAGE_BIN 环境变量指定可执行文件路径。\n");
    return false;
  }
  return true;
}

server.listen(PORT, "127.0.0.1", () => {
  const u = `http://localhost:${PORT}`;
  console.log(`ccusage-webui：${u}`);
  console.log(`数据目录：${DIR}`);
  console.log(`ccusage：${CCUSAGE}`);
  checkCcusage();
  spawn("open", [u]);
});
