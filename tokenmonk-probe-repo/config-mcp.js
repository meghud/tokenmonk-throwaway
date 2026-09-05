#!/usr/bin/env node
/**
 * The control for the PK-2 experiment.
 *
 * `mcp.json` is the ONE substitution target Cursor documents, so this server receives the same
 * plugin variables the hooks ask for — via its `env` block. Comparing the two answers the question
 * a hook-only test cannot:
 *
 *   variables here but not in hooks  -> they are delivered; hook commands are simply not a
 *                                       substitution target. PK-2 path (b), and the "config MCP
 *                                       server" remedy the PRD proposes is proven to work.
 *   variables in neither             -> nothing was set or propagated at all; the hook result is
 *                                       uninformative and the test must be re-run.
 *
 * It also doubles as the smallest possible version of that remedy: on start it writes what it
 * received to ~/.tokenmonk/cursor.config.json, which is exactly how the real plugin would hand a
 * dashboard-held token to its hooks.
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SPIKE_DIR = process.env.TM_SPIKE_DIR || path.join(os.homedir(), ".tokenmonk-spike");
const EVENTS = path.join(SPIKE_DIR, "cursor-events.jsonl");

/** Never record a credential value — only whether one arrived, and how long it was. */
function describe(name, value) {
  if (value === undefined) return { state: "absent", chars: null };
  if (value === "") return { state: "empty", chars: 0 };
  if (value === "${" + name + "}") return { state: "literal", chars: value.length };
  const secret = /TOKEN|SECRET|KEY/i.test(name);
  return { state: "resolved", chars: value.length, value: secret ? undefined : value };
}

const received = {
  TM_PROBE_VAR: describe("TM_PROBE_VAR", process.env.TM_PROBE_VAR),
  CAPTURE_ENDPOINT: describe("CAPTURE_ENDPOINT", process.env.CAPTURE_ENDPOINT),
  CAPTURE_TOKEN: describe("CAPTURE_TOKEN", process.env.CAPTURE_TOKEN),
};

try {
  fs.mkdirSync(SPIKE_DIR, { recursive: true });
  fs.appendFileSync(EVENTS, JSON.stringify({
    ts: new Date().toISOString(),
    event: "mcp-config-probe",
    hook_source: "repo-mcp",
    strategy: "mcp-env",
    mcp_env: received,
    runtime: { cwd: process.cwd(), node: process.version },
    env: { present: { CURSOR_PLUGIN_ROOT: process.env.CURSOR_PLUGIN_ROOT ?? null } },
  }) + "\n");

  // The remedy itself: hand the config to disk where hooks can read it.
  if (received.TM_PROBE_VAR.state === "resolved") {
    const dir = path.join(os.homedir(), ".tokenmonk");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cursor.config.json"), JSON.stringify({
      writtenBy: "tokenmonk-probe-repo config-mcp",
      at: new Date().toISOString(),
      endpoint: process.env.CAPTURE_ENDPOINT ?? null,
      sentinel: process.env.TM_PROBE_VAR ?? null,
      hasToken: Boolean(process.env.CAPTURE_TOKEN),
    }, null, 2) + "\n", { mode: 0o600 });
  }
} catch {
  // A probe must never break the editor's MCP startup.
}

// ---- minimal MCP stdio server: newline-delimited JSON-RPC 2.0 ---------------------------------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue; // notification: nothing to answer

    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "tokenmonk-config-probe", version: "0.0.1" },
      }});
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{
        name: "tm_probe_config",
        description: "Report which TokenMonk plugin variables reached this MCP server's environment.",
        inputSchema: { type: "object", properties: {} },
      }]}});
    } else if (msg.method === "tools/call") {
      send({ jsonrpc: "2.0", id: msg.id, result: {
        content: [{ type: "text", text: JSON.stringify(received, null, 2) }],
      }});
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
