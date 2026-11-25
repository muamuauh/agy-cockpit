import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  resolveDataDir,
  setModeState,
  setQuotaConfig,
  setUiPrefs,
  VALID_CARDS,
  VALID_MODES,
  VALID_QUOTA_METRICS,
} from "../shared/state.mjs";
import { buildCockpitSnapshot } from "./telemetry.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const APP_URI = "ui://agy-cockpit/dashboard.html";
export const APP_MIME = "text/html;profile=mcp-app";

function parseArgs(argv) {
  const opts = { dataDir: null, htmlPath: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data-dir" && argv[i + 1]) {
      opts.dataDir = argv[++i];
    } else if (argv[i].startsWith("--data-dir=")) {
      opts.dataDir = argv[i].slice("--data-dir=".length);
    } else if (argv[i] === "--html" && argv[i + 1]) {
      opts.htmlPath = argv[++i];
    }
  }
  return opts;
}

function resolveHtmlPath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.AGY_COCKPIT_HTML,
    path.resolve(__dirname, "..", "ui", "dashboard.html"),
    path.resolve(__dirname, "..", "..", "dist", "plugin", "ui", "dashboard.html"),
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

function formatTokens(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function summarizeSnapshotText(snapshot) {
  const m = snapshot.metrics;
  const u = snapshot.usage;
  const usageTag = u
    ? ` | 5h 剩余 ${u.fiveHour.remainingPct}% (${formatTokens(u.fiveHour.usedTokens)}/${formatTokens(u.fiveHour.limitTokens)}) · 7d 剩余 ${u.weekly.remainingPct}% (${formatTokens(u.weekly.usedTokens)}/${formatTokens(u.weekly.limitTokens)})`
    : "";
  if (!m) {
    return `Agy Cockpit | 模式: ${snapshot.mode.toUpperCase()}${usageTag} | 暂未发现可解析的本机会话 transcript.jsonl`;
  }
  const lat = m.performance.latestLatencyMs !== null ? `${(m.performance.latestLatencyMs / 1000).toFixed(2)}s` : "N/A";
  const spd = m.performance.latestSpeedTokPerSec !== null ? `${m.performance.latestSpeedTokPerSec} tok/s` : "N/A";
  const sessionTag = m.displayLabel ? ` | 会话: ${m.displayLabel}` : "";
  return [
    `Agy Cockpit (${m.model})${sessionTag}`,
    `模式: ${snapshot.mode.toUpperCase()}`,
    `上下文: ${formatTokens(m.context.usedTokens)} / ${formatTokens(m.context.limitTokens)} (${m.context.usedPct}%)`,
    `缓存命中: ${m.context.cacheHitPct}%`,
    `最近耗时/速度: ${lat} · ${spd}`,
    `累计轮次/工具: ${m.totals.turns} 轮 / ${m.totals.toolCalls} 次工具`,
  ].join(" | ") + usageTag;
}

export function createCockpitServer({ dataDir, htmlPath }) {
  const resolvedDataDir = resolveDataDir(dataDir);
  const server = new Server(
    { name: "agy-cockpit", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: APP_URI,
        name: "Agy Cockpit Dashboard",
        description: "Interactive Antigravity context, latency/speed telemetry, and mode control panel.",
        mimeType: APP_MIME,
        _meta: {
          ui: {
            prefersBorder: false,
          },
        },
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri !== APP_URI) {
      throw new Error(`Unknown resource URI: ${req.params.uri}`);
    }
    const targetPath = resolveHtmlPath(htmlPath);
    if (!targetPath || !fs.existsSync(targetPath)) {
      throw new Error(`Dashboard HTML not found at ${targetPath}`);
    }
    const html = fs.readFileSync(targetPath, "utf8");
    return {
      contents: [
        {
          uri: APP_URI,
          mimeType: APP_MIME,
          text: html,
          _meta: {
            ui: {
              prefersBorder: false,
            },
          },
        },
      ],
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "open_cockpit",
        title: "Agy Cockpit",
        description:
          "Open the Agy Cockpit monitoring dashboard showing real-time context window usage, cache hit rate, turn latency/speed telemetry, 5h/7d token quota monitor, and execution mode switcher (Auto/Plan/Ask/Turbo).",
        inputSchema: {
          type: "object",
          properties: {
            conversationId: {
              type: "string",
              description: "Optional conversation ID to inspect. Defaults to the latest active conversation.",
            },
            contextLimit: {
              type: "number",
              description: "Optional manual context window token limit override (e.g. 200000 or 1000000).",
            },
          },
        },
        _meta: {
          ui: {
            resourceUri: APP_URI,
          },
          "com.google.antigravity/ui": {
            entrypoints: [
              { type: "aux_pane", title: "Agy Cockpit" },
              { type: "global", title: "Agy Cockpit" },
            ],
          },
        },
      },
      {
        name: "cockpit_get_snapshot",
        title: "Refresh Cockpit Telemetry",
        description: "App-only tool to fetch the latest context window, latency, speed, and mode snapshot.",
        inputSchema: {
          type: "object",
          properties: {
            conversationId: { type: "string" },
            contextLimit: { type: "number" },
          },
        },
        _meta: {
          ui: {
            visibility: ["app"],
          },
        },
      },
      {
        name: "cockpit_set_mode",
        title: "Set Execution Mode",
        description: "App-only tool to switch Agy Cockpit hook mode between auto, plan, ask, and turbo.",
        inputSchema: {
          type: "object",
          required: ["mode"],
          properties: {
            mode: {
              type: "string",
              enum: VALID_MODES,
            },
            conversationId: { type: "string" },
            contextLimit: { type: "number" },
          },
        },
        _meta: {
          ui: {
            visibility: ["app"],
          },
        },
      },
      {
        name: "cockpit_set_quotas",
        title: "Update Local Token Quota Budgets",
        description:
          "App-only tool to configure 5-hour rolling and 7-day weekly token quota budgets and metric mode (billable vs total).",
        inputSchema: {
          type: "object",
          properties: {
            metric: {
              type: "string",
              enum: VALID_QUOTA_METRICS,
            },
            fiveHourLimit: { type: "number" },
            weeklyLimit: { type: "number" },
            conversationId: { type: "string" },
            contextLimit: { type: "number" },
          },
        },
        _meta: {
          ui: {
            visibility: ["app"],
          },
        },
      },
      {
        name: "cockpit_set_ui_prefs",
        title: "Update Dashboard UI Preferences",
        description: "App-only tool to persist collapsed dashboard cards.",
        inputSchema: {
          type: "object",
          properties: {
            collapsedCards: {
              type: "array",
              items: {
                type: "string",
                enum: VALID_CARDS,
              },
            },
          },
        },
        _meta: {
          ui: {
            visibility: ["app"],
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments || {};

    if (name === "open_cockpit" || name === "cockpit_get_snapshot") {
      const snapshot = buildCockpitSnapshot({
        dataDir: resolvedDataDir,
        conversationId: typeof args.conversationId === "string" ? args.conversationId : null,
        contextLimitOverride: typeof args.contextLimit === "number" ? args.contextLimit : null,
      });
      return {
        content: [{ type: "text", text: summarizeSnapshotText(snapshot) }],
        structuredContent: snapshot,
      };
    }

    if (name === "cockpit_set_mode") {
      const mode = typeof args.mode === "string" ? args.mode.toLowerCase() : "";
      if (!VALID_MODES.includes(mode)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid mode: ${mode}. Expected one of ${VALID_MODES.join(", ")}` }],
        };
      }
      setModeState(resolvedDataDir, mode);
      const snapshot = buildCockpitSnapshot({
        dataDir: resolvedDataDir,
        conversationId: typeof args.conversationId === "string" ? args.conversationId : null,
        contextLimitOverride: typeof args.contextLimit === "number" ? args.contextLimit : null,
      });
      return {
        content: [{ type: "text", text: `Mode switched to ${mode.toUpperCase()}. ${summarizeSnapshotText(snapshot)}` }],
        structuredContent: snapshot,
      };
    }

    if (name === "cockpit_set_quotas") {
      const patch = {};
      if (typeof args.metric === "string") {
        if (!VALID_QUOTA_METRICS.includes(args.metric)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Invalid metric: ${args.metric}. Expected billable or total.` }],
          };
        }
        patch.metric = args.metric;
      }
      if (args.fiveHourLimit !== undefined) {
        const n = Number(args.fiveHourLimit);
        if (!Number.isFinite(n) || n <= 0) {
          return {
            isError: true,
            content: [{ type: "text", text: "Invalid fiveHourLimit: must be a positive number." }],
          };
        }
        patch.fiveHourLimit = n;
      }
      if (args.weeklyLimit !== undefined) {
        const n = Number(args.weeklyLimit);
        if (!Number.isFinite(n) || n <= 0) {
          return {
            isError: true,
            content: [{ type: "text", text: "Invalid weeklyLimit: must be a positive number." }],
          };
        }
        patch.weeklyLimit = n;
      }
      setQuotaConfig(resolvedDataDir, patch);
      const snapshot = buildCockpitSnapshot({
        dataDir: resolvedDataDir,
        conversationId: typeof args.conversationId === "string" ? args.conversationId : null,
        contextLimitOverride: typeof args.contextLimit === "number" ? args.contextLimit : null,
      });
      return {
        content: [{ type: "text", text: `Quotas updated. ${summarizeSnapshotText(snapshot)}` }],
        structuredContent: snapshot,
      };
    }

    if (name === "cockpit_set_ui_prefs") {
      if (!Array.isArray(args.collapsedCards)) {
        return {
          isError: true,
          content: [{ type: "text", text: "Invalid collapsedCards: expected an array of card ids." }],
        };
      }
      const uiPrefs = setUiPrefs(resolvedDataDir, { collapsedCards: args.collapsedCards });
      return {
        content: [{ type: "text", text: `UI prefs updated (${uiPrefs.collapsedCards.length} collapsed).` }],
        structuredContent: { uiPrefs },
      };
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  });

  return server;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const server = createCockpitServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[agy-cockpit] fatal error: ${err?.stack || err}\n`);
  process.exit(1);
});
