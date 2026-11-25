import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VALID_MODES = ["normal", "plan", "ask", "turbo"];
export const VALID_QUOTA_METRICS = ["billable", "total"];

export const DEFAULT_QUOTAS = {
  metric: "billable",
  billable: {
    fiveHourLimit: 8_000_000,
    weeklyLimit: 20_000_000,
  },
  total: {
    fiveHourLimit: 65_000_000,
    weeklyLimit: 160_000_000,
  },
};

export const MODE_DESCRIPTIONS = {
  normal: {
    label: "Normal",
    badge: "默认策略",
    summary: "Hook 放行写入与命令（交由 Antigravity 原生安全预设与沙箱把关），仅采集延迟与会话遥测。",
  },
  plan: {
    label: "Plan",
    badge: "只读规划",
    summary: "注入只读规划提示，并由 PreToolUse Hook 硬拦截 edit_file / write_file / run_command。",
  },
  ask: {
    label: "Ask",
    badge: "步步确认",
    summary: "每次调用 edit_file / write_file / run_command 前均通过 Hook 强制弹窗确认。",
  },
  turbo: {
    label: "Turbo",
    badge: "极速自主",
    summary: "放行写入、命令、MCP 与搜索工具，并注入批量连续推进指令（仍受宿主原生预设、沙箱与高危红线保护）。",
  },
};

export function extractProjectName(rawPathOrUri) {
  if (!rawPathOrUri || typeof rawPathOrUri !== "string") return "";
  let s = rawPathOrUri.trim();
  if (!s) return "";
  if (s.startsWith("file://")) {
    try {
      s = decodeURIComponent(s.replace(/^file:\/+/i, ""));
    } catch {
      s = s.replace(/^file:\/+/i, "");
    }
  }
  s = s.replace(/[\\/]+$/, "");
  const parts = s.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

export function resolveDataDir(explicitDir) {
  const raw =
    explicitDir ||
    process.env.PLUGIN_DATA ||
    path.join(os.homedir(), ".gemini", "config", "plugin-data", "agy-cockpit");
  return path.resolve(raw);
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const payload = JSON.stringify(data, null, 2) + "\n";
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, payload, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    fs.writeFileSync(filePath, payload, "utf8");
  }
}

export function getModeState(dataDir) {
  const filePath = path.join(dataDir, "mode.json");
  const saved = readJsonSafe(filePath, null);
  const mode = saved && VALID_MODES.includes(saved.mode) ? saved.mode : "normal";
  return {
    mode,
    updatedAt: saved?.updatedAt || null,
    meta: MODE_DESCRIPTIONS[mode],
  };
}

function posInt(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
}

export function getQuotaConfig(dataDir) {
  const filePath = path.join(dataDir, "quotas.json");
  const saved = readJsonSafe(filePath, null);
  const metric =
    saved && VALID_QUOTA_METRICS.includes(saved.metric) ? saved.metric : DEFAULT_QUOTAS.metric;

  const billable = {
    fiveHourLimit: posInt(saved?.billable?.fiveHourLimit, DEFAULT_QUOTAS.billable.fiveHourLimit),
    weeklyLimit: posInt(saved?.billable?.weeklyLimit, DEFAULT_QUOTAS.billable.weeklyLimit),
  };
  const total = {
    fiveHourLimit: posInt(saved?.total?.fiveHourLimit, DEFAULT_QUOTAS.total.fiveHourLimit),
    weeklyLimit: posInt(saved?.total?.weeklyLimit, DEFAULT_QUOTAS.total.weeklyLimit),
  };
  const active = metric === "total" ? total : billable;

  return {
    metric,
    billable,
    total,
    fiveHourLimit: active.fiveHourLimit,
    weeklyLimit: active.weeklyLimit,
    updatedAt: saved?.updatedAt || null,
  };
}

export function setQuotaConfig(dataDir, patch = {}) {
  const prev = getQuotaConfig(dataDir);
  const metric =
    typeof patch.metric === "string" && VALID_QUOTA_METRICS.includes(patch.metric)
      ? patch.metric
      : prev.metric;

  const billable = { ...prev.billable };
  const total = { ...prev.total };
  const target = metric === "total" ? total : billable;

  if (patch.fiveHourLimit !== undefined) {
    target.fiveHourLimit = posInt(patch.fiveHourLimit, target.fiveHourLimit);
  }
  if (patch.weeklyLimit !== undefined) {
    target.weeklyLimit = posInt(patch.weeklyLimit, target.weeklyLimit);
  }

  const next = {
    metric,
    billable,
    total,
    fiveHourLimit: target.fiveHourLimit,
    weeklyLimit: target.weeklyLimit,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(dataDir, "quotas.json"), next);
  return next;
}

export function setModeState(dataDir, mode) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid mode "${mode}". Allowed: ${VALID_MODES.join(", ")}`);
  }
  const next = {
    mode,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(dataDir, "mode.json"), next);
  return {
    ...next,
    meta: MODE_DESCRIPTIONS[mode],
  };
}

export function getActiveSession(dataDir) {
  return readJsonSafe(path.join(dataDir, "active_session.json"), null);
}

export function setActiveSession(dataDir, info) {
  const prev = getActiveSession(dataDir) || {};
  const merged = {
    ...prev,
    ...info,
    updatedAtMs: Date.now(),
  };
  writeJsonAtomic(path.join(dataDir, "active_session.json"), merged);
  return merged;
}

export function getSessionsIndex(dataDir) {
  const data = readJsonSafe(path.join(dataDir, "sessions.json"), null);
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

export function upsertSessionMeta(dataDir, info, maxEntries = 60) {
  const id = info?.conversationId;
  if (!id) return;
  const index = getSessionsIndex(dataDir);
  const prev = index[id] || {};
  const workspacePaths = Array.isArray(info.workspacePaths) && info.workspacePaths.length > 0
    ? info.workspacePaths
    : prev.workspacePaths || null;
  const projectName =
    (workspacePaths && workspacePaths.length > 0 ? extractProjectName(workspacePaths[0]) : "") ||
    info.projectName ||
    prev.projectName ||
    "";

  index[id] = {
    ...prev,
    conversationId: id,
    transcriptPath: info.transcriptPath || prev.transcriptPath || null,
    modelName: info.modelName || prev.modelName || null,
    workspacePaths,
    projectName,
    updatedAtMs: Date.now(),
  };

  const keys = Object.keys(index);
  if (keys.length > maxEntries) {
    keys.sort((a, b) => (index[b]?.updatedAtMs || 0) - (index[a]?.updatedAtMs || 0));
    for (const staleKey of keys.slice(maxEntries)) {
      delete index[staleKey];
    }
  }
  writeJsonAtomic(path.join(dataDir, "sessions.json"), index);
}

export function appendTelemetry(dataDir, entry, maxEntries = 500) {
  ensureDir(dataDir);
  const filePath = path.join(dataDir, "telemetry.jsonl");
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 256 * 1024) {
      const lines = fs
        .readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);
      if (lines.length > maxEntries) {
        const trimmed = lines.slice(-maxEntries).join("\n") + "\n";
        fs.writeFileSync(filePath, trimmed, "utf8");
      }
    }
  } catch {
    // non-fatal trimming failure
  }
}

export function readTelemetry(dataDir) {
  const filePath = path.join(dataDir, "telemetry.jsonl");
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const items = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        items.push(JSON.parse(trimmed));
      } catch {
        // skip partial line
      }
    }
    return items;
  } catch {
    return [];
  }
}
