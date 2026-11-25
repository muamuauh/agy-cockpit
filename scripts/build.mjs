import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DIST_PLUGIN = path.join(ROOT, "dist", "plugin");
const INSTALL_TARGET = path.join(os.homedir(), ".gemini", "config", "plugins", "agy-cockpit");

function syncDirInPlace(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const srcEntries = fs.readdirSync(src, { withFileTypes: true });
  const keepNames = new Set(srcEntries.map((e) => e.name));

  for (const entry of srcEntries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      syncDirInPlace(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }

  for (const existing of fs.readdirSync(dst, { withFileTypes: true })) {
    if (!keepNames.has(existing.name)) {
      try {
        fs.rmSync(path.join(dst, existing.name), { recursive: true, force: true });
      } catch {
        // Ignore locked stale entries on Windows while MCP server is running
      }
    }
  }
}

async function build() {
  fs.rmSync(DIST_PLUGIN, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST_PLUGIN, "bin"), { recursive: true });
  fs.mkdirSync(path.join(DIST_PLUGIN, "ui"), { recursive: true });
  fs.mkdirSync(path.join(DIST_PLUGIN, "assets"), { recursive: true });

  // 1. Bundle MCP Server (single self-contained Node ESM bundle)
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "server", "index.mjs")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: path.join(DIST_PLUGIN, "bin", "server.mjs"),
    banner: {
      js: 'import { createRequire as __agyCreateRequire } from "node:module"; const require = __agyCreateRequire(import.meta.url);',
    },
    minify: false,
  });

  // 2. Bundle Hook Script (single self-contained Node ESM bundle)
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "hook", "hook.mjs")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: path.join(DIST_PLUGIN, "bin", "hook.mjs"),
    minify: false,
  });

  // 3. Bundle MCP App UI into a single self-contained HTML file (strict CSP compliant)
  const uiBundle = await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "ui", "app.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: ["es2022"],
    write: false,
    minify: true,
  });
  const jsCode = uiBundle.outputFiles[0].text;
  const cssCode = fs.readFileSync(path.join(ROOT, "src", "ui", "styles.css"), "utf8");
  const tpl = fs.readFileSync(path.join(ROOT, "src", "ui", "template.html"), "utf8");
  const finalHtml = tpl
    .replace("/* __INLINE_CSS__ */", () => cssCode)
    .replace("/* __INLINE_JS__ */", () => jsCode);
  fs.writeFileSync(path.join(DIST_PLUGIN, "ui", "dashboard.html"), finalHtml, "utf8");

  // 4. Copy plugin manifests and logo
  for (const name of ["plugin.json", "mcp_config.json", "hooks.json"]) {
    fs.copyFileSync(path.join(ROOT, "plugin", name), path.join(DIST_PLUGIN, name));
  }
  fs.copyFileSync(path.join(ROOT, "assets", "logo.svg"), path.join(DIST_PLUGIN, "assets", "logo.svg"));

  const htmlKB = (Buffer.byteLength(finalHtml, "utf8") / 1024).toFixed(1);
  const srvKB = (fs.statSync(path.join(DIST_PLUGIN, "bin", "server.mjs")).size / 1024).toFixed(1);
  console.log(`[build] OK -> ${DIST_PLUGIN} (server.mjs: ${srvKB} KB, dashboard.html: ${htmlKB} KB)`);

  if (process.argv.includes("--install")) {
    syncDirInPlace(DIST_PLUGIN, INSTALL_TARGET);
    console.log(`[install] Synced plugin -> ${INSTALL_TARGET}`);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
