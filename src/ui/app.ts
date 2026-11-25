import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

type Mode = "auto" | "plan" | "ask" | "turbo";
type ChartKind = "speed" | "latency" | "context";
type QuotaMetric = "billable" | "total";
type CardId = "context" | "mode" | "perf" | "usage";

interface UsageWindow {
  turns: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  billableTokens: number;
  totalTokens: number;
  usedTokens: number;
  limitTokens: number;
  usedPct: number;
  remainingPct?: number;
  remainingTokens: number;
  oldestAt: string | null;
  nextResetInMs: number | null;
}

interface UsageSummary {
  metric: QuotaMetric;
  quotaConfig: {
    metric: QuotaMetric;
    fiveHourLimit: number;
    weeklyLimit: number;
    updatedAt: string | null;
  };
  conversationsScanned: number;
  fiveHour: UsageWindow;
  weekly: UsageWindow;
  pools?: {
    gemini: { fiveHour: UsageWindow; weekly: UsageWindow };
    claude_gpt: { fiveHour: UsageWindow; weekly: UsageWindow };
  };
  allTime: {
    turns: number;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    billableTokens: number;
    totalTokens: number;
  };
  daily7d: Array<{
    date: string;
    label: string;
    turns: number;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    billableTokens: number;
    totalTokens: number;
  }>;
  byModel7d: Array<{
    model: string;
    pool?: string;
    turns: number;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    billableTokens: number;
    totalTokens: number;
  }>;
}

interface TurnPoint {
  stepIndex: number;
  createdAt: string | null;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  contextTokens: number;
  cacheHitPct: number;
  toolCallCount: number;
  latencyMs: number | null;
  latencySource: "hook" | "transcript" | null;
  speedTokPerSec: number | null;
}

interface ConversationItem {
  conversationId: string;
  shortId: string;
  title?: string;
  shortTitle?: string;
  projectName?: string;
  isSubagent?: boolean;
  label?: string;
  fullLabel?: string;
  updatedAt: string;
  sizeKB: number;
  isActive: boolean;
}

interface ProjectItem {
  name: string;
  count: number;
  hasActive: boolean;
}

interface ContextBreakdown {
  freeTokens: number;
  freePct: number;
  lastDeltaTokens: number;
  avgGrowthPerTurn: number | null;
  estTurnsRemaining: number | null;
  compactionCount: number;
  segments: Array<{
    key: "system" | "tools" | "assistant" | "user";
    label: string;
    tokens: number;
    pctOfLimit: number;
    pctOfUsed: number;
  }>;
  topTools: Array<{
    name: string;
    tokens: number;
    pctOfUsed: number;
  }>;
}

interface Snapshot {
  generatedAt: string;
  mode: Mode;
  modeUpdatedAt: string | null;
  modeDescriptions: Record<Mode, { label: string; badge: string; summary: string }>;
  activeConversationId: string | null;
  projects?: ProjectItem[];
  conversations: ConversationItem[];
  metrics: {
    conversationId: string | null;
    title: string;
    projectName?: string;
    displayLabel?: string;
    model: string;
    context: {
      usedTokens: number;
      limitTokens: number;
      usedPct: number;
      cacheReadTokens: number;
      uncachedInputTokens: number;
      cacheHitPct: number;
      outputTokensLatest: number;
      breakdown?: ContextBreakdown;
    };
    totals: {
      turns: number;
      toolCalls: number;
      inputTokens: number;
      cacheReadTokens: number;
      outputTokens: number;
      overallCacheHitPct: number;
    };
    performance: {
      latestLatencyMs: number | null;
      latestLatencySource: "hook" | "transcript" | null;
      latestSpeedTokPerSec: number | null;
      avgLatencyMs: number | null;
      p95LatencyMs: number | null;
      avgSpeedTokPerSec: number | null;
      peakSpeedTokPerSec: number | null;
      measuredTurns: number;
      hookMeasuredTurns: number;
    };
    recentTurns: TurnPoint[];
  } | null;
  usage?: UsageSummary | null;
  uiPrefs?: {
    collapsedCards: CardId[];
    updatedAt?: string | null;
  } | null;
}

const CIRCUMFERENCE = 2 * Math.PI * 40; // r = 40
const STORAGE_COLLAPSED_KEY = "agy-cockpit:collapsed-cards";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let currentSnapshot: Snapshot | null = null;
let selectedProject = "";
let selectedConversationId: string | null = null;
let selectedLimitOverride = 0;
let activeChart: ChartKind = "speed";
let collapsedCards = new Set<CardId>();
let hasHydratedServerPrefs = false;
let pollTimer: number | null = null;
let pollInFlight = false;
let modeInFlight = false;
let stateSeq = 0;
let toastTimer: number | null = null;

function loadLocalCollapsed(): Set<CardId> {
  try {
    const raw = window.localStorage.getItem(STORAGE_COLLAPSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return new Set(arr.filter((v): v is CardId => ["context", "mode", "perf", "usage"].includes(v)));
    }
  } catch {
    // ignore storage errors in restricted iframes
  }
  return new Set();
}

function saveLocalCollapsed() {
  try {
    window.localStorage.setItem(STORAGE_COLLAPSED_KEY, JSON.stringify(Array.from(collapsedCards)));
  } catch {
    // ignore
  }
}

function applyCollapsedState() {
  document.querySelectorAll<HTMLElement>(".card[data-card]").forEach((card) => {
    const id = card.dataset.card as CardId;
    const isCollapsed = collapsedCards.has(id);
    card.classList.toggle("collapsed", isCollapsed);
    const btn = card.querySelector<HTMLButtonElement>(".card-toggle");
    if (btn) btn.setAttribute("aria-expanded", String(!isCollapsed));
  });
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTokens(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtSec(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "--";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtDurationReset(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "窗口空闲";
  if (ms <= 0) return "即将释放";
  const totalMin = Math.ceil(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `约 ${days}d ${hours}h 后释放`;
  if (hours > 0) return `约 ${hours}h ${mins}m 后释放`;
  return `约 ${mins}m 后释放`;
}

function parseTokenShorthand(raw: string): number | null {
  const s = raw.trim().replace(/,/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  const unit = (m[2] || "").toLowerCase();
  const mult = unit === "b" ? 1e9 : unit === "m" ? 1e6 : unit === "k" ? 1e3 : 1;
  return Math.round(num * mult);
}

function formatLimitInput(n: number): string {
  if (n >= 1_000_000 && n % 100_000 === 0) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000 && n % 1_000 === 0) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function barColorForRemainingPct(remPct: number): string {
  if (remPct <= 15) return "var(--danger)";
  if (remPct <= 40) return "var(--warn)";
  return "var(--good)";
}

function renderContextPopover(ctx: NonNullable<Snapshot["metrics"]>["context"] | null) {
  const totalEl = $("popTotal");
  const stackEl = $("popStack");
  const rowsEl = $("popRows");
  const metaEl = $("popMeta");
  const toolsEl = $("popTools");

  if (!ctx || !ctx.breakdown) {
    totalEl.textContent = "暂无数据";
    stackEl.innerHTML = "";
    rowsEl.innerHTML = `<div class="usage-empty">等待会话上下文数据...</div>`;
    metaEl.innerHTML = "";
    toolsEl.innerHTML = "";
    return;
  }

  const b = ctx.breakdown;
  totalEl.textContent = `${ctx.usedPct.toFixed(1)}% · ${fmtTokens(ctx.usedTokens)} / ${fmtTokens(ctx.limitTokens)}`;

  stackEl.innerHTML = b.segments
    .filter((s) => s.pctOfLimit > 0)
    .map(
      (s) =>
        `<div class="pop-seg pop-seg-${s.key}" style="width: ${Math.max(1.2, s.pctOfLimit)}%" title="${escHtml(s.label)}: ${fmtTokens(s.tokens)} (${s.pctOfLimit}%)"></div>`,
    )
    .join("");

  const segRows = b.segments
    .map(
      (s) => `
      <div class="pop-row">
        <span class="pop-row-left">
          <span class="pop-dot pop-dot-${s.key}"></span>
          <span>${escHtml(s.label)}</span>
        </span>
        <span class="pop-row-val mono">${fmtTokens(s.tokens)} (${s.pctOfLimit}%)</span>
      </div>
    `,
    )
    .join("");

  const freeRow = `
    <div class="pop-row muted">
      <span class="pop-row-left">
        <span class="pop-dot pop-dot-free"></span>
        <span>剩余可用窗口</span>
      </span>
      <span class="pop-row-val mono">${fmtTokens(b.freeTokens)} (${b.freePct}%)</span>
    </div>
  `;
  rowsEl.innerHTML = segRows + freeRow;

  const deltaSign = b.lastDeltaTokens > 0 ? "+" : "";
  const deltaStr =
    b.lastDeltaTokens !== 0 ? `${deltaSign}${fmtTokens(Math.abs(b.lastDeltaTokens))}` : "0";
  const remTurnsStr = b.estTurnsRemaining !== null ? `约 ${b.estTurnsRemaining} 轮` : "--";
  metaEl.innerHTML = `
    <span>缓存复用 <b>${fmtTokens(ctx.cacheReadTokens)}</b> (${ctx.cacheHitPct.toFixed(1)}%)</span>
    <span>本轮增幅 <b>${b.lastDeltaTokens < 0 ? "-" : deltaSign}${fmtTokens(Math.abs(b.lastDeltaTokens))}</b></span>
    <span>已压缩 <b>${b.compactionCount} 次</b></span>
    <span>按均速可续 <b>${remTurnsStr}</b></span>
  `.replace(deltaStr, deltaStr);

  if (b.topTools.length > 0) {
    toolsEl.innerHTML =
      `<span class="pop-tool-pill">Top 工具</span>` +
      b.topTools
        .map(
          (t) =>
            `<span class="pop-tool-pill">${escHtml(t.name)} ${fmtTokens(t.tokens)}</span>`,
        )
        .join("");
  } else {
    toolsEl.innerHTML = "";
  }
}

function renderQuotaWindow(prefix: "q5h" | "q7d", win: UsageWindow) {
  const usedPct = Math.max(0, win.usedPct);
  const remPct =
    typeof win.remainingPct === "number"
      ? win.remainingPct
      : +Math.max(0, Math.min(100, 100 - usedPct)).toFixed(1);
  const color = barColorForRemainingPct(remPct);

  const pctEl = $(`${prefix}Pct`);
  pctEl.textContent = `${remPct.toFixed(1)}% left`;
  pctEl.style.color = color;

  const barEl = $(`${prefix}Bar`);
  barEl.style.width = `${Math.max(0, Math.min(100, remPct)).toFixed(1)}%`;
  barEl.style.background = color;

  $(`${prefix}Ratio`).textContent = `已用 ${fmtTokens(win.usedTokens)} / ${fmtTokens(win.limitTokens)}`;
  $(`${prefix}Reset`).textContent = win.turns > 0 ? fmtDurationReset(win.nextResetInMs) : "窗口空闲";
  $(`${prefix}Sub`).textContent =
    `新入 ${fmtTokens(win.inputTokens)} · 缓存 ${fmtTokens(win.cacheReadTokens)} · 输出 ${fmtTokens(win.outputTokens)} · ${win.turns} 轮`;
}

function renderUsage(usage: UsageSummary | null | undefined) {
  if (!usage) return;

  const metricSelect = $<HTMLSelectElement>("quotaMetricSelect");
  if (document.activeElement !== metricSelect) {
    metricSelect.value = usage.metric;
  }

  const editor = $("quotaEditor");
  if (editor.classList.contains("hidden")) {
    $<HTMLInputElement>("input5hLimit").value = formatLimitInput(usage.quotaConfig.fiveHourLimit);
    $<HTMLInputElement>("input7dLimit").value = formatLimitInput(usage.quotaConfig.weeklyLimit);
  }

  const allTokens = usage.metric === "total" ? usage.allTime.totalTokens : usage.allTime.billableTokens;
  $("usageMetaPill").textContent = `${usage.conversationsScanned} 个会话 · ${usage.allTime.turns} 轮`;
  $("usageAllTime").textContent = `总计 ${fmtTokens(allTokens)}`;

  renderQuotaWindow("q5h", usage.fiveHour);
  renderQuotaWindow("q7d", usage.weekly);
  const r5 = typeof usage.fiveHour.remainingPct === "number" ? usage.fiveHour.remainingPct : Math.max(0, 100 - usage.fiveHour.usedPct);
  const r7 = typeof usage.weekly.remainingPct === "number" ? usage.weekly.remainingPct : Math.max(0, 100 - usage.weekly.usedPct);
  $("miniUsage").textContent = `5h ${r5.toFixed(0)}% · 7d ${r7.toFixed(0)}%`;

  // 7-day daily bars
  const dailyEl = $("dailyBars");
  const dailyVals = usage.daily7d.map((d) =>
    usage.metric === "total" ? d.totalTokens : d.billableTokens,
  );
  const dailyMax = Math.max(...dailyVals, 1);
  dailyEl.innerHTML = usage.daily7d
    .map((d, idx) => {
      const val = dailyVals[idx];
      const hPct = val > 0 ? Math.max(8, Math.round((val / dailyMax) * 100)) : 3;
      const isToday = idx === usage.daily7d.length - 1;
      const tip = `${d.date} · 非缓存 ${fmtTokens(d.billableTokens)} · 含缓存 ${fmtTokens(d.totalTokens)} · ${d.turns} 轮`;
      return `
        <div class="daily-col${isToday ? " today" : ""}" title="${escHtml(tip)}">
          <div class="daily-bar-track">
            <div class="daily-bar" style="height: ${hPct}%"></div>
          </div>
          <span class="daily-day mono">${escHtml(d.label.slice(3))}</span>
        </div>
      `;
    })
    .join("");

  // 7-day model pool pills + breakdown
  const poolEl = $("poolSummary");
  if (usage.pools) {
    const g = usage.pools.gemini.weekly;
    const c = usage.pools.claude_gpt.weekly;
    poolEl.innerHTML = `
      <span class="pool-pill">Gemini 7d: ${fmtTokens(g.usedTokens)} (${g.turns}轮)</span>
      <span class="pool-pill">Claude/GPT 7d: ${fmtTokens(c.usedTokens)} (${c.turns}轮)</span>
    `;
  } else {
    poolEl.innerHTML = "";
  }

  const modelEl = $("modelList");
  $("usageModelCount").textContent = `${usage.byModel7d.length} 个模型`;
  if (usage.byModel7d.length === 0) {
    modelEl.innerHTML = `<div class="usage-empty">近 7 天暂无模型调用记录</div>`;
  } else {
    const mVals = usage.byModel7d.map((m) =>
      usage.metric === "total" ? m.totalTokens : m.billableTokens,
    );
    const mTotal = Math.max(mVals.reduce((a, b) => a + b, 0), 1);
    modelEl.innerHTML = usage.byModel7d
      .map((m, idx) => {
        const val = mVals[idx];
        const pct = Math.round((val / mTotal) * 100);
        const tip = `${m.model}: 新入 ${fmtTokens(m.inputTokens)} · 缓存 ${fmtTokens(m.cacheReadTokens)} · 输出 ${fmtTokens(m.outputTokens)} · ${m.turns} 轮`;
        return `
          <div class="model-row" title="${escHtml(tip)}">
            <div class="model-row-top">
              <span class="model-name mono">${escHtml(m.model)}</span>
              <span class="model-val mono">${fmtTokens(val)} · ${m.turns}轮</span>
            </div>
            <div class="model-bar-track">
              <div class="model-bar-fill" style="width: ${Math.max(4, pct)}%"></div>
            </div>
          </div>
        `;
      })
      .join("");
  }
}

function showToast(msg: string, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add("hidden"), 2800);
}

function renderTrendChart(turns: TurnPoint[], kind: ChartKind) {
  const wrap = $("chartWrap");
  const svg = $("trendSvg");
  const axisMaxEl = $("chartAxisMax");
  const summaryEl = $("chartSummary");
  const emptyEl = $("chartEmpty");

  const W = Math.max(240, Math.round(wrap.clientWidth || 360));
  const H = Math.max(88, Math.round(wrap.clientHeight || 104));
  const padX = 10;
  const padTop = 24;
  const padBottom = 10;

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const series = turns
    .map((t, idx) => {
      if (kind === "speed") {
        return {
          x: idx,
          val: t.speedTokPerSec,
          label: t.speedTokPerSec !== null ? `${t.speedTokPerSec} tok/s` : "",
        };
      }
      if (kind === "latency") {
        return {
          x: idx,
          val: t.latencyMs !== null ? +(t.latencyMs / 1000).toFixed(2) : null,
          label: fmtSec(t.latencyMs),
        };
      }
      return {
        x: idx,
        val: +(t.contextTokens / 1000).toFixed(1),
        label: fmtTokens(t.contextTokens),
      };
    })
    .filter((p) => typeof p.val === "number" && Number.isFinite(p.val)) as Array<{
    x: number;
    val: number;
    label: string;
  }>;

  if (series.length === 0) {
    svg.innerHTML = "";
    axisMaxEl.textContent = "";
    summaryEl.textContent = "";
    emptyEl.classList.remove("hidden");
    return;
  }

  emptyEl.classList.add("hidden");

  const maxVal = Math.max(...series.map((s) => s.val), 1);
  const unit = kind === "speed" ? "tok/s" : kind === "latency" ? "s" : "K";
  const strokeColor =
    kind === "speed" ? "var(--accent)" : kind === "latency" ? "var(--warn)" : "var(--good)";

  const last = series[series.length - 1];
  axisMaxEl.textContent = `max ${maxVal.toFixed(1)} ${unit}`;
  summaryEl.textContent = `last ${last.label}`;

  const plotH = Math.max(10, H - padTop - padBottom);
  const baseY = H - padBottom;
  const midY = +(padTop + plotH / 2).toFixed(1);

  if (series.length === 1) {
    const cx = +(W / 2).toFixed(1);
    const cy = +(baseY - (series[0].val / maxVal) * plotH).toFixed(1);
    svg.innerHTML = `
      <line x1="${padX}" y1="${padTop}" x2="${W - padX}" y2="${padTop}" stroke="var(--border)" stroke-dasharray="3,3" stroke-width="1"></line>
      <line x1="${padX}" y1="${baseY}" x2="${W - padX}" y2="${baseY}" stroke="var(--border)" stroke-width="1"></line>
      <circle cx="${cx}" cy="${cy}" r="4" fill="${strokeColor}"><title>#1 · ${escHtml(series[0].label)}</title></circle>
    `;
    return;
  }

  const stepX = (W - padX * 2) / (series.length - 1);
  const pts = series.map((s, i) => {
    const px = +(padX + i * stepX).toFixed(1);
    const py = +(baseY - (s.val / maxVal) * plotH).toFixed(1);
    return { px, py, idx: i + 1, ...s };
  });

  const lineD = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.px},${p.py}`).join(" ");
  const areaD = `${lineD} L${pts[pts.length - 1].px},${baseY} L${pts[0].px},${baseY} Z`;

  svg.innerHTML = `
    <line x1="${padX}" y1="${padTop}" x2="${W - padX}" y2="${padTop}" stroke="var(--border)" stroke-dasharray="3,3" stroke-width="1"></line>
    <line x1="${padX}" y1="${midY}" x2="${W - padX}" y2="${midY}" stroke="var(--border)" stroke-opacity="0.45" stroke-dasharray="2,4" stroke-width="1"></line>
    <line x1="${padX}" y1="${baseY}" x2="${W - padX}" y2="${baseY}" stroke="var(--border)" stroke-width="1"></line>
    <path d="${areaD}" fill="${strokeColor}" fill-opacity="0.14"></path>
    <path d="${lineD}" fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>
    ${pts
      .map(
        (p) =>
          `<circle cx="${p.px}" cy="${p.py}" r="2.6" fill="${strokeColor}"><title>#${p.idx} · ${escHtml(p.label)}</title></circle>`,
      )
      .join("")}
  `;
}

function renderSnapshot(snap: Snapshot) {
  currentSnapshot = snap;

  if (!hasHydratedServerPrefs && snap.uiPrefs && Array.isArray(snap.uiPrefs.collapsedCards)) {
    hasHydratedServerPrefs = true;
    collapsedCards = new Set(snap.uiPrefs.collapsedCards);
    saveLocalCollapsed();
    applyCollapsedState();
  }

  // Keep user's explicit selection only if it still exists in the list
  if (
    selectedConversationId &&
    snap.conversations.length > 0 &&
    !snap.conversations.some((c) => c.conversationId === selectedConversationId)
  ) {
    selectedConversationId = snap.activeConversationId;
  } else if (!selectedConversationId && snap.activeConversationId) {
    selectedConversationId = snap.activeConversationId;
  }

  // Project selector (filter conversations by project)
  const projSelect = $<HTMLSelectElement>("projectSelect");
  const projects = snap.projects || [];
  if (selectedProject && !projects.some((p) => p.name === selectedProject)) {
    selectedProject = "";
  }
  projSelect.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = projects.length > 0 ? `全部项目 (${snap.conversations.length})` : "全部项目";
  if (!selectedProject) allOpt.selected = true;
  projSelect.appendChild(allOpt);
  for (const p of projects) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = `${p.hasActive ? "● " : ""}${p.name} (${p.count})`;
    opt.title = `${p.name} · ${p.count} 个会话`;
    if (p.name === selectedProject) opt.selected = true;
    projSelect.appendChild(opt);
  }
  projSelect.classList.toggle("hidden", projects.length === 0);
  projSelect.title = selectedProject ? `当前筛选项目: ${selectedProject}` : "按项目筛选会话";

  // Conversation selector (filtered by selectedProject when set)
  const filteredConvs = selectedProject
    ? snap.conversations.filter((c) => c.projectName === selectedProject)
    : snap.conversations;

  const convSelect = $<HTMLSelectElement>("convSelect");
  const prevVal = selectedConversationId || snap.activeConversationId || "";
  convSelect.innerHTML = "";
  if (filteredConvs.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "无项目会话";
    convSelect.appendChild(opt);
    convSelect.title = "无项目会话";
  } else {
    let selectedFullTitle = "切换会话";
    for (const c of filteredConvs) {
      const opt = document.createElement("option");
      opt.value = c.conversationId;
      const displayText = selectedProject
        ? c.shortTitle || c.title || c.shortId
        : c.label || c.title || c.shortId;
      const fullText = c.fullLabel || displayText;
      opt.textContent = `${c.isActive ? "● " : ""}${displayText}`;
      opt.title = `${fullText} · ${c.shortId} (${c.sizeKB}KB)`;
      if (c.conversationId === prevVal) {
        opt.selected = true;
        selectedFullTitle = opt.title;
      }
      convSelect.appendChild(opt);
    }
    convSelect.title = selectedFullTitle;
  }

  // Mode UI
  const mode = snap.mode;
  const badge = $("modeBadge");
  const info = snap.modeDescriptions?.[mode];
  badge.textContent = info ? `${info.label.toUpperCase()} · ${info.badge}` : mode.toUpperCase();
  badge.setAttribute("data-mode", mode);
  $("modeDesc").textContent = info?.summary || "";

  document.querySelectorAll<HTMLButtonElement>("#modeSegment .seg-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });

  // Metrics
  const m = snap.metrics;
  if (!m) {
    $("modelBadge").textContent = "no session";
    $("ctxPct").textContent = "--";
    $("ctxUsed").textContent = "0";
    $("ctxRatio").textContent = "0 / 1.0M";
    $("cacheHit").textContent = "--";
    $("uncachedIn").textContent = "0";
    $("latestOut").textContent = "0";
    $("totIn").textContent = "0";
    $("totCache").textContent = "0";
    $("totOut").textContent = "0";
    $("totTurns").textContent = "0 / 0";
    $("latLatest").textContent = "--";
    $("spdLatest").textContent = "--";
    $("latAvg").textContent = "--";
    $("spdAvg").textContent = "--";
    $("latencySource").textContent = "no data";
    $("miniContext").textContent = "--";
    $("miniPerf").textContent = "--";
    $("convTitle").textContent = "";
    renderContextPopover(null);
    renderTrendChart([], activeChart);
  } else {
    $("modelBadge").textContent = m.model;

    const pct = Math.min(100, Math.max(0, m.context.usedPct));
    const offset = CIRCUMFERENCE * (1 - pct / 100);
    const ring = $("ringFg");
    ring.style.strokeDasharray = String(CIRCUMFERENCE);
    ring.style.strokeDashoffset = String(offset);
    ring.style.stroke = pct >= 85 ? "var(--danger)" : pct >= 60 ? "var(--warn)" : "var(--good)";

    $("ctxPct").textContent = `${pct.toFixed(1)}%`;
    $("ctxUsed").textContent = fmtTokens(m.context.usedTokens);
    $("miniContext").textContent = `${pct.toFixed(1)}% · ${fmtTokens(m.context.usedTokens)}`;
    $("ctxRatio").textContent = `${fmtTokens(m.context.usedTokens)} / ${fmtTokens(m.context.limitTokens)}`;
    $("cacheHit").textContent = `${m.context.cacheHitPct.toFixed(1)}%`;
    $("uncachedIn").textContent = fmtTokens(m.context.uncachedInputTokens);
    $("latestOut").textContent = fmtTokens(m.context.outputTokensLatest);
    renderContextPopover(m.context);

    $("totIn").textContent = fmtTokens(m.totals.inputTokens);
    $("totCache").textContent = fmtTokens(m.totals.cacheReadTokens);
    $("totOut").textContent = fmtTokens(m.totals.outputTokens);
    $("totTurns").textContent = `${m.totals.turns} / ${m.totals.toolCalls}`;

    const p = m.performance;
    $("latLatest").textContent = fmtSec(p.latestLatencyMs);
    $("spdLatest").textContent = p.latestSpeedTokPerSec !== null ? `${p.latestSpeedTokPerSec} tok/s` : "--";
    $("miniPerf").textContent =
      p.latestSpeedTokPerSec !== null
        ? `${fmtSec(p.latestLatencyMs)} · ${p.latestSpeedTokPerSec} tok/s`
        : fmtSec(p.latestLatencyMs);
    $("latAvg").textContent = `${fmtSec(p.avgLatencyMs)} / ${fmtSec(p.p95LatencyMs)}`;
    $("spdAvg").textContent =
      p.avgSpeedTokPerSec !== null
        ? `${p.avgSpeedTokPerSec} / ${p.peakSpeedTokPerSec ?? "--"}`
        : "--";

    $("latencySource").textContent =
      p.hookMeasuredTurns > 0
        ? `Hook 毫秒 (${p.hookMeasuredTurns}/${p.measuredTurns})`
        : p.measuredTurns > 0
          ? `日志估算 (${p.measuredTurns} 轮)`
          : "等待采样";

    renderTrendChart(m.recentTurns, activeChart);
    const footerText = m.displayLabel || m.title || m.conversationId || "";
    $("convTitle").textContent = footerText;
    $("convTitle").title = footerText;
  }

  const dt = new Date(snap.generatedAt);
  $("updatedAt").textContent = `更新 ${dt.toLocaleTimeString("zh-CN", { hour12: false })}`;
  renderUsage(snap.usage);
}

async function main() {
  const app = new App({ name: "Agy Cockpit", version: "1.0.0" }, {});

  app.ontoolinput = () => {
    $("liveDot").classList.add("busy");
  };

  app.ontoolresult = (result: any) => {
    $("liveDot").classList.remove("busy");
    if (result?.structuredContent) {
      stateSeq++;
      renderSnapshot(result.structuredContent as Snapshot);
    }
  };

  app.onhostcontextchanged = (ctx: any) => {
    if (ctx?.theme) applyDocumentTheme(ctx.theme);
    if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  };

  const refresh = async (silent = true) => {
    if (pollInFlight) return;
    pollInFlight = true;
    const reqSeq = ++stateSeq;
    $("liveDot").classList.add("busy");
    try {
      const args: Record<string, unknown> = {};
      if (selectedConversationId) args.conversationId = selectedConversationId;
      if (selectedLimitOverride > 0) args.contextLimit = selectedLimitOverride;
      const res: any = await app.callServerTool({
        name: "cockpit_get_snapshot",
        arguments: args,
      });
      if (reqSeq === stateSeq && res?.structuredContent) {
        renderSnapshot(res.structuredContent as Snapshot);
      }
      if (!silent) showToast("已刷新实时遥测");
    } catch (err: any) {
      if (!silent) showToast(`刷新失败: ${err?.message || err}`, true);
    } finally {
      pollInFlight = false;
      if (!modeInFlight) $("liveDot").classList.remove("busy");
    }
  };

  const resetPoll = () => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    const ms = Number($<HTMLSelectElement>("refreshSelect").value);
    if (ms > 0) {
      pollTimer = window.setInterval(() => {
        void refresh(true);
      }, ms);
    }
  };

  // Re-render SVG at exact 1:1 pixel dimensions when container resizes
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      if (currentSnapshot?.metrics) {
        renderTrendChart(currentSnapshot.metrics.recentTurns, activeChart);
      }
    });
    ro.observe($("chartWrap"));
  }

  // Hydrate instant local collapse prefs before server snapshot arrives
  collapsedCards = loadLocalCollapsed();
  applyCollapsedState();

  // Wire collapsible cards (persist locally + backend ui_prefs.json)
  document.querySelectorAll<HTMLButtonElement>(".card-toggle[data-toggle-card]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.toggleCard as CardId;
      if (!id) return;
      hasHydratedServerPrefs = true;
      if (collapsedCards.has(id)) {
        collapsedCards.delete(id);
      } else {
        collapsedCards.add(id);
        if (id === "context") $("ringAnchor").classList.remove("pinned");
      }
      applyCollapsedState();
      saveLocalCollapsed();
      if (id === "perf" && !collapsedCards.has("perf") && currentSnapshot?.metrics) {
        window.requestAnimationFrame(() => {
          if (currentSnapshot?.metrics) {
            renderTrendChart(currentSnapshot.metrics.recentTurns, activeChart);
          }
        });
      }
      void app
        .callServerTool({
          name: "cockpit_set_ui_prefs",
          arguments: { collapsedCards: Array.from(collapsedCards) },
        })
        .catch(() => {
          // local storage already saved; ignore transient RPC errors
        });
    });
  });

  // Wire UI listeners
  const ringAnchor = $("ringAnchor");
  $("ringTrigger").addEventListener("click", (e) => {
    e.stopPropagation();
    ringAnchor.classList.toggle("pinned");
  });
  document.addEventListener("click", (e) => {
    if (!ringAnchor.contains(e.target as Node)) {
      ringAnchor.classList.remove("pinned");
    }
  });
  $("refreshBtn").addEventListener("click", () => void refresh(false));
  $("refreshSelect").addEventListener("change", resetPoll);
  $("projectSelect").addEventListener("change", (e) => {
    selectedProject = (e.target as HTMLSelectElement).value || "";
    if (currentSnapshot) {
      const matching = selectedProject
        ? currentSnapshot.conversations.filter((c) => c.projectName === selectedProject)
        : currentSnapshot.conversations;
      if (matching.length > 0 && !matching.some((c) => c.conversationId === selectedConversationId)) {
        selectedConversationId = matching[0].conversationId;
        void refresh(false);
        return;
      }
      renderSnapshot(currentSnapshot);
    }
  });
  $("convSelect").addEventListener("change", (e) => {
    const val = (e.target as HTMLSelectElement).value;
    selectedConversationId = val || null;
    void refresh(false);
  });
  $("limitSelect").addEventListener("change", (e) => {
    selectedLimitOverride = Number((e.target as HTMLSelectElement).value) || 0;
    void refresh(true);
  });

  document.querySelectorAll<HTMLButtonElement>("#modeSegment .seg-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const targetMode = btn.dataset.mode as Mode;
      if (!targetMode || modeInFlight) return;
      modeInFlight = true;
      const reqSeq = ++stateSeq;
      $("liveDot").classList.add("busy");
      try {
        const args: Record<string, unknown> = { mode: targetMode };
        if (selectedConversationId) args.conversationId = selectedConversationId;
        if (selectedLimitOverride > 0) args.contextLimit = selectedLimitOverride;
        const res: any = await app.callServerTool({
          name: "cockpit_set_mode",
          arguments: args,
        });
        if (reqSeq === stateSeq && res?.structuredContent) {
          renderSnapshot(res.structuredContent as Snapshot);
        }
        showToast(`已切换为 ${targetMode.toUpperCase()} 模式（下一轮/下一次工具调用立即生效）`);
      } catch (err: any) {
        showToast(`切换模式失败: ${err?.message || err}`, true);
      } finally {
        modeInFlight = false;
        if (!pollInFlight) $("liveDot").classList.remove("busy");
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>("#chartTabs .tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeChart = (btn.dataset.chart as ChartKind) || "speed";
      document.querySelectorAll<HTMLButtonElement>("#chartTabs .tab-btn").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      if (currentSnapshot?.metrics) {
        renderTrendChart(currentSnapshot.metrics.recentTurns, activeChart);
      }
    });
  });

  const updateQuotas = async (patch: Record<string, unknown>, okMsg: string) => {
    const reqSeq = ++stateSeq;
    $("liveDot").classList.add("busy");
    try {
      const args: Record<string, unknown> = { ...patch };
      if (selectedConversationId) args.conversationId = selectedConversationId;
      if (selectedLimitOverride > 0) args.contextLimit = selectedLimitOverride;
      const res: any = await app.callServerTool({
        name: "cockpit_set_quotas",
        arguments: args,
      });
      if (reqSeq === stateSeq && res?.structuredContent) {
        renderSnapshot(res.structuredContent as Snapshot);
      }
      showToast(okMsg);
    } catch (err: any) {
      showToast(`更新限额失败: ${err?.message || err}`, true);
    } finally {
      if (!pollInFlight && !modeInFlight) $("liveDot").classList.remove("busy");
    }
  };

  $("quotaMetricSelect").addEventListener("change", (e) => {
    const metric = (e.target as HTMLSelectElement).value as QuotaMetric;
    void updateQuotas(
      { metric },
      metric === "total" ? "已切换为总计 Token（含缓存）口径" : "已切换为非缓存 Token（新入+输出）口径",
    );
  });

  $("quotaEditToggle").addEventListener("click", () => {
    const editor = $("quotaEditor");
    editor.classList.toggle("hidden");
    if (!editor.classList.contains("hidden") && currentSnapshot?.usage) {
      $<HTMLInputElement>("input5hLimit").value = formatLimitInput(
        currentSnapshot.usage.quotaConfig.fiveHourLimit,
      );
      $<HTMLInputElement>("input7dLimit").value = formatLimitInput(
        currentSnapshot.usage.quotaConfig.weeklyLimit,
      );
    }
  });

  $("quotaEditor").addEventListener("submit", (e) => {
    e.preventDefault();
    const lim5h = parseTokenShorthand($<HTMLInputElement>("input5hLimit").value);
    const lim7d = parseTokenShorthand($<HTMLInputElement>("input7dLimit").value);
    if (!lim5h || !lim7d) {
      showToast("请输入有效的数字或简写（如 8M、20M、65M）", true);
      return;
    }
    $("quotaEditor").classList.add("hidden");
    void updateQuotas(
      { fiveHourLimit: lim5h, weeklyLimit: lim7d },
      `已保存当前口径限额（5h: ${fmtTokens(lim5h)} · 7d: ${fmtTokens(lim7d)}）`,
    );
  });

  $("quotaCalBtn").addEventListener("click", () => {
    const usage = currentSnapshot?.usage;
    if (!usage) return;
    const raw5 = $<HTMLInputElement>("inputCal5hLeft").value.trim();
    const raw7 = $<HTMLInputElement>("inputCal7dLeft").value.trim();
    const patch: Record<string, unknown> = {};
    const notes: string[] = [];

    if (raw5) {
      const left5 = Number(raw5);
      if (!Number.isFinite(left5) || left5 <= 0 || left5 >= 100) {
        showToast("5h 剩余% 需为 1–99 之间的数字", true);
        return;
      }
      if (usage.fiveHour.usedTokens <= 0) {
        showToast("近 5h 尚无本地 Token 消耗，无法按剩余%反推", true);
        return;
      }
      const cap5 = Math.round(usage.fiveHour.usedTokens / ((100 - left5) / 100));
      patch.fiveHourLimit = cap5;
      notes.push(`5h→${fmtTokens(cap5)}`);
    }
    if (raw7) {
      const left7 = Number(raw7);
      if (!Number.isFinite(left7) || left7 <= 0 || left7 >= 100) {
        showToast("7d 剩余% 需为 1–99 之间的数字", true);
        return;
      }
      if (usage.weekly.usedTokens <= 0) {
        showToast("近 7d 尚无本地 Token 消耗，无法按剩余%反推", true);
        return;
      }
      const cap7 = Math.round(usage.weekly.usedTokens / ((100 - left7) / 100));
      patch.weeklyLimit = cap7;
      notes.push(`7d→${fmtTokens(cap7)}`);
    }
    if (notes.length === 0) {
      showToast("请至少填入一个官方剩余%（例如 5h=69、7d=86）", true);
      return;
    }
    $("quotaEditor").classList.add("hidden");
    void updateQuotas(patch, `已按官方剩余%校准预算（${notes.join(" · ")}）`);
  });

  await app.connect();

  const hostCtx: any = app.getHostContext();
  if (hostCtx?.theme) applyDocumentTheme(hostCtx.theme);
  if (hostCtx?.styles?.variables) applyHostStyleVariables(hostCtx.styles.variables);

  const caps: any = app.getHostCapabilities();
  if (caps?.message) {
    $("quickBar").classList.remove("hidden");
    document.querySelectorAll<HTMLButtonElement>("#quickBar .pill-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const cmd = btn.dataset.cmd;
        if (!cmd) return;
        try {
          await app.sendMessage({
            role: "user",
            content: [{ type: "text", text: cmd }],
          });
          showToast(`已向当前对话发送 ${cmd}`);
        } catch (err: any) {
          showToast(`发送失败: ${err?.message || err}`, true);
        }
      });
    });
  }

  // Initial fetch if host didn't already push tool result
  if (!currentSnapshot) {
    await refresh(true);
  }
  resetPoll();
}

void main();
