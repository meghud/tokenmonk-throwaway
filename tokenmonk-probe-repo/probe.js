#!/usr/bin/env node
/**
 * M0 spike probe (A1/A2/A3). One hook script registered against every Cursor hook event.
 *
 * It answers, empirically, the questions the PRD marks "undocumented → spike":
 *   - which events fire on which surface (ide / cli / cloud_agent / remote)   → A2
 *   - what the payload actually looks like per event (fixtures)               → A2
 *   - whether a plugin hook `command` resolves ${CURSOR_PLUGIN_ROOT}/${PLUGIN_ROOT},
 *     what its cwd is, and whether plugin `variables` reach the process       → A1
 *   - whether `sessionStart.env` propagates to later hooks in the session     → RT-7
 *   - whether beforeReadFile fires for SKILL.md loads                          → A3
 *   - how long a minimal hook takes end to end                                 → RT-1 budget
 *
 * Contract: never block the agent. Always exit 0, always print the event's allow/continue
 * output, never `deny`, never `followup_message`. Any internal failure is swallowed.
 */
"use strict";

const START_NS = process.hrtime.bigint();

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SPIKE_DIR = process.env.TM_SPIKE_DIR || path.join(os.homedir(), ".tokenmonk-spike");
const EVENTS_LOG = path.join(SPIKE_DIR, "cursor-events.jsonl");

/** Literal placeholders we pass in argv; if they come back unchanged, substitution did not happen. */
const PLACEHOLDERS = {
  cursorPluginRoot: "${CURSOR_PLUGIN_ROOT}",
  pluginRoot: "${PLUGIN_ROOT}",
  varProbe: "${TM_PROBE_VAR}",
  varEndpoint: "${CAPTURE_ENDPOINT}",
  varToken: "${CAPTURE_TOKEN}",
};

/**
 * Minimal, always-permissive output per event. Anything not listed prints `{}`.
 * `sessionStart` additionally seeds env so later hooks can prove propagation (RT-7).
 */
/**
 * `sessionStart` is the only event that carries `is_background_agent`, so it is the only place a
 * surface can be determined with confidence. Stamp it into the session env and every later hook
 * inherits it — this is the mechanism PRD RT-7 specifies, and registering it here is what makes the
 * spike actually test it rather than assume it.
 */
function surfaceAtSessionStart(payload) {
  if (payload.is_background_agent === true) return "cloud_agent";
  if (process.env.CURSOR_CODE_REMOTE) return "remote";
  if (process.env.TM_SPIKE_RUN) return String(process.env.TM_SPIKE_RUN);
  return "ide";
}

function outputFor(event, sessionId, payload) {
  switch (event) {
    case "beforeSubmitPrompt":
      return { continue: true };
    case "preToolUse":
    case "beforeMCPExecution":
    case "beforeShellExecution":
    case "beforeReadFile":
    case "beforeTabFileRead":
    case "subagentStart":
      return { permission: "allow" };
    case "sessionStart":
      return {
        env: {
          TM_SPIKE_SESSION_ID: sessionId || "unknown",
          TM_SPIKE_SURFACE: surfaceAtSessionStart(payload),
          TM_SPIKE_STAMP: new Date().toISOString(),
        },
        additional_context:
          "[tokenmonk-probe] M0 spike is recording hook coverage in this session. Ignore this line.",
      };
    default:
      return {};
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(raw);
    };
    // Some events (workspaceOpen) may attach no stdin; never hang the agent waiting for EOF.
    const guard = setTimeout(done, 1500);
    guard.unref?.();
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", done);
      process.stdin.on("error", done);
    } catch {
      done();
    }
  });
}

/** Cursor prefixes stdin JSON with a UTF-8 BOM on Windows (RT-4). */
function parseJson(raw) {
  const stripped = raw.replace(/^﻿/, "");
  try {
    return { value: JSON.parse(stripped), hadBom: raw !== stripped, parsed: true };
  } catch {
    return { value: {}, hadBom: raw !== stripped, parsed: false };
  }
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=([\s\S]*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Structure-preserving scrub. The events log stays on the developer's machine, but it is the
 * source for committed fixtures, so no prompt text, file content, shell command or email ever
 * enters it. Enum-ish/id-ish keys are kept verbatim because the fixtures are useless without them.
 */
const KEEP_VERBATIM = new Set([
  "hook_event_name", "composer_mode", "status", "reason", "final_status", "type", "failure_type",
  "trigger", "model", "model_id", "cursor_version", "sandbox", "subagent_type", "tool_name",
  "mcp_server_name", "conversation_id", "generation_id", "session_id", "subagent_id",
  "tool_use_id", "parent_conversation_id", "tool_call_id", "subagent_model", "id", "value",
  "git_branch", "kind",
]);

function scrubValue(key, value, depth) {
  if (value === null || value === undefined) return value;
  if (depth > 6) return "<deep>";
  if (Array.isArray(value)) return value.slice(0, 5).map((v) => scrubValue(key, v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(k, v, depth + 1);
    return out;
  }
  if (typeof value !== "string") return value;
  if (KEEP_VERBATIM.has(key)) return value;
  // A prompt's leading slash-command is the CP-5 skill-invocation signal and is a slug we ship,
  // not user content — keep it and scrub the rest of the line.
  if (key === "prompt") {
    const slash = /^\/([A-Za-z0-9_:-]{1,64})(\s|$)/.exec(value);
    return slash ? `/${slash[1]} <string:${value.length - slash[1].length - 1}>` : `<string:${value.length}>`;
  }
  if (/@/.test(value)) return "<email>";
  // Paths keep their extension + depth: that is what the file/skill detection logic keys on.
  if (/^[/~]|^[A-Za-z]:\\/.test(value)) {
    const base = path.basename(value);
    const ext = path.extname(base);
    return `<path:${value.split(/[/\\]/).length}seg${ext ? `:${ext}` : ""}${base === "SKILL.md" ? ":SKILL.md" : ""}>`;
  }
  return `<string:${value.length}>`;
}

function scrub(payload) {
  const out = {};
  for (const [k, v] of Object.entries(payload || {})) out[k] = scrubValue(k, v, 0);
  return out;
}

/** Only the env we reason about — never the whole environment. */
function envSnapshot() {
  const interesting = [
    "CURSOR_PROJECT_DIR", "CURSOR_VERSION", "CURSOR_USER_EMAIL", "CURSOR_TRANSCRIPT_PATH",
    "CURSOR_CODE_REMOTE", "CLAUDE_PROJECT_DIR", "CURSOR_PLUGIN_ROOT", "PLUGIN_ROOT",
    "TM_SPIKE_SESSION_ID", "TM_SPIKE_SURFACE", "TM_SPIKE_STAMP", "TM_PROBE_VAR", "CAPTURE_ENDPOINT",
    // Set in the shell before running the CLI: the only reliable IDE-vs-CLI discriminator,
    // because the CLI inherits the terminal environment and the IDE does not.
    "TM_SPIKE_RUN",
  ];
  const present = {};
  for (const k of interesting) {
    if (process.env[k] === undefined) continue;
    // Never record a value that could be a credential.
    present[k] = /TOKEN|SECRET|KEY/i.test(k) ? "<redacted:set>" : process.env[k];
  }
  // Which *other* keys exist that look plugin/variable related — names only, no values.
  const relatedKeys = Object.keys(process.env)
    .filter((k) => /^(CURSOR_|PLUGIN_|TM_|CAPTURE_|TOKENMONK_)/.test(k))
    .sort();
  return { present, relatedKeys };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = await readStdin();
  const { value: payload, hadBom, parsed } = parseJson(raw);

  const event = String(payload.hook_event_name || args.event || "unknown");
  const sessionId = String(payload.session_id || payload.conversation_id || "");

  // Print the agent-facing output first so the measured cost is a true upper bound on blocking.
  let output = {};
  try {
    output = outputFor(event, sessionId, payload);
  } catch {
    output = {};
  }
  process.stdout.write(JSON.stringify(output));

  const substitution = {};
  for (const [name, placeholder] of Object.entries(PLACEHOLDERS)) {
    const argKey = { cursorPluginRoot: "cursor-plugin-root", pluginRoot: "plugin-root",
      varProbe: "var-probe", varEndpoint: "var-endpoint", varToken: "var-token" }[name];
    const got = args[argKey];
    if (got === undefined) continue;
    substitution[name] = {
      substituted: got !== placeholder,
      // A shell expands an unset ${VAR} to "" — which is NOT substitution. Recording the raw value
      // (and, for the token, only its length) is what lets the report tell the two apart.
      value: name === "varToken" ? undefined : got === placeholder ? null : got,
      chars: got === placeholder ? null : got.length,
    };
  }

  // Syntax matrix (added after the first result proved ambiguous): the same variable requested four
  // ways. Single-quoted forms are shell-proof, so a literal coming back means Cursor did not
  // substitute, while an empty string means a shell expanded an unset name. The first test could
  // not tell those apart.
  const syntaxProbe = {};
  for (const key of ["sq-var", "dq-var", "bare-var", "curly-var", "sq-root", "sq-project"]) {
    if (args[key] !== undefined) syntaxProbe[key] = args[key];
  }

  const record = {
    ts: new Date().toISOString(),
    syntax_probe: syntaxProbe,
    event,
    strategy: args.strategy || "unknown",
    hook_source: args.source || "plugin",
    surface_hints: {
      is_background_agent: payload.is_background_agent ?? null,
      composer_mode: payload.composer_mode ?? null,
      cursor_version: payload.cursor_version ?? process.env.CURSOR_VERSION ?? null,
      code_remote: process.env.CURSOR_CODE_REMOTE ?? null,
      has_user_email: Boolean(payload.user_email || process.env.CURSOR_USER_EMAIL),
      transcript_path_set: Boolean(payload.transcript_path || process.env.CURSOR_TRANSCRIPT_PATH),
    },
    session: {
      conversation_id: payload.conversation_id ?? null,
      generation_id: payload.generation_id ?? null,
      session_id: payload.session_id ?? null,
      // Proves (or disproves) RT-7: sessionStart.env reaching later hooks.
      inherited_session_env: process.env.TM_SPIKE_SESSION_ID ?? null,
      inherited_surface: process.env.TM_SPIKE_SURFACE ?? null,
    },
    stdin: { bytes: raw.length, parsed, had_bom: hadBom, keys: Object.keys(payload).sort() },
    runtime: {
      cwd: process.cwd(),
      argv0: process.argv[1] ?? null,
      ppid: process.ppid,
      node: process.version,
      platform: process.platform,
    },
    substitution,
    env: envSnapshot(),
    payload: scrub(payload),
    self_ms: Number(process.hrtime.bigint() - START_NS) / 1e6,
  };

  try {
    fs.mkdirSync(SPIKE_DIR, { recursive: true });
    fs.appendFileSync(EVENTS_LOG, JSON.stringify(record) + "\n");
  } catch {
    // A spike that breaks the editor is worse than a spike with a missing line.
  }
}

main().then(
  () => process.exit(0),
  () => {
    try {
      process.stdout.write("{}");
    } catch {}
    process.exit(0);
  },
);
