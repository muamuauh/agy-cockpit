import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCockpitSnapshot,
  computeUsageSummary,
  formatConversationLabel,
  inferContextLimit,
  parseTranscriptFile,
} from "../src/server/telemetry.mjs";
import { appendTelemetry, setActiveSession, setModeState, upsertSessionMeta } from "../src/shared/state.mjs";

test("inferContextLimit matches Gemini and Claude models", () => {
  assert.equal(inferContextLimit("gemini-4-neon-high"), 1_000_000);
  assert.equal(inferContextLimit("claude-sonnet-4-5"), 200_000);
  assert.equal(inferContextLimit("claude-opus-5-5[1M]"), 1_000_000);
  assert.equal(inferContextLimit("gemini-4-neon-high", 250_000), 250_000);
});

test("parseTranscriptFile computes exact context, cache hit, hook latency and transcript fallback", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cockpit-tel-"));
  const transcriptPath = path.join(tmpDir, "transcript.jsonl");
  const lines = [
    JSON.stringify({
      step_index: "0",
      type: "USER_INPUT",
      created_at: "2026-11-24T10:00:00Z",
      content: "<USER_REQUEST>\n测试上下文与延迟统计\n</USER_REQUEST>",
    }),
    JSON.stringify({
      step_index: "1",
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-24T10:00:00Z",
      model: "gemini-4-neon-high",
      input_tokens: "10000",
      cache_read_tokens: "0",
      output_tokens: "400",
      tool_calls: [{ name: "read_file" }],
    }),
    JSON.stringify({
      step_index: "2",
      type: "GENERIC",
      created_at: "2026-11-24T10:00:08Z",
      content: "tool result",
    }),
    JSON.stringify({
      step_index: "3",
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-24T10:00:10Z",
      model: "gemini-4-neon-high",
      input_tokens: "2000",
      cache_read_tokens: "98000",
      output_tokens: "600",
      tool_calls: [],
    }),
    '{"broken_partial_line": true',
  ];
  fs.writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8");

  const hookStartMs = Date.parse("2026-11-24T10:00:10Z") + 150;
  const parsed = parseTranscriptFile(transcriptPath, {
    conversationId: "conv-123",
    hookTelemetry: [
      {
        conversationId: "conv-123",
        startedAtMs: hookStartMs,
        ts: hookStartMs + 5000,
        durationMs: 5000,
      },
    ],
  });

  assert.equal(parsed.title, "测试上下文与延迟统计");
  assert.equal(parsed.model, "gemini-4-neon-high");
  assert.equal(parsed.context.usedTokens, 100_000);
  assert.equal(parsed.context.usedPct, 10);
  assert.equal(parsed.context.cacheHitPct, 98);
  assert.ok(parsed.context.breakdown);
  assert.equal(parsed.context.breakdown.freeTokens, 900_000);
  assert.equal(parsed.context.breakdown.segments.length, 4);
  const segSum = parsed.context.breakdown.segments.reduce((s, item) => s + item.tokens, 0);
  assert.equal(segSum, 100_000);
  assert.equal(parsed.context.breakdown.compactionCount, 0);
  assert.equal(parsed.context.breakdown.topTools[0].name, "read_file");
  assert.equal(parsed.totals.turns, 2);
  assert.equal(parsed.totals.toolCalls, 1);
  assert.equal(parsed.performance.latestLatencyMs, 5000);
  assert.equal(parsed.performance.latestLatencySource, "hook");
  assert.equal(parsed.performance.latestSpeedTokPerSec, 120);
  assert.equal(parsed.performance.hookMeasuredTurns, 1);
  assert.equal(parsed.performance.measuredTurns, 2);
  assert.equal(parsed.recentTurns[0].latencyMs, 8000);
  assert.equal(parsed.recentTurns[0].latencySource, "transcript");
  assert.equal(parsed.recentTurns[0].speedTokPerSec, 50);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("buildCockpitSnapshot discovers conversations and reflects saved mode", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cockpit-snap-"));
  const dataDir = path.join(tmpDir, "data");
  const brainRoot = path.join(tmpDir, "brain");
  const tDir = path.join(brainRoot, "11111111-2222-3333-4444-555555555555", ".system_generated", "logs");
  fs.mkdirSync(tDir, { recursive: true });
  const tFile = path.join(tDir, "transcript.jsonl");
  fs.writeFileSync(
    tFile,
    JSON.stringify({
      step_index: "1",
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-24T11:00:00Z",
      model: "gemini-4-neon-high",
      input_tokens: "5000",
      cache_read_tokens: "45000",
      output_tokens: "250",
      tool_calls: [],
    }) + "\n",
    "utf8",
  );

  setModeState(dataDir, "plan");
  setActiveSession(dataDir, {
    conversationId: "11111111-2222-3333-4444-555555555555",
    transcriptPath: tFile,
    workspacePaths: ["e:\\codes\\agy-cockpit"],
  });
  upsertSessionMeta(dataDir, {
    conversationId: "11111111-2222-3333-4444-555555555555",
    transcriptPath: tFile,
    workspacePaths: ["e:\\codes\\agy-cockpit"],
  });
  appendTelemetry(dataDir, {
    conversationId: "11111111-2222-3333-4444-555555555555",
    startedAtMs: Date.parse("2026-11-24T11:00:00Z"),
    ts: Date.parse("2026-11-24T11:00:00Z") + 2500,
    durationMs: 2500,
  });

  const snap = buildCockpitSnapshot({ dataDir, brainRoots: [brainRoot] });
  assert.equal(snap.mode, "plan");
  assert.equal(snap.conversations.length, 1);
  assert.equal(snap.conversations[0].projectName, "agy-cockpit");
  assert.match(snap.conversations[0].label, /\(agy-cockpit\)$/);
  assert.equal(snap.projects.length, 1);
  assert.equal(snap.projects[0].name, "agy-cockpit");
  assert.equal(snap.projects[0].count, 1);
  assert.equal(snap.metrics.context.usedTokens, 50_000);
  assert.equal(snap.metrics.performance.latestSpeedTokPerSec, 100);

  // Add a subagent conversation and a /btw side-question; verify both are filtered from selector
  // while their tokens are STILL counted in total usage summary
  const subDir = path.join(brainRoot, "subagent-1", ".system_generated", "logs");
  const btwDir = path.join(brainRoot, "btw-question-1", ".system_generated", "logs");
  fs.mkdirSync(subDir, { recursive: true });
  fs.mkdirSync(btwDir, { recursive: true });
  fs.writeFileSync(
    path.join(subDir, "transcript.jsonl"),
    [
      JSON.stringify({ step_index: 0, source: "SYSTEM", type: "SYSTEM_MESSAGE", content: "subagent task" }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: new Date().toISOString(),
        model: "gemini-4-neon-high",
        input_tokens: 1000,
        cache_read_tokens: 0,
        output_tokens: 200,
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(btwDir, "transcript.jsonl"),
    [
      JSON.stringify({ step_index: 196, source: "USER_EXPLICIT", type: "USER_INPUT", content: "side btw question" }),
      JSON.stringify({
        step_index: 197,
        type: "PLANNER_RESPONSE",
        created_at: new Date().toISOString(),
        model: "gemini-4-neon-high",
        input_tokens: 2000,
        cache_read_tokens: 0,
        output_tokens: 300,
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const snap2 = buildCockpitSnapshot({ dataDir, brainRoots: [brainRoot] });
  assert.equal(snap2.conversations.length, 1);
  assert.equal(snap2.conversations[0].conversationId, "11111111-2222-3333-4444-555555555555");
  assert.equal(snap2.usage.conversationsScanned, 3);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("formatConversationLabel builds title (project) with ellipsis for long titles", () => {
  const short = formatConversationLabel({
    title: "main",
    projectName: "agy-cockpit",
    shortId: "a028169c",
  });
  assert.equal(short.label, "main (agy-cockpit)");
  assert.equal(short.fullLabel, "main (agy-cockpit)");

  const longEn = formatConversationLabel({
    title: "AI Configuration And Skills Review",
    projectName: "ide_export",
    shortId: "ba89627f",
  });
  assert.equal(longEn.fullLabel, "AI Configuration And Skills Review (ide_export)");
  assert.ok(longEn.label.includes("…"));
  assert.ok(longEn.label.endsWith("(ide_export)"));

  const sub = formatConversationLabel({
    title: "",
    agentName: "research",
    parentTitle: "main",
    projectName: "agy-cockpit",
    shortId: "e65dd0b7",
  });
  assert.equal(sub.label, "[research] main (agy-cockpit)");
});

test("parseTranscriptFile avoids tool-wait inflation on tool-calling turns", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cockpit-toolwait-"));
  const transcriptPath = path.join(tmpDir, "transcript.jsonl");
  const lines = [
    JSON.stringify({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-24T10:00:00Z",
      model: "gemini-4-neon-high",
      input_tokens: 10000,
      cache_read_tokens: 0,
      output_tokens: 500,
      tool_calls: [{ name: "run_command" }],
    }),
    JSON.stringify({
      step_index: 2,
      type: "GENERIC",
      created_at: "2026-11-24T10:00:05Z",
      content: "tool finished after 60s wait",
    }),
  ];
  fs.writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8");

  const startMs = Date.parse("2026-11-24T10:00:00Z");
  const parsed = parseTranscriptFile(transcriptPath, {
    conversationId: "conv-toolwait",
    hookTelemetry: [
      {
        conversationId: "conv-toolwait",
        startedAtMs: startMs,
        ts: startMs + 65000,
        durationMs: 65000,
      },
    ],
  });

  // Should keep 5s pure-model transcript delta (100 tok/s) rather than 65s PostInvocation wait
  assert.equal(parsed.performance.latestLatencyMs, 5000);
  assert.equal(parsed.performance.latestLatencySource, "transcript");
  assert.equal(parsed.performance.latestSpeedTokPerSec, 100);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("parseTranscriptFile uses last tool call start for streamed parallel multi-tool turns", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cockpit-multitool-"));
  const transcriptPath = path.join(tmpDir, "transcript.jsonl");
  const lines = [
    JSON.stringify({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-25T10:00:00Z",
      model: "gemini-4-neon-high",
      input_tokens: 10000,
      cache_read_tokens: 80000,
      output_tokens: 6000,
      tool_calls: [{ name: "edit_file" }, { name: "edit_file" }, { name: "edit_file" }],
    }),
    // 1st tool dispatched eagerly at +6s while model is still streaming remaining tool calls
    JSON.stringify({ step_index: 2, type: "GENERIC", created_at: "2026-11-25T10:00:06Z", content: "ok 1" }),
    JSON.stringify({ step_index: 3, type: "GENERIC", created_at: "2026-11-25T10:00:25Z", content: "ok 2" }),
    // Last (3rd) tool dispatched at +50s -> true model streaming speed is 6000 / 50 = 120 tok/s (not 1000 tok/s!)
    JSON.stringify({ step_index: 4, type: "GENERIC", created_at: "2026-11-25T10:00:50Z", content: "ok 3" }),
    // Non-tool final answer followed by next turn's PreInvocation SYSTEM_MESSAGE 2 minutes later
    JSON.stringify({
      step_index: 5,
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-25T10:01:00Z",
      model: "gemini-4-neon-high",
      input_tokens: 2000,
      cache_read_tokens: 90000,
      output_tokens: 500,
      tool_calls: [],
    }),
    JSON.stringify({ step_index: 6, type: "SYSTEM_MESSAGE", created_at: "2026-11-25T10:03:00Z", content: "next turn hook" }),
    JSON.stringify({ step_index: 7, type: "USER_INPUT", created_at: "2026-11-25T10:03:00Z", content: "next question" }),
  ];
  fs.writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8");

  const parsed = parseTranscriptFile(transcriptPath, { conversationId: "conv-multitool" });
  assert.equal(parsed.recentTurns[0].latencyMs, 50_000);
  assert.equal(parsed.recentTurns[0].speedTokPerSec, 120);
  // Non-tool turn without hook telemetry should not absorb next turn's SYSTEM_MESSAGE wait
  assert.equal(parsed.recentTurns[1].latencyMs, null);
  assert.equal(parsed.recentTurns[1].speedTokPerSec, null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("computeUsageSummary aggregates 5h, 7d, and all-time tokens with reset timers and model breakdown", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cockpit-usage-"));
  const nowMs = Date.parse("2026-11-24T12:00:00Z");

  const t1 = path.join(tmpDir, "conv1.jsonl");
  fs.writeFileSync(
    t1,
    [
      // 2 hours ago (in 5h + 7d + allTime)
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        created_at: new Date(nowMs - 2 * 3600_000).toISOString(),
        model: "gemini-4-neon-high",
        input_tokens: 100_000,
        cache_read_tokens: 400_000,
        output_tokens: 50_000,
      }),
      // 2 days ago (in 7d + allTime, outside 5h)
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        created_at: new Date(nowMs - 2 * 86_400_000).toISOString(),
        model: "gemini-3.8-flash-high",
        input_tokens: 200_000,
        cache_read_tokens: 100_000,
        output_tokens: 50_000,
      }),
      // 10 days ago (only in allTime)
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        created_at: new Date(nowMs - 10 * 86_400_000).toISOString(),
        model: "gemini-4-neon-high",
        input_tokens: 500_000,
        cache_read_tokens: 0,
        output_tokens: 100_000,
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  const st1 = fs.statSync(t1);

  const summary = computeUsageSummary({
    conversations: [{ conversationId: "c1", transcriptPath: t1, mtimeMs: st1.mtimeMs, sizeBytes: st1.size }],
    quotaConfig: { metric: "billable", fiveHourLimit: 1_000_000, weeklyLimit: 1_000_000 },
    nowMs,
  });

  // 5h window: 100k + 50k = 150k billable (15% used, 85% left), resets in 3h
  assert.equal(summary.fiveHour.turns, 1);
  assert.equal(summary.fiveHour.billableTokens, 150_000);
  assert.equal(summary.fiveHour.totalTokens, 550_000);
  assert.equal(summary.fiveHour.usedPct, 15);
  assert.equal(summary.fiveHour.remainingPct, 85);
  assert.equal(summary.fiveHour.nextResetInMs, 3 * 3600_000);

  // 7d window: 150k + 250k = 400k billable (40% used, 60% left), resets in 5d
  assert.equal(summary.weekly.turns, 2);
  assert.equal(summary.weekly.billableTokens, 400_000);
  assert.equal(summary.weekly.usedPct, 40);
  assert.equal(summary.weekly.remainingPct, 60);
  assert.equal(summary.weekly.nextResetInMs, 5 * 86_400_000);
  assert.equal(summary.pools.gemini.weekly.turns, 2);
  assert.equal(summary.pools.claude_gpt.weekly.turns, 0);

  // All-time: 400k + 600k = 1M billable
  assert.equal(summary.allTime.turns, 3);
  assert.equal(summary.allTime.billableTokens, 1_000_000);
  assert.equal(summary.daily7d.length, 7);
  assert.equal(summary.byModel7d.length, 2);
  assert.equal(summary.byModel7d[0].model, "gemini-3.8-flash-high");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
