import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setModeState, readTelemetry } from "../src/shared/state.mjs";

const HOOK_SCRIPT = path.resolve("dist", "plugin", "bin", "hook.mjs");

function runHook(payload, dataDir) {
  const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, PLUGIN_DATA: dataDir },
  });
  assert.equal(res.status, 0, `Hook failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

test("bundled hook.mjs enforces auto, plan, ask, and turbo modes and records latency", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cockpit-hook-"));

  // Auto mode -> explicit decision: "allow" (PreToolUse is fail-closed in Antigravity)
  let out = runHook(
    { hookEventName: "PreToolUse", toolCall: { name: "edit_file" } },
    dataDir,
  );
  assert.equal(out.decision, "allow");

  // Plan mode -> PreInvocation injects plan systemMessage + PreToolUse denies write/exec
  setModeState(dataDir, "plan");
  out = runHook(
    {
      hookEventName: "PreInvocation",
      conversationId: "conv-hook-1",
      transcriptPath: "C:/fake/transcript.jsonl",
      modelName: "gemini-4-neon-high",
      workspacePaths: ["e:\\codes\\agy-cockpit"],
      invocationNum: 1,
    },
    dataDir,
  );
  assert.ok(Array.isArray(out.injectSteps) && out.injectSteps.length === 1);
  assert.match(out.injectSteps[0].systemMessage.systemMessage, /Plan 模式/);

  out = runHook(
    { hookEventName: "PreToolUse", toolCall: { name: "run_command" } },
    dataDir,
  );
  assert.equal(out.decision, "deny");

  // Non-mutating tool returns explicit allow even in Plan mode
  out = runHook(
    { hookEventName: "PreToolUse", toolCall: { name: "read_file" } },
    dataDir,
  );
  assert.equal(out.decision, "allow");

  // Wait 40ms then fire PostInvocation to verify telemetry timing
  await new Promise((r) => setTimeout(r, 40));
  out = runHook(
    { hookEventName: "PostInvocation", conversationId: "conv-hook-1", invocationNum: 1 },
    dataDir,
  );
  assert.deepEqual(out, {});
  const telemetry = readTelemetry(dataDir);
  assert.equal(telemetry.length, 1);
  assert.ok(telemetry[0].durationMs >= 20);

  // Ask mode -> force_ask
  setModeState(dataDir, "ask");
  out = runHook(
    { hookEventName: "PreToolUse", toolCall: { name: "write_file" } },
    dataDir,
  );
  assert.equal(out.decision, "force_ask");

  // Turbo mode -> PreInvocation injects turbo directive + PreToolUse allows mutating & MCP/web tools
  setModeState(dataDir, "turbo");
  out = runHook(
    {
      hookEventName: "PreInvocation",
      conversationId: "conv-hook-1",
      modelName: "gemini-4-neon-high",
      invocationNum: 2,
    },
    dataDir,
  );
  assert.ok(Array.isArray(out.injectSteps) && out.injectSteps.length === 1);
  assert.match(out.injectSteps[0].systemMessage.systemMessage, /Turbo 模式/);

  out = runHook(
    { hookEventName: "PreToolUse", toolCall: { name: "call_mcp_tool" } },
    dataDir,
  );
  assert.equal(out.decision, "allow");
  assert.match(out.reason, /Turbo 模式/);

  fs.rmSync(dataDir, { recursive: true, force: true });
});
