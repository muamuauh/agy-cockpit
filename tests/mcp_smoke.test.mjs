import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("bundled MCP server serves tools, ui:// resource, and switches modes end-to-end", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cockpit-mcp-"));
  const serverPath = path.resolve("dist", "plugin", "bin", "server.mjs");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--data-dir", dataDir],
  });
  const client = new Client({ name: "smoke-test", version: "1.0.0" }, {});
  await client.connect(transport);

  try {
    const toolsRes = await client.listTools();
    const names = toolsRes.tools.map((t) => t.name);
    assert.ok(names.includes("open_cockpit"));
    assert.ok(names.includes("cockpit_get_snapshot"));
    assert.ok(names.includes("cockpit_set_mode"));
    assert.ok(names.includes("cockpit_set_quotas"));
    assert.ok(names.includes("cockpit_set_ui_prefs"));

    const openTool = toolsRes.tools.find((t) => t.name === "open_cockpit");
    assert.equal(openTool._meta?.ui?.resourceUri, "ui://agy-cockpit/dashboard.html");
    assert.equal(openTool._meta?.["com.google.antigravity/ui"]?.entrypoints?.length, 2);

    const resList = await client.listResources();
    assert.equal(resList.resources[0].uri, "ui://agy-cockpit/dashboard.html");
    assert.equal(resList.resources[0].mimeType, "text/html;profile=mcp-app");

    const resRead = await client.readResource({ uri: "ui://agy-cockpit/dashboard.html" });
    const html = resRead.contents[0].text;
    assert.ok(html.includes("Agy Cockpit"));
    assert.ok(Buffer.byteLength(html, "utf8") < 10 * 1024 * 1024);

    // Call open_cockpit with empty args (entrypoint launch contract)
    const openRes = await client.callTool({ name: "open_cockpit", arguments: {} });
    assert.equal(openRes.structuredContent.mode, "normal");

    // Switch mode via app-only tool and verify persistence
    const setRes = await client.callTool({
      name: "cockpit_set_mode",
      arguments: { mode: "turbo" },
    });
    assert.equal(setRes.structuredContent.mode, "turbo");

    const snapRes = await client.callTool({ name: "cockpit_get_snapshot", arguments: {} });
    assert.equal(snapRes.structuredContent.mode, "turbo");
    assert.ok(snapRes.structuredContent.usage);

    // Update local quota budgets via app-only tool and verify independent per-metric persistence
    const quotaRes = await client.callTool({
      name: "cockpit_set_quotas",
      arguments: { metric: "total", fiveHourLimit: 65_000_000, weeklyLimit: 160_000_000 },
    });
    assert.equal(quotaRes.structuredContent.usage.metric, "total");
    assert.equal(quotaRes.structuredContent.usage.fiveHour.limitTokens, 65_000_000);
    assert.equal(quotaRes.structuredContent.usage.weekly.limitTokens, 160_000_000);

    // Switching back to billable keeps its own independent budget (not 65M)
    const billableRes = await client.callTool({
      name: "cockpit_set_quotas",
      arguments: { metric: "billable" },
    });
    assert.equal(billableRes.structuredContent.usage.metric, "billable");
    assert.equal(billableRes.structuredContent.usage.fiveHour.limitTokens, 8_000_000);

    // Persist collapsed cards via app-only tool and confirm snapshot reflects it
    const prefsRes = await client.callTool({
      name: "cockpit_set_ui_prefs",
      arguments: { collapsedCards: ["perf", "usage"] },
    });
    assert.deepEqual(prefsRes.structuredContent.uiPrefs.collapsedCards, ["perf", "usage"]);
    const snapAfterPrefs = await client.callTool({ name: "cockpit_get_snapshot", arguments: {} });
    assert.deepEqual(snapAfterPrefs.structuredContent.uiPrefs.collapsedCards, ["perf", "usage"]);
  } finally {
    await client.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
