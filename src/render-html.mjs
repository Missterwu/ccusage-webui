import os from "node:os";
import path from "node:path";

// Strip project root prefix from Claude project paths.
// Set CCUSAGE_PROJECT_ROOT to the parent directory of your Claude projects
// (e.g., export CCUSAGE_PROJECT_ROOT=/Users/you/Projects) for cleaner names.
// Defaults to stripping just the home directory.
const _projectRoot = (process.env.CCUSAGE_PROJECT_ROOT || os.homedir())
  .replace(/^\//, "").replace(/\//g, "-").replace(/-+$/, "");

export const cleanName = raw => {
  const s = String(raw || "Unknown");
  if (s === "subagents") return "subagents";
  return s.replace(new RegExp(`^-?${_projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-?`), "")
           .replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-") || s;
};

const fmtNum  = v => Number(v || 0).toLocaleString("en-US");
const fmtCost = v => `$${Number(v || 0).toFixed(2)}`;
const fmtM    = v => { const n = Number(v || 0); return n >= 1e9 ? (n/1e9).toFixed(1)+"B" : n >= 1e6 ? (n/1e6).toFixed(1)+"M" : n >= 1e3 ? (n/1e3).toFixed(0)+"K" : String(n); };
const pct     = (part, total) => total ? ((Number(part||0)/Number(total))*100).toFixed(1) : "0.0";
const shortModel = m => String(m || "").replace(/^claude-/, "").replace(/-202\d{5,8}$/, "");
const sum = (items, key) => items.reduce((t, i) => t + Number(i[key] || 0), 0);

const COLORS = [
  { solid: "#3b82f6", grad: "linear-gradient(90deg,#2563eb,#60a5fa)", text: "#1d4ed8", border: "#bfdbfe", bg: "#eff6ff", badge: "#dbeafe", badgeText: "#1e40af" },
  { solid: "#8b5cf6", grad: "linear-gradient(90deg,#7c3aed,#a78bfa)", text: "#6d28d9", border: "#ddd6fe", bg: "#f5f3ff", badge: "#ede9fe", badgeText: "#5b21b6" },
  { solid: "#10b981", grad: "linear-gradient(90deg,#059669,#34d399)", text: "#047857", border: "#a7f3d0", bg: "#f0fdf9", badge: "#d1fae5", badgeText: "#065f46" },
  { solid: "#f59e0b", grad: "linear-gradient(90deg,#d97706,#fbbf24)", text: "#b45309", border: "#fde68a", bg: "#fffbeb", badge: "#fef3c7", badgeText: "#92400e" },
  { solid: "#ec4899", grad: "linear-gradient(90deg,#be185d,#f472b6)", text: "#be185d", border: "#fbcfe8", bg: "#fdf2f8", badge: "#fce7f3", badgeText: "#9d174d" },
  { solid: "#14b8a6", grad: "linear-gradient(90deg,#0d9488,#2dd4bf)", text: "#0f766e", border: "#99f6e4", bg: "#f0fdfa", badge: "#ccfbf1", badgeText: "#134e4a" },
  { solid: "#6366f1", grad: "linear-gradient(90deg,#4338ca,#818cf8)", text: "#4338ca", border: "#c7d2fe", bg: "#eef2ff", badge: "#e0e7ff", badgeText: "#3730a3" },
];

export function renderDailyHtml(data, sourceName = "usage.json") {
  const dt = data.daily?.totals || {};
  const st = data.sessions?.totals || {};
  const sessionRows = [...(data.sessions?.sessions || [])].sort((a, b) => Number(b.totalCost||0) - Number(a.totalCost||0));
  const projectRows = Object.entries(data.daily?.projects || {})
    .map(([project, entries]) => ({
      name: cleanName(project),
      inputTokens: sum(entries, "inputTokens"), outputTokens: sum(entries, "outputTokens"),
      cacheCreationTokens: sum(entries, "cacheCreationTokens"), cacheReadTokens: sum(entries, "cacheReadTokens"),
      totalTokens: sum(entries, "totalTokens"), totalCost: sum(entries, "totalCost"),
      modelsUsed: [...new Set(entries.flatMap(e => e.modelsUsed || []))],
    })).sort((a, b) => b.totalCost - a.totalCost);

  const modelMap = new Map();
  for (const s of sessionRows) {
    for (const m of s.modelBreakdowns || []) {
      const k = shortModel(m.modelName);
      const r = modelMap.get(k) || { model: k, inputTokens:0, outputTokens:0, cacheCreationTokens:0, cacheReadTokens:0, totalCost:0 };
      r.inputTokens += Number(m.inputTokens||0); r.outputTokens += Number(m.outputTokens||0);
      r.cacheCreationTokens += Number(m.cacheCreationTokens||0); r.cacheReadTokens += Number(m.cacheReadTokens||0);
      r.totalCost += Number(m.cost||0);
      modelMap.set(k, r);
    }
  }
  const modelRows = [...modelMap.values()].sort((a,b) => b.totalCost - a.totalCost);

  const tokenTypes = [
    { label: "缓存读取", key: "cacheReadTokens",    color: COLORS[1] },
    { label: "缓存写入", key: "cacheCreationTokens", color: COLORS[0] },
    { label: "输出",     key: "outputTokens",        color: COLORS[3] },
    { label: "输入",     key: "inputTokens",         color: COLORS[2] },
  ];
  const tokenTotal = tokenTypes.reduce((t, x) => t + Number(st[x.key]||0), 0);
  const topModel = modelRows[0];
  const maxTokenKey = tokenTypes.reduce((m, x) => Number(st[x.key]) > Number(st[m.key]) ? x : m, tokenTypes[0]).key;

  const curMonth = (data.date || "").slice(0, 7);
  const monthlyRows = data.monthly?.monthly || [];
  const thisMonthCost = Number(monthlyRows.find(m => m.month === curMonth)?.totalCost || 0);
  const allTimeCost   = Number(data.monthly?.totals?.totalCost || 0);

  const hbar = (label, sub, cost, pctVal, color, maxPct = 100) => `
<div class="hbar-row">
  <div class="hbar-label">
    <span class="hbar-name">${label}</span>
    ${sub ? `<span class="hbar-sub">${sub}</span>` : ""}
  </div>
  <div class="hbar-track">
    <div class="hbar-fill" style="width:${Math.min(100, (pctVal/maxPct)*100).toFixed(1)}%;background:${color.grad}"></div>
  </div>
  <div class="hbar-meta">
    <span class="hbar-cost" style="color:${color.text}">${cost}</span>
    <span class="hbar-pct">${pctVal}%</span>
  </div>
</div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ccusage · ${data.date}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f1f5f9;color:#1e293b;min-height:100vh;font-size:16px}
a{color:inherit;text-decoration:none}
.hero{background:linear-gradient(135deg,#ffffff 0%,#f8faff 50%,#faf5ff 100%);padding:52px 48px 40px;border-bottom:1px solid #e2e8f0;position:relative;overflow:hidden}
.hero::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse 60% 80% at 20% 60%,#bfdbfe30,transparent),radial-gradient(ellipse 40% 60% at 85% 20%,#ddd6fe30,transparent);pointer-events:none}
.hero-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;gap:24px;flex-wrap:wrap}
.hero-date{font-size:14px;color:#94a3b8;font-weight:500;margin-bottom:10px;text-transform:uppercase;letter-spacing:.08em}
.hero-cost{font-size:76px;font-weight:800;background:linear-gradient(90deg,#2563eb 0%,#7c3aed 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;line-height:1;letter-spacing:-.04em}
.hero-sub{font-size:17px;color:#94a3b8;margin-top:12px}
.hero-sub b{color:#475569}
.hero-stats{display:flex;flex-direction:column;align-items:flex-end;gap:16px}
.hero-stat{text-align:right}
.hero-stat-label{font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
.hero-stat-value{font-size:32px;font-weight:700;line-height:1.1}
.seg-bar{height:10px;border-radius:5px;overflow:hidden;display:flex;box-shadow:0 1px 3px #0001}
.seg-seg{height:100%;transition:width .4s ease}
.body{padding:36px 48px;max-width:1600px;margin:0 auto}
.section{margin-bottom:32px}
.section-title{font-size:20px;font-weight:600;color:#475569;letter-spacing:.01em;margin-bottom:20px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
@media(max-width:1100px){.grid2{grid-template-columns:1fr}.grid4{grid-template-columns:repeat(2,1fr)}}
@media(max-width:600px){.grid4{grid-template-columns:1fr}}
.stat-card{border-radius:14px;padding:26px 28px;border:1px solid;position:relative;overflow:hidden;background:#fff}
.stat-card::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.5;background:radial-gradient(ellipse at top left,#fff8,transparent)}
.stat-label{font-size:15px;font-weight:500;color:#94a3b8;margin-bottom:10px}
.stat-value{font-size:40px;font-weight:800;line-height:1;letter-spacing:-.03em}
.stat-sub{font-size:14px;color:#94a3b8;margin-top:8px}
.panel{background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:28px;box-shadow:0 1px 4px #0000000a}
.hbar-row{display:grid;grid-template-columns:220px 1fr 150px;align-items:center;gap:16px;padding:14px 0;border-bottom:1px solid #f1f5f9}
.hbar-row:last-child{border-bottom:none}
.hbar-name{display:block;font-size:16px;font-weight:500;color:#1e293b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hbar-sub{display:block;font-size:13px;color:#94a3b8;margin-top:3px}
.hbar-track{height:10px;background:#f1f5f9;border-radius:6px;overflow:hidden}
.hbar-fill{height:100%;border-radius:6px;transition:width .5s ease}
.hbar-meta{display:flex;flex-direction:column;align-items:flex-end;gap:3px}
.hbar-cost{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums}
.hbar-pct{font-size:13px;color:#94a3b8}
table{width:100%;border-collapse:collapse;font-size:15px}
th{text-align:left;color:#94a3b8;font-weight:600;font-size:13px;padding:0 14px 14px;border-bottom:1px solid #e2e8f0;text-transform:uppercase;letter-spacing:.04em}
td{padding:14px 14px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
tr:last-child td{border-bottom:none}
tbody tr:hover{background:#f8fafc}
.td-right{text-align:right;font-variant-numeric:tabular-nums;color:#94a3b8}
.td-cost{text-align:right;font-weight:700;font-variant-numeric:tabular-nums}
.td-bar{min-width:120px}
.inline-bar{height:7px;background:#f1f5f9;border-radius:4px;overflow:hidden;margin-top:6px}
.inline-fill{height:100%;border-radius:4px}
.rank{color:#cbd5e1;font-size:15px;font-weight:600}
.badge{display:inline-block;font-size:12px;padding:3px 9px;border-radius:5px;font-weight:500;margin:2px;border:1px solid transparent}
.time-badge{font-size:13px;color:#94a3b8;background:#f8fafc;border:1px solid #e2e8f0;padding:4px 12px;border-radius:5px;white-space:nowrap}
.footer{text-align:center;font-size:14px;color:#cbd5e1;padding:32px 48px;margin-top:8px}
</style>
</head>
<body>
<div class="hero">
  <div class="hero-top">
    <div>
      <div class="hero-date">今日费用 · ${data.date}</div>
      <div class="hero-cost">${fmtCost(dt.totalCost)}</div>
      <div class="hero-sub"><b>${projectRows.length}</b> 个项目 &nbsp;·&nbsp; <b>${sessionRows.length}</b> 个会话 &nbsp;·&nbsp; <b>${fmtM(dt.totalTokens)}</b> tokens</div>
    </div>
    <div class="hero-stats">
      <div class="hero-stat">
        <div class="hero-stat-label">缓存命中率</div>
        <div class="hero-stat-value" style="color:#7c3aed">${pct(st.cacheReadTokens, st.totalTokens)}%</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-label">本月累计</div>
        <div class="hero-stat-value" style="color:#2563eb;font-size:26px">${fmtCost(thisMonthCost)}</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-label">历史总计</div>
        <div class="hero-stat-value" style="color:#475569;font-size:22px">${fmtCost(allTimeCost)}</div>
      </div>
    </div>
  </div>
  <div class="seg-bar">
    ${sessionRows.map((s,i) => `<div class="seg-seg" style="width:${pct(s.totalCost,st.totalCost)}%;background:${COLORS[i%COLORS.length].solid}" title="${cleanName(s.sessionId)}: ${fmtCost(s.totalCost)}"></div>`).join("")}
  </div>
</div>
<div class="body">
  <div class="section">
    <div class="grid4">
      <div class="stat-card" style="border-color:${COLORS[0].border}">
        <div style="position:absolute;inset:0;background:${COLORS[0].bg};opacity:.5;border-radius:14px"></div>
        <div style="position:relative">
          <div class="stat-label">今日费用</div>
          <div class="stat-value" style="color:${COLORS[0].text}">${fmtCost(dt.totalCost)}</div>
          <div class="stat-sub">${fmtM(dt.totalTokens)} tokens</div>
        </div>
      </div>
      <div class="stat-card" style="border-color:${COLORS[1].border}">
        <div style="position:absolute;inset:0;background:${COLORS[1].bg};opacity:.5;border-radius:14px"></div>
        <div style="position:relative">
          <div class="stat-label">本月累计</div>
          <div class="stat-value" style="color:${COLORS[1].text}">${fmtCost(thisMonthCost)}</div>
          <div class="stat-sub">历史总计 ${fmtCost(allTimeCost)}</div>
        </div>
      </div>
      <div class="stat-card" style="border-color:${COLORS[3].border}">
        <div style="position:absolute;inset:0;background:${COLORS[3].bg};opacity:.5;border-radius:14px"></div>
        <div style="position:relative">
          <div class="stat-label">缓存命中率</div>
          <div class="stat-value" style="color:${COLORS[3].text}">${pct(st.cacheReadTokens, st.totalTokens)}%</div>
          <div class="stat-sub">${fmtM(st.cacheReadTokens)} 缓存读取</div>
        </div>
      </div>
      <div class="stat-card" style="border-color:${COLORS[2].border}">
        <div style="position:absolute;inset:0;background:${COLORS[2].bg};opacity:.5;border-radius:14px"></div>
        <div style="position:relative">
          <div class="stat-label">主力模型</div>
          <div class="stat-value" style="color:${COLORS[2].text};font-size:26px;padding-top:4px">${topModel?.model || "—"}</div>
          <div class="stat-sub">${topModel ? fmtCost(topModel.totalCost) + " · " + pct(topModel.totalCost, st.totalCost) + "%" : ""}</div>
        </div>
      </div>
    </div>
  </div>
  <div class="section">
    <div class="grid2">
      <div class="panel">
        <div class="section-title">今日各项目</div>
        <table>
          <thead><tr>
            <th>项目</th><th style="text-align:right">费用</th><th style="min-width:100px">占比</th><th style="text-align:right">Tokens</th>
          </tr></thead>
          <tbody>${projectRows.map((p, i) => {
            const c = COLORS[i % COLORS.length];
            return `<tr>
              <td>
                <div style="font-weight:500;color:#1e293b">${p.name}</div>
                <div style="margin-top:3px">${p.modelsUsed.map(m => `<span class="badge" style="background:${c.badge};border-color:${c.border};color:${c.badgeText}">${shortModel(m)}</span>`).join("")}</div>
              </td>
              <td class="td-cost" style="color:${c.text}">${fmtCost(p.totalCost)}</td>
              <td class="td-bar">
                <div style="font-size:14px;color:#94a3b8;margin-bottom:4px">${pct(p.totalCost,dt.totalCost)}%</div>
                <div class="inline-bar"><div class="inline-fill" style="width:${pct(p.totalCost,dt.totalCost)}%;background:${c.grad}"></div></div>
              </td>
              <td class="td-right">${fmtM(p.totalTokens)}</td>
            </tr>`;
          }).join("")}</tbody>
        </table>
      </div>
      <div class="panel">
        <div class="section-title">各模型费用</div>
        <table>
          <thead><tr>
            <th>模型</th><th style="text-align:right">费用</th><th style="min-width:100px">占比</th><th style="text-align:right">输出</th>
          </tr></thead>
          <tbody>${modelRows.map((m, i) => {
            const c = COLORS[i % COLORS.length];
            return `<tr>
              <td><strong style="color:#1e293b">${m.model}</strong></td>
              <td class="td-cost" style="color:${c.text}">${fmtCost(m.totalCost)}</td>
              <td class="td-bar">
                <div style="font-size:14px;color:#94a3b8;margin-bottom:4px">${pct(m.totalCost,st.totalCost)}%</div>
                <div class="inline-bar"><div class="inline-fill" style="width:${pct(m.totalCost,st.totalCost)}%;background:${c.grad}"></div></div>
              </td>
              <td class="td-right">${fmtM(m.outputTokens)}</td>
            </tr>`;
          }).join("")}</tbody>
        </table>
      </div>
    </div>
  </div>
  <div class="section">
    <div class="grid2">
      <div class="panel">
        <div class="section-title">会话费用排行</div>
        ${sessionRows.map((s, i) => hbar(
          cleanName(s.sessionId),
          (s.modelsUsed||[]).map(shortModel).join(" · "),
          fmtCost(s.totalCost),
          pct(s.totalCost, st.totalCost),
          COLORS[i % COLORS.length],
          Number(pct(sessionRows[0].totalCost, st.totalCost))
        )).join("")}
      </div>
      <div class="panel">
        <div class="section-title">Token 构成</div>
        ${tokenTypes.map(t => hbar(
          t.label, "",
          fmtM(st[t.key]),
          pct(st[t.key], tokenTotal),
          t.color,
          Number(pct(Number(st[maxTokenKey]||0), tokenTotal))
        )).join("")}
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid #f1f5f9;display:grid;grid-template-columns:1fr 1fr;gap:8px">
          ${tokenTypes.map(t => `
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:12px;height:12px;border-radius:50%;background:${t.color.solid};flex-shrink:0"></div>
            <div>
              <div style="font-size:14px;color:#94a3b8">${t.label}</div>
              <div style="font-size:15px;font-weight:600;color:${t.color.text}">${fmtNum(st[t.key])}</div>
            </div>
          </div>`).join("")}
        </div>
      </div>
    </div>
  </div>
  <div class="section">
    <div class="panel">
      <div class="section-title">各会话明细</div>
      <table>
        <thead><tr>
          <th style="width:28px">#</th><th>会话</th><th>模型</th>
          <th style="text-align:right">费用</th><th style="min-width:120px">占比</th>
          <th style="text-align:right">总 Tokens</th><th style="text-align:right">缓存读取</th><th>最后活跃</th>
        </tr></thead>
        <tbody>${sessionRows.map((s, i) => {
          const c = COLORS[i % COLORS.length];
          return `<tr>
            <td class="rank">${i+1}</td>
            <td><strong style="color:#1e293b">${cleanName(s.sessionId)}</strong></td>
            <td>${(s.modelsUsed||[]).map(m => `<span class="badge" style="background:${c.badge};border-color:${c.border};color:${c.badgeText}">${shortModel(m)}</span>`).join("")}</td>
            <td class="td-cost" style="color:${c.text}">${fmtCost(s.totalCost)}</td>
            <td class="td-bar">
              <div style="font-size:14px;color:#94a3b8;margin-bottom:4px">${pct(s.totalCost, st.totalCost)}%</div>
              <div class="inline-bar"><div class="inline-fill" style="width:${pct(s.totalCost,st.totalCost)}%;background:${c.grad}"></div></div>
            </td>
            <td class="td-right">${fmtM(s.totalTokens)}</td>
            <td class="td-right">${fmtM(s.cacheReadTokens)}</td>
            <td><span class="time-badge">${s.lastActivity||""}</span></td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>
  </div>
</div>
<div class="footer">费用为估算值，基于 ccusage/LiteLLM 定价 &nbsp;·&nbsp; 来源：${sourceName}</div>
</body>
</html>`;
}
