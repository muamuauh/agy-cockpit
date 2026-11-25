import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  extractProjectName,
  getActiveSession,
  getModeState,
  getQuotaConfig,
  getSessionsIndex,
  getUiPrefs,
  MODE_DESCRIPTIONS,
  readTelemetry,
} from "../shared/state.mjs";

const _require = createRequire(import.meta.url);
let _DatabaseSync = null;
try {
  const sqliteMod = _require("node:sqlite");
  _DatabaseSync = sqliteMod?.DatabaseSync || null;
} catch {
  _DatabaseSync = null;
}

const MODEL_CONTEXT_LIMITS = [
  { match: /gemini/i, limit: 1_000_000 },
  { match: /claude.*\[1m\]|claude.*1m/i, limit: 1_000_000 },
  { match: /claude/i, limit: 200_000 },
  { match: /gpt-5|gpt-4\.1/i, limit: 1_000_000 },
  { match: /o[134]|gpt-4/i, limit: 200_000 },
];

export function inferContextLimit(modelName, overrideLimit = null) {
  if (typeof overrideLimit === "number" && Number.isFinite(overrideLimit) && overrideLimit > 0) {
    return Math.round(overrideLimit);
  }
  const name = String(modelName || "");
  for (const rule of MODEL_CONTEXT_LIMITS) {
    if (rule.match.test(name)) return rule.limit;
  }
  return 1_000_000;
}

export function getDefaultBrainRoots() {
  const gemini = path.join(os.homedir(), ".gemini");
  return [
    path.join(gemini, "antigravity", "brain"),
    path.join(gemini, "antigravity-ide", "brain"),
    path.join(gemini, "antigravity-cli", "brain"),
  ];
}

export function truncateDisplay(str, maxUnits = 22) {
  const clean = String(str || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  let units = 0;
  let out = "";
  for (const ch of clean) {
    const code = ch.codePointAt(0) || 0;
    const w = code > 0x2e7f ? 2 : 1;
    if (units + w > maxUnits) {
      return out.trimEnd() + "…";
    }
    out += ch;
    units += w;
  }
  return out;
}

export function formatConversationLabel({
  title = "",
  projectName = "",
  agentName = "",
  parentTitle = "",
  shortId = "",
  maxTitleUnits = 20,
  maxProjectUnits = 16,
} = {}) {
  const cleanTitle = String(title || "").replace(/\s+/g, " ").trim();
  const cleanParent = String(parentTitle || "").replace(/\s+/g, " ").trim();
  const cleanAgent = String(agentName || "").replace(/\s+/g, " ").trim();
  const cleanProject = String(projectName || "").replace(/\s+/g, " ").trim();

  let baseFull;
  if (cleanAgent) {
    const inner = cleanTitle || cleanParent;
    baseFull = inner ? `[${cleanAgent}] ${inner}` : `[${cleanAgent}]`;
  } else {
    baseFull = cleanTitle || shortId || "Untitled";
  }

  const fullLabel = cleanProject ? `${baseFull} (${cleanProject})` : baseFull;
  const shortBase = truncateDisplay(baseFull, maxTitleUnits);
  const label = cleanProject
    ? `${shortBase} (${truncateDisplay(cleanProject, maxProjectUnits)})`
    : shortBase;

  return { label, fullLabel, title: baseFull, projectName: cleanProject };
}

function preferCompactTranscriptPath(transcriptPath) {
  if (!transcriptPath) return transcriptPath;
  if (path.basename(transcriptPath) === "transcript_full.jsonl") {
    const compact = path.join(path.dirname(transcriptPath), "transcript.jsonl");
    try {
      if (fs.existsSync(compact) && fs.statSync(compact).size > 0) {
        return compact;
      }
    } catch {
      // fall back to original path
    }
  }
  return transcriptPath;
}

export function readConversationSummaries(brainRoots = getDefaultBrainRoots()) {
  const map = new Map();
  if (!_DatabaseSync) return map;

  const seenDbPaths = new Set();
  for (const root of brainRoots) {
    const dbPath = path.join(path.dirname(root), "conversation_summaries.db");
    if (seenDbPaths.has(dbPath) || !fs.existsSync(dbPath)) continue;
    seenDbPaths.add(dbPath);

    let db = null;
    try {
      db = new _DatabaseSync(dbPath, { readOnly: true, timeout: 500 });
      const rows = db
        .prepare(
          "SELECT conversation_id, title, workspace_uris, project_id, agent_name, parent_conversation_id, nesting_depth FROM conversation_summaries",
        )
        .all();
      for (const row of rows) {
        const id = row?.conversation_id;
        if (!id) continue;
        let projectName = "";
        if (typeof row.workspace_uris === "string" && row.workspace_uris.trim()) {
          try {
            const uris = JSON.parse(row.workspace_uris);
            if (Array.isArray(uris) && uris.length > 0) {
              projectName = extractProjectName(uris[0]);
            }
          } catch {
            // ignore malformed json
          }
        }
        map.set(id, {
          title: typeof row.title === "string" ? row.title.trim() : "",
          projectName,
          projectId: typeof row.project_id === "string" ? row.project_id.trim() : "",
          agentName: typeof row.agent_name === "string" ? row.agent_name.trim() : "",
          parentConversationId:
            typeof row.parent_conversation_id === "string" ? row.parent_conversation_id.trim() : "",
          nestingDepth: Number(row.nesting_depth) || 0,
        });
      }
    } catch {
      // Non-fatal: DB may be locked, unreadable in sandbox, or schema changed
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }
  return map;
}

export function extractTranscriptHeadMeta(transcriptPath, maxBytes = 16 * 1024) {
  let fd = null;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    if (bytesRead <= 0) {
      return { title: "", projectName: "", firstStepIndex: 0, isSubagentTranscript: false };
    }
    const chunk = buf.subarray(0, bytesRead).toString("utf8");
    const lines = chunk.split(/\r?\n/);
    let title = "";
    let firstStepIndex = 0;
    let sawFirstRecord = false;
    let isSubagentTranscript = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!sawFirstRecord) {
        sawFirstRecord = true;
        firstStepIndex = toNum(rec.step_index);
        if (rec.type === "SYSTEM_MESSAGE" && rec.source === "SYSTEM") {
          isSubagentTranscript = true;
        }
      }
      if (!title && rec.type === "USER_INPUT" && typeof rec.content === "string") {
        const m = rec.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
        const text = (m ? m[1] : rec.content).replace(/\s+/g, " ").trim();
        if (text) {
          title = text.slice(0, 80);
          break;
        }
      }
    }
    return { title, projectName: "", firstStepIndex, isSubagentTranscript };
  } catch {
    return { title: "", projectName: "", firstStepIndex: 0, isSubagentTranscript: false };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export function discoverConversations({ brainRoots = getDefaultBrainRoots(), activeSession = null } = {}) {
  const map = new Map();

  const register = (id, transcriptPath, source) => {
    const resolvedPath = preferCompactTranscriptPath(transcriptPath);
    if (!resolvedPath || !fs.existsSync(resolvedPath)) return;
    try {
      const st = fs.statSync(resolvedPath);
      if (!st.isFile() || st.size === 0) return;
      const prev = map.get(id);
      if (!prev || st.mtimeMs > prev.mtimeMs) {
        map.set(id, {
          conversationId: id,
          transcriptPath: resolvedPath,
          mtimeMs: st.mtimeMs,
          sizeBytes: st.size,
          source,
        });
      }
    } catch {
      // ignore unreadable paths
    }
  };

  if (activeSession?.transcriptPath) {
    const id =
      activeSession.conversationId ||
      path.basename(path.dirname(path.dirname(path.dirname(activeSession.transcriptPath))));
    register(id, activeSession.transcriptPath, "active_hook");
  }

  for (const root of brainRoots) {
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const tPath = path.join(root, ent.name, ".system_generated", "logs", "transcript.jsonl");
      register(ent.name, tPath, path.basename(path.dirname(root)));
    }
  }

  return Array.from(map.values()).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseIsoMs(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function estimateTextTokens(text) {
  if (!text || typeof text !== "string") return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x2e80 && c <= 0x9fff) cjk++;
  }
  const nonCjk = text.length - cjk;
  let est = cjk * 0.65 + nonCjk * 0.25;
  // Compact transcript.jsonl records omitted bytes as "<truncated N bytes>"
  const truncMatches = text.matchAll(/<truncated (\d+) bytes>/g);
  for (const m of truncMatches) {
    est += Number(m[1]) / 3.5;
  }
  return Math.max(1, Math.round(est));
}

function computeContextBreakdown(records, turns, contextUsed, contextLimit) {
  const freeTokens = Math.max(0, contextLimit - contextUsed);
  const pctOfLimit = (n) => (contextLimit > 0 ? +((n / contextLimit) * 100).toFixed(1) : 0);
  const pctOfUsed = (n) => (contextUsed > 0 ? +((n / contextUsed) * 100).toFixed(1) : 0);

  if (!turns.length || contextUsed <= 0) {
    return {
      freeTokens,
      freePct: pctOfLimit(freeTokens),
      lastDeltaTokens: 0,
      avgGrowthPerTurn: null,
      estTurnsRemaining: null,
      compactionCount: 0,
      segments: [
        { key: "system", label: "系统指令 & 工具定义", tokens: 0, pctOfLimit: 0, pctOfUsed: 0 },
        { key: "tools", label: "工具输出 / 文件内容", tokens: 0, pctOfLimit: 0, pctOfUsed: 0 },
        { key: "assistant", label: "模型回复 & 调用参数", tokens: 0, pctOfLimit: 0, pctOfUsed: 0 },
        { key: "user", label: "用户 & 系统消息", tokens: 0, pctOfLimit: 0, pctOfUsed: 0 },
      ],
      topTools: [],
    };
  }

  // Detect compaction drops (>28% context reduction from >20K)
  let compactionCount = 0;
  let activeStartRecIdx = 0;
  const recentDeltas = [];
  for (let t = 1; t < turns.length; t++) {
    const prevCtx = turns[t - 1].contextTokens;
    const curCtx = turns[t].contextTokens;
    if (prevCtx > 20_000 && curCtx < prevCtx * 0.72) {
      compactionCount++;
      activeStartRecIdx = turns[t]._recIdx;
    } else if (curCtx > prevCtx) {
      recentDeltas.push(curCtx - prevCtx);
    }
  }

  // Anchor system prompt + tool definitions baseline from turn 0
  const firstTurn = turns[0];
  let preFirstUserEst = 0;
  for (let i = 0; i < firstTurn._recIdx; i++) {
    const rec = records[i];
    if (rec.type === "USER_INPUT" || rec.type === "SYSTEM_MESSAGE") {
      preFirstUserEst += estimateTextTokens(rec.content);
      if (Array.isArray(rec.media)) preFirstUserEst += rec.media.length * 1000;
    }
  }
  const systemTokens = Math.min(contextUsed, Math.max(0, Math.round(firstTurn.contextTokens - preFirstUserEst)));

  // Accumulate raw weights in the active (post-last-compaction) window up to the latest turn
  const latestRecIdx = turns[turns.length - 1]._recIdx;
  let toolOutputsRaw = 0;
  let assistantRaw = 0;
  let userRaw = 0;
  const toolWeightByName = new Map();
  const pendingTools = [];

  for (let i = activeStartRecIdx; i <= latestRecIdx; i++) {
    const rec = records[i];
    if (rec.type === "USER_INPUT") {
      userRaw += estimateTextTokens(rec.content);
      if (Array.isArray(rec.media)) userRaw += rec.media.length * 1000;
    } else if (rec.type === "SYSTEM_MESSAGE") {
      userRaw += estimateTextTokens(rec.content);
    } else if (rec.type === "PLANNER_RESPONSE") {
      assistantRaw += estimateTextTokens(rec.content);
      if (typeof rec.thinking === "string" && rec.thinking) {
        assistantRaw += Math.round(estimateTextTokens(rec.thinking) * 0.35);
      }
      if (Array.isArray(rec.tool_calls)) {
        for (const tc of rec.tool_calls) {
          const name = tc?.name || "tool";
          pendingTools.push(name);
          assistantRaw += estimateTextTokens(JSON.stringify(tc));
        }
      }
    } else if (rec.type === "GENERIC") {
      const w = estimateTextTokens(rec.content);
      toolOutputsRaw += w;
      const toolName = pendingTools.shift() || "other";
      toolWeightByName.set(toolName, (toolWeightByName.get(toolName) || 0) + w);
    }
  }

  const convBudget = Math.max(0, contextUsed - systemTokens);
  const rawSum = toolOutputsRaw + assistantRaw + userRaw;

  let toolsTokens = 0;
  let assistantTokens = 0;
  let userTokens = 0;
  if (rawSum > 0 && convBudget > 0) {
    toolsTokens = Math.round((toolOutputsRaw / rawSum) * convBudget);
    assistantTokens = Math.round((assistantRaw / rawSum) * convBudget);
    userTokens = Math.max(0, convBudget - toolsTokens - assistantTokens);
  } else if (convBudget > 0) {
    userTokens = convBudget;
  }

  const topTools = Array.from(toolWeightByName.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, rawW]) => {
      const estTok = toolOutputsRaw > 0 ? Math.round((rawW / toolOutputsRaw) * toolsTokens) : 0;
      return {
        name,
        tokens: estTok,
        pctOfUsed: pctOfUsed(estTok),
      };
    })
    .filter((t) => t.tokens > 0);

  const lastDeltaTokens =
    turns.length >= 2
      ? turns[turns.length - 1].contextTokens - turns[turns.length - 2].contextTokens
      : contextUsed;

  const recentFive = recentDeltas.slice(-5);
  const avgGrowthPerTurn = recentFive.length
    ? Math.round(recentFive.reduce((a, b) => a + b, 0) / recentFive.length)
    : null;
  const estTurnsRemaining =
    avgGrowthPerTurn && avgGrowthPerTurn > 0 ? Math.max(0, Math.floor(freeTokens / avgGrowthPerTurn)) : null;

  return {
    freeTokens,
    freePct: pctOfLimit(freeTokens),
    lastDeltaTokens,
    avgGrowthPerTurn,
    estTurnsRemaining,
    compactionCount,
    segments: [
      {
        key: "system",
        label: "系统指令 & 工具定义",
        tokens: systemTokens,
        pctOfLimit: pctOfLimit(systemTokens),
        pctOfUsed: pctOfUsed(systemTokens),
      },
      {
        key: "tools",
        label: "工具输出 / 文件内容",
        tokens: toolsTokens,
        pctOfLimit: pctOfLimit(toolsTokens),
        pctOfUsed: pctOfUsed(toolsTokens),
      },
      {
        key: "assistant",
        label: "模型回复 & 调用参数",
        tokens: assistantTokens,
        pctOfLimit: pctOfLimit(assistantTokens),
        pctOfUsed: pctOfUsed(assistantTokens),
      },
      {
        key: "user",
        label: "用户 & 系统消息",
        tokens: userTokens,
        pctOfLimit: pctOfLimit(userTokens),
        pctOfUsed: pctOfUsed(userTokens),
      },
    ],
    topTools,
  };
}

export function parseTranscriptFile(
  transcriptPath,
  {
    hookTelemetry = [],
    conversationId = null,
    contextLimitOverride = null,
    summaryMeta = null,
  } = {},
) {
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Ignore partial line while file is actively being written
    }
  }

  const relevantHooks = hookTelemetry
    .filter((h) => !conversationId || !h.conversationId || h.conversationId === conversationId)
    .filter((h) => typeof h.durationMs === "number" && h.durationMs > 0);

  let firstPromptTitle = "";
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let totalToolCalls = 0;
  const turns = [];

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!firstPromptTitle && rec.type === "USER_INPUT" && typeof rec.content === "string") {
      const m = rec.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
      const text = (m ? m[1] : rec.content).replace(/\s+/g, " ").trim();
      if (text) firstPromptTitle = text.slice(0, 80);
    }

    if (rec.type !== "PLANNER_RESPONSE") continue;

    const inputTokens = toNum(rec.input_tokens);
    const cacheReadTokens = toNum(rec.cache_read_tokens);
    const outputTokens = toNum(rec.output_tokens);
    const contextTokens = inputTokens + cacheReadTokens;
    const cacheHitPct = contextTokens > 0 ? +((cacheReadTokens / contextTokens) * 100).toFixed(1) : 0;
    const toolCalls = Array.isArray(rec.tool_calls) ? rec.tool_calls : [];
    const createdAtMs = parseIsoMs(rec.created_at);

    totalInputTokens += inputTokens;
    totalCacheReadTokens += cacheReadTokens;
    totalOutputTokens += outputTokens;
    totalToolCalls += toolCalls.length;

    // Transcript fallback delta to next logged step (1-second resolution).
    // For tool-calling turns, the next step's created_at marks tool start, i.e., pure model latency.
    let fallbackLatencyMs = null;
    if (createdAtMs !== null) {
      for (let j = i + 1; j < records.length; j++) {
        const nextRec = records[j];
        // Stop before next user prompt (that gap is user think time, not model latency)
        if (nextRec.type === "USER_INPUT") break;
        const nextMs = parseIsoMs(nextRec.created_at);
        if (nextMs !== null && nextMs > createdAtMs) {
          const delta = nextMs - createdAtMs;
          if (delta >= 500 && delta <= 600_000) {
            fallbackLatencyMs = delta;
          }
          break;
        }
      }
    }

    turns.push({
      stepIndex: toNum(rec.step_index),
      createdAt: rec.created_at || null,
      _createdAtMs: createdAtMs,
      _recIdx: i,
      model: rec.model || "unknown",
      inputTokens,
      cacheReadTokens,
      outputTokens,
      contextTokens,
      cacheHitPct,
      toolCallCount: toolCalls.length,
      latencyMs: fallbackLatencyMs,
      latencySource: fallbackLatencyMs !== null ? "transcript" : null,
      speedTokPerSec: null,
    });
  }

  // Optimal closest-pair matching for millisecond-precision Hook telemetry records.
  // Note: PostInvocation fires AFTER tool execution finishes, so for tool-calling turns where
  // Hook duration includes long tool/approval wait (> transcript pure-model delta + 1.5s),
  // keep the pure-model transcript delta so tok/s is not distorted by tool waits.
  if (relevantHooks.length > 0 && turns.length > 0) {
    const pairs = [];
    for (let tIdx = 0; tIdx < turns.length; tIdx++) {
      const tMs = turns[tIdx]._createdAtMs;
      if (tMs === null) continue;
      for (let hIdx = 0; hIdx < relevantHooks.length; hIdx++) {
        const h = relevantHooks[hIdx];
        const anchor = typeof h.startedAtMs === "number" ? h.startedAtMs : h.ts - h.durationMs;
        const diff = Math.abs(anchor - tMs);
        if (diff <= 8_000) {
          pairs.push({ diff, tIdx, hIdx });
        }
      }
    }
    pairs.sort((a, b) => a.diff - b.diff);
    const matchedTurns = new Set();
    const matchedHooks = new Set();
    for (const pair of pairs) {
      if (matchedTurns.has(pair.tIdx) || matchedHooks.has(pair.hIdx)) continue;
      matchedTurns.add(pair.tIdx);
      matchedHooks.add(pair.hIdx);

      const turn = turns[pair.tIdx];
      const hookMs = Math.round(relevantHooks[pair.hIdx].durationMs);
      const isToolWaitInflated =
        turn.toolCallCount > 0 && turn.latencyMs !== null && hookMs > turn.latencyMs + 1_500;
      if (!isToolWaitInflated) {
        turn.latencyMs = hookMs;
        turn.latencySource = "hook";
      }
    }
  }

  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const activeModel = latestTurn?.model || "unknown";
  const contextLimit = inferContextLimit(activeModel, contextLimitOverride);
  const contextUsed = latestTurn ? latestTurn.contextTokens : 0;
  const contextUsedPct = contextLimit > 0 ? +((contextUsed / contextLimit) * 100).toFixed(2) : 0;
  const contextBreakdown = computeContextBreakdown(records, turns, contextUsed, contextLimit);

  for (const turn of turns) {
    delete turn._createdAtMs;
    delete turn._recIdx;
    turn.speedTokPerSec =
      turn.latencyMs !== null && turn.latencyMs >= 200 && turn.outputTokens > 0
        ? +(turn.outputTokens / (turn.latencyMs / 1000)).toFixed(1)
        : null;
  }

  const latencies = turns.map((t) => t.latencyMs).filter((v) => typeof v === "number" && v > 0);
  const speeds = turns.map((t) => t.speedTokPerSec).filter((v) => typeof v === "number" && v > 0);

  const avgLatencyMs = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;
  const p95LatencyMs = percentile(latencies, 95);
  const avgSpeedTokPerSec = speeds.length
    ? +(speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(1)
    : null;
  const peakSpeedTokPerSec = speeds.length ? Math.max(...speeds) : null;

  const lastTimedTurn = [...turns].reverse().find((t) => t.latencyMs !== null) || null;

  const formatted = formatConversationLabel({
    title: summaryMeta?.title || firstPromptTitle,
    projectName: summaryMeta?.projectName || "",
    agentName: summaryMeta?.agentName || "",
    parentTitle: summaryMeta?.parentTitle || "",
    shortId: conversationId ? conversationId.slice(0, 8) : "Untitled",
  });

  return {
    conversationId,
    title: formatted.title,
    projectName: formatted.projectName,
    displayLabel: formatted.fullLabel,
    model: activeModel,
    context: {
      usedTokens: contextUsed,
      limitTokens: contextLimit,
      usedPct: contextUsedPct,
      cacheReadTokens: latestTurn?.cacheReadTokens || 0,
      uncachedInputTokens: latestTurn?.inputTokens || 0,
      cacheHitPct: latestTurn?.cacheHitPct || 0,
      outputTokensLatest: latestTurn?.outputTokens || 0,
      breakdown: contextBreakdown,
    },
    totals: {
      turns: turns.length,
      toolCalls: totalToolCalls,
      inputTokens: totalInputTokens,
      cacheReadTokens: totalCacheReadTokens,
      outputTokens: totalOutputTokens,
      overallCacheHitPct:
        totalInputTokens + totalCacheReadTokens > 0
          ? +((totalCacheReadTokens / (totalInputTokens + totalCacheReadTokens)) * 100).toFixed(1)
          : 0,
    },
    performance: {
      latestLatencyMs: lastTimedTurn?.latencyMs ?? null,
      latestLatencySource: lastTimedTurn?.latencySource ?? null,
      latestSpeedTokPerSec: lastTimedTurn?.speedTokPerSec ?? null,
      avgLatencyMs,
      p95LatencyMs,
      avgSpeedTokPerSec,
      peakSpeedTokPerSec,
      measuredTurns: latencies.length,
      hookMeasuredTurns: turns.filter((t) => t.latencySource === "hook").length,
    },
    recentTurns: turns.slice(-24),
  };
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// In-memory cache of compact token usage events keyed by transcriptPath
const _usageFileCache = new Map();

function readUsageEventsCached(transcriptPath, mtimeMs, sizeBytes) {
  const cached = _usageFileCache.get(transcriptPath);
  if (cached && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes) {
    return cached.events;
  }

  const events = [];
  try {
    const raw = fs.readFileSync(transcriptPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes("PLANNER_RESPONSE")) continue;
      let rec;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (rec.type !== "PLANNER_RESPONSE") continue;
      const tsMs = parseIsoMs(rec.created_at) ?? mtimeMs;
      events.push({
        tsMs,
        model: rec.model || "unknown",
        inputTokens: toNum(rec.input_tokens),
        cacheReadTokens: toNum(rec.cache_read_tokens),
        outputTokens: toNum(rec.output_tokens),
      });
    }
  } catch {
    return [];
  }

  _usageFileCache.set(transcriptPath, { mtimeMs, sizeBytes, events });
  if (_usageFileCache.size > 300) {
    const firstKey = _usageFileCache.keys().next().value;
    if (firstKey) _usageFileCache.delete(firstKey);
  }
  return events;
}

function localDateKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function makeEmptyBucket() {
  return {
    turns: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    billableTokens: 0,
    totalTokens: 0,
    oldestTsMs: null,
  };
}

function addEventToBucket(bucket, ev) {
  const billable = ev.inputTokens + ev.outputTokens;
  const total = billable + ev.cacheReadTokens;
  bucket.turns += 1;
  bucket.inputTokens += ev.inputTokens;
  bucket.cacheReadTokens += ev.cacheReadTokens;
  bucket.outputTokens += ev.outputTokens;
  bucket.billableTokens += billable;
  bucket.totalTokens += total;
  if (bucket.oldestTsMs === null || ev.tsMs < bucket.oldestTsMs) {
    bucket.oldestTsMs = ev.tsMs;
  }
}

function finalizeWindowBucket(bucket, { limitTokens, windowMs, metric, nowMs }) {
  const usedTokens = metric === "total" ? bucket.totalTokens : bucket.billableTokens;
  const usedPct = limitTokens > 0 ? +((usedTokens / limitTokens) * 100).toFixed(1) : 0;
  const remainingPct = +Math.max(0, Math.min(100, 100 - usedPct)).toFixed(1);
  const remainingTokens = Math.max(0, limitTokens - usedTokens);
  const nextResetInMs =
    bucket.oldestTsMs !== null && windowMs > 0
      ? Math.max(0, bucket.oldestTsMs + windowMs - nowMs)
      : null;

  return {
    turns: bucket.turns,
    inputTokens: bucket.inputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    outputTokens: bucket.outputTokens,
    billableTokens: bucket.billableTokens,
    totalTokens: bucket.totalTokens,
    usedTokens,
    limitTokens,
    usedPct,
    remainingPct,
    remainingTokens,
    oldestAt: bucket.oldestTsMs !== null ? new Date(bucket.oldestTsMs).toISOString() : null,
    nextResetInMs,
  };
}

function classifyModelPool(modelName) {
  const m = String(modelName || "").toLowerCase();
  if (m.includes("claude") || m.includes("gpt") || /^o[134]/.test(m)) {
    return "claude_gpt";
  }
  return "gemini";
}

export function computeUsageSummary({ conversations = [], quotaConfig, nowMs = Date.now() } = {}) {
  const metric = quotaConfig?.metric === "total" ? "total" : "billable";
  const defaultLimits =
    metric === "total"
      ? { fiveHourLimit: 65_000_000, weeklyLimit: 160_000_000 }
      : { fiveHourLimit: 8_000_000, weeklyLimit: 20_000_000 };
  const activeLimits = quotaConfig?.[metric] || quotaConfig || defaultLimits;
  const fiveHourLimit = activeLimits?.fiveHourLimit || defaultLimits.fiveHourLimit;
  const weeklyLimit = activeLimits?.weeklyLimit || defaultLimits.weeklyLimit;

  const fiveHourCutoff = nowMs - FIVE_HOURS_MS;
  const weeklyCutoff = nowMs - SEVEN_DAYS_MS;

  const fiveHour = makeEmptyBucket();
  const weekly = makeEmptyBucket();
  const allTime = makeEmptyBucket();
  const pools5h = { gemini: makeEmptyBucket(), claude_gpt: makeEmptyBucket() };
  const pools7d = { gemini: makeEmptyBucket(), claude_gpt: makeEmptyBucket() };

  // Prepare last 7 local calendar days buckets (oldest -> today)
  const dayStart = new Date(nowMs);
  dayStart.setHours(0, 0, 0, 0);
  const dailyMap = new Map();
  const dailyOrder = [];
  for (let offset = 6; offset >= 0; offset--) {
    const dMs = dayStart.getTime() - offset * 86_400_000;
    const key = localDateKey(dMs);
    const label = key.slice(5); // MM-DD
    const entry = {
      date: key,
      label,
      turns: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      billableTokens: 0,
      totalTokens: 0,
    };
    dailyMap.set(key, entry);
    dailyOrder.push(entry);
  }

  const byModelMap = new Map();

  for (const conv of conversations) {
    const events = readUsageEventsCached(conv.transcriptPath, conv.mtimeMs, conv.sizeBytes);
    for (const ev of events) {
      addEventToBucket(allTime, ev);

      if (ev.tsMs >= weeklyCutoff) {
        addEventToBucket(weekly, ev);
        addEventToBucket(pools7d[classifyModelPool(ev.model)], ev);

        const dayBucket = dailyMap.get(localDateKey(ev.tsMs));
        if (dayBucket) {
          const billable = ev.inputTokens + ev.outputTokens;
          dayBucket.turns += 1;
          dayBucket.inputTokens += ev.inputTokens;
          dayBucket.cacheReadTokens += ev.cacheReadTokens;
          dayBucket.outputTokens += ev.outputTokens;
          dayBucket.billableTokens += billable;
          dayBucket.totalTokens += billable + ev.cacheReadTokens;
        }

        let mEntry = byModelMap.get(ev.model);
        if (!mEntry) {
          mEntry = {
            model: ev.model,
            pool: classifyModelPool(ev.model),
            turns: 0,
            inputTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            billableTokens: 0,
            totalTokens: 0,
          };
          byModelMap.set(ev.model, mEntry);
        }
        const billable = ev.inputTokens + ev.outputTokens;
        mEntry.turns += 1;
        mEntry.inputTokens += ev.inputTokens;
        mEntry.cacheReadTokens += ev.cacheReadTokens;
        mEntry.outputTokens += ev.outputTokens;
        mEntry.billableTokens += billable;
        mEntry.totalTokens += billable + ev.cacheReadTokens;
      }

      if (ev.tsMs >= fiveHourCutoff) {
        addEventToBucket(fiveHour, ev);
        addEventToBucket(pools5h[classifyModelPool(ev.model)], ev);
      }
    }
  }

  const byModel7d = Array.from(byModelMap.values())
    .sort((a, b) =>
      metric === "total" ? b.totalTokens - a.totalTokens : b.billableTokens - a.billableTokens,
    )
    .slice(0, 6);

  return {
    metric,
    quotaConfig: {
      metric,
      fiveHourLimit,
      weeklyLimit,
      updatedAt: quotaConfig?.updatedAt || null,
    },
    conversationsScanned: conversations.length,
    fiveHour: finalizeWindowBucket(fiveHour, {
      limitTokens: fiveHourLimit,
      windowMs: FIVE_HOURS_MS,
      metric,
      nowMs,
    }),
    weekly: finalizeWindowBucket(weekly, {
      limitTokens: weeklyLimit,
      windowMs: SEVEN_DAYS_MS,
      metric,
      nowMs,
    }),
    pools: {
      gemini: {
        fiveHour: finalizeWindowBucket(pools5h.gemini, {
          limitTokens: fiveHourLimit,
          windowMs: FIVE_HOURS_MS,
          metric,
          nowMs,
        }),
        weekly: finalizeWindowBucket(pools7d.gemini, {
          limitTokens: weeklyLimit,
          windowMs: SEVEN_DAYS_MS,
          metric,
          nowMs,
        }),
      },
      claude_gpt: {
        fiveHour: finalizeWindowBucket(pools5h.claude_gpt, {
          limitTokens: fiveHourLimit,
          windowMs: FIVE_HOURS_MS,
          metric,
          nowMs,
        }),
        weekly: finalizeWindowBucket(pools7d.claude_gpt, {
          limitTokens: weeklyLimit,
          windowMs: SEVEN_DAYS_MS,
          metric,
          nowMs,
        }),
      },
    },
    allTime: {
      turns: allTime.turns,
      inputTokens: allTime.inputTokens,
      cacheReadTokens: allTime.cacheReadTokens,
      outputTokens: allTime.outputTokens,
      billableTokens: allTime.billableTokens,
      totalTokens: allTime.totalTokens,
    },
    daily7d: dailyOrder,
    byModel7d,
  };
}

export function buildCockpitSnapshot({
  dataDir,
  brainRoots = getDefaultBrainRoots(),
  conversationId = null,
  contextLimitOverride = null,
  nowMs = Date.now(),
} = {}) {
  const modeState = getModeState(dataDir);
  const quotaConfig = getQuotaConfig(dataDir);
  const uiPrefs = getUiPrefs(dataDir);
  const activeSession = getActiveSession(dataDir);
  const sessionsIndex = getSessionsIndex(dataDir);
  const hookTelemetry = readTelemetry(dataDir);
  const conversations = discoverConversations({ brainRoots, activeSession });
  const dbSummaries = readConversationSummaries(brainRoots);
  const usage = computeUsageSummary({ conversations, quotaConfig, nowMs });

  const resolveMeta = (c) => {
    const dbMeta = dbSummaries.get(c.conversationId) || null;
    const hookMeta = sessionsIndex[c.conversationId] || null;
    const isActive = activeSession?.conversationId === c.conversationId;
    const activeProject =
      isActive && Array.isArray(activeSession?.workspacePaths) && activeSession.workspacePaths.length > 0
        ? extractProjectName(activeSession.workspacePaths[0])
        : "";

    let title = dbMeta?.title || "";
    let projectName = dbMeta?.projectName || hookMeta?.projectName || activeProject || "";
    const agentName = dbMeta?.agentName || "";
    const parentId = dbMeta?.parentConversationId || "";
    const parentTitle = parentId ? dbSummaries.get(parentId)?.title || "" : "";

    // Read compact transcript head when DB record is missing or title is empty
    const head = !dbMeta || (!title && !agentName) ? extractTranscriptHeadMeta(c.transcriptPath) : null;
    if (!title && !agentName && head?.title) title = head.title;
    if (!projectName && head?.projectName) projectName = head.projectName;

    const isSubagent = Boolean(
      agentName ||
        parentId ||
        (dbMeta?.nestingDepth || 0) > 0 ||
        head?.isSubagentTranscript,
    );
    // Sidebar /btw side-questions branch mid-conversation (step_index > 0) and have no project/DB entry
    const isSideQuestion = Boolean(!dbMeta && !projectName && head && head.firstStepIndex > 0);
    const hasProject = Boolean(projectName || dbMeta?.projectId);

    const formatted = formatConversationLabel({
      title,
      projectName,
      agentName,
      parentTitle,
      shortId: c.conversationId.slice(0, 8),
    });

    return {
      title: formatted.title,
      shortTitle: truncateDisplay(formatted.title, 22),
      projectName: formatted.projectName,
      agentName,
      parentTitle,
      isSubagent,
      isSideQuestion,
      hasProject,
      label: formatted.label,
      fullLabel: formatted.fullLabel,
    };
  };

  const metaById = new Map();
  const recentPool = conversations.slice(0, 80);
  for (const c of recentPool) {
    metaById.set(c.conversationId, resolveMeta(c));
  }

  // Filter out subagents and sidebar /btw side-questions; keep project conversations only
  const primaryProjectConversations = recentPool.filter((c) => {
    const m = metaById.get(c.conversationId);
    return m && !m.isSubagent && !m.isSideQuestion && m.hasProject;
  });
  const fallbackConversations = recentPool.filter((c) => {
    const m = metaById.get(c.conversationId);
    return m && !m.isSubagent && !m.isSideQuestion;
  });
  const visibleConversations = (
    primaryProjectConversations.length > 0 ? primaryProjectConversations : fallbackConversations
  ).slice(0, 40);

  let selected = null;
  if (conversationId) {
    selected = conversations.find((c) => c.conversationId === conversationId) || null;
  }
  if (!selected && activeSession?.conversationId) {
    selected =
      visibleConversations.find((c) => c.conversationId === activeSession.conversationId) ||
      conversations.find((c) => c.conversationId === activeSession.conversationId) ||
      null;
  }
  if (!selected && visibleConversations.length > 0) {
    selected = visibleConversations[0];
  }
  if (!selected && conversations.length > 0) {
    selected = conversations[0];
  }
  if (selected && !metaById.has(selected.conversationId)) {
    metaById.set(selected.conversationId, resolveMeta(selected));
  }

  let metrics = null;
  if (selected) {
    metrics = parseTranscriptFile(selected.transcriptPath, {
      hookTelemetry,
      conversationId: selected.conversationId,
      contextLimitOverride,
      summaryMeta: metaById.get(selected.conversationId) || null,
    });
  }

  const projectMap = new Map();
  const conversationList = visibleConversations.map((c) => {
    const meta = metaById.get(c.conversationId);
    const isActive = activeSession?.conversationId === c.conversationId;
    if (meta.projectName) {
      const prev = projectMap.get(meta.projectName) || {
        name: meta.projectName,
        count: 0,
        hasActive: false,
        latestMtimeMs: 0,
      };
      prev.count += 1;
      if (isActive) prev.hasActive = true;
      if (c.mtimeMs > prev.latestMtimeMs) prev.latestMtimeMs = c.mtimeMs;
      projectMap.set(meta.projectName, prev);
    }
    return {
      conversationId: c.conversationId,
      shortId: c.conversationId.slice(0, 8),
      title: meta.title,
      shortTitle: meta.shortTitle,
      projectName: meta.projectName,
      isSubagent: meta.isSubagent,
      label: meta.label,
      fullLabel: meta.fullLabel,
      updatedAt: new Date(c.mtimeMs).toISOString(),
      sizeKB: Math.round(c.sizeBytes / 1024),
      isActive,
    };
  });

  const projects = Array.from(projectMap.values())
    .sort((a, b) => Number(b.hasActive) - Number(a.hasActive) || b.latestMtimeMs - a.latestMtimeMs)
    .map(({ name, count, hasActive }) => ({ name, count, hasActive }));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    mode: modeState.mode,
    modeUpdatedAt: modeState.updatedAt,
    modeDescriptions: MODE_DESCRIPTIONS,
    activeConversationId: selected?.conversationId || null,
    projects,
    conversations: conversationList,
    metrics,
    usage,
    uiPrefs,
  };
}
