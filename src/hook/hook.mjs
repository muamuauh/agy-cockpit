import {
  appendTelemetry,
  getActiveSession,
  getModeState,
  resolveDataDir,
  setActiveSession,
  upsertSessionMeta,
} from "../shared/state.mjs";

const MUTATING_TOOLS = new Set(["edit_file", "write_file", "run_command"]);
const TURBO_TOOLS = new Set(["edit_file", "write_file", "run_command", "call_mcp_tool", "search_web"]);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

export function handleHookPayload(payload, dataDir) {
  const event = payload?.hookEventName || "";
  const conversationId = payload?.conversationId || null;
  const transcriptPath = payload?.transcriptPath || null;
  const modelName = payload?.modelName || null;
  const workspacePaths = Array.isArray(payload?.workspacePaths) ? payload.workspacePaths : null;

  if (event === "SessionStart") {
    if (conversationId || transcriptPath) {
      setActiveSession(dataDir, {
        conversationId,
        transcriptPath,
        modelName,
        workspacePaths,
        inFlightStartMs: null,
      });
      upsertSessionMeta(dataDir, {
        conversationId,
        transcriptPath,
        modelName,
        workspacePaths,
      });
    }
    return {};
  }

  if (event === "PreInvocation") {
    const now = Date.now();
    setActiveSession(dataDir, {
      conversationId,
      transcriptPath,
      modelName,
      workspacePaths,
      invocationNum: payload?.invocationNum ?? null,
      inFlightStartMs: now,
    });
    upsertSessionMeta(dataDir, {
      conversationId,
      transcriptPath,
      modelName,
      workspacePaths,
    });

    const { mode } = getModeState(dataDir);
    if (mode === "plan") {
      return {
        injectSteps: [
          {
            systemMessage: {
              systemMessage:
                "[Agy Cockpit · Plan 模式生效中] 当前处于只读规划模式：请仅阅读分析与制定计划，不要尝试修改文件或运行终端命令（edit_file / write_file / run_command 已被 Hook 拦截）。请先输出清晰方案，待用户在 Agy Cockpit 面板切回 Normal 或 Turbo 模式后再执行改动。",
            },
          },
        ],
      };
    }
    if (mode === "turbo") {
      return {
        injectSteps: [
          {
            systemMessage: {
              systemMessage:
                "[Agy Cockpit · Turbo 模式生效中] 当前处于极速自主推进模式：请尽可能批量并行执行读写、构建与测试步骤，直接一气呵成完成并验证结果，不要为常规代码修改或本地测试中途停下请示（仍须严格遵守高危副作用红线：真实下单、git push、不可逆删除、对外发送及凭据文件不可未经确认操作）。",
            },
          },
        ],
      };
    }
    return {};
  }

  if (event === "PostInvocation" || event === "Stop") {
    const now = Date.now();
    const active = getActiveSession(dataDir);
    if (
      active &&
      typeof active.inFlightStartMs === "number" &&
      (!conversationId || !active.conversationId || active.conversationId === conversationId)
    ) {
      const durationMs = now - active.inFlightStartMs;
      if (durationMs >= 20 && durationMs <= 3_600_000) {
        appendTelemetry(dataDir, {
          ts: now,
          startedAtMs: active.inFlightStartMs,
          durationMs,
          event,
          conversationId: conversationId || active.conversationId || null,
          modelName: modelName || active.modelName || null,
          invocationNum: payload?.invocationNum ?? active.invocationNum ?? null,
        });
      }
      setActiveSession(dataDir, { inFlightStartMs: null });
    }
    return {};
  }

  if (event === "PreToolUse") {
    const toolName = payload?.toolCall?.name || "";
    const { mode } = getModeState(dataDir);
    if (mode === "turbo" && TURBO_TOOLS.has(toolName)) {
      return {
        decision: "allow",
        reason: `Agy Cockpit [Turbo 模式]：已极速放行 ${toolName}。`,
      };
    }
    if (!MUTATING_TOOLS.has(toolName)) {
      return { decision: "allow" };
    }
    if (mode === "plan") {
      return {
        decision: "deny",
        reason: `Agy Cockpit [Plan 模式]：已拦截 ${toolName}。当前处于只读规划模式，请在 Agy Cockpit 面板切换到 Normal / Ask / Turbo 后再执行修改。`,
      };
    }
    if (mode === "ask") {
      return {
        decision: "force_ask",
        reason: `Agy Cockpit [Ask 模式]：执行 ${toolName} 前需要你的确认。`,
      };
    }
    // Antigravity PreToolUse hooks are fail-closed and require an explicit decision.
    // Returning "allow" lets host security preset, sandbox, and workspace boundaries handle normal execution.
    return { decision: "allow" };
  }

  return {};
}

async function main() {
  const dataDir = resolveDataDir();
  const raw = await readStdin();
  if (!raw) {
    process.stdout.write("{}\n");
    return;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write("{}\n");
    return;
  }
  try {
    const result = handleHookPayload(payload, dataDir);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    const fallback = payload?.hookEventName === "PreToolUse" ? { decision: "allow" } : {};
    process.stdout.write(JSON.stringify(fallback) + "\n");
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());

if (isMain || process.env.AGY_COCKPIT_RUN_HOOK === "1") {
  main().catch(() => {
    process.stdout.write("{}\n");
  });
}
