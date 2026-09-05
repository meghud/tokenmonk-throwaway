# tokenmonk-throwaway

Disposable Cursor **plugin marketplace** used for one experiment in the TokenMonk Cursor-capture M0 spikes.

**It answers exactly one question:** do plugin `variables` set in Cursor's Configure panel reach a
hook process when the plugin is installed **from a Git repo**, rather than from
`~/.cursor/plugins/local/`? A local install was measured and they do not — the placeholders expand
to `""` while `${CURSOR_PLUGIN_ROOT}` resolves in the same command. This repo tests whether install
origin changes that, because the answer decides how org configuration reaches the real plugin.

## What it does

Registers one logging script on 19 Cursor hook events. For each event it appends a scrubbed record
to `~/.tokenmonk-spike/cursor-events.jsonl` and exits. It is observe-only:

- always exits 0 and prints the permissive output for the event (`{"continue":true}`,
  `{"permission":"allow"}`); never `deny`, never `failClosed`, never `followup_message`
- prompt bodies, shell commands, file contents and emails are replaced with shape descriptors
  before anything is written to disk
- nothing is sent off the machine — there is no network code in it
- the declared variables are shape tests; the token field is recorded only as a length, never a value

## Layout

Multi-plugin marketplace repo, per Cursor's reference — a team marketplace requires
`.cursor-plugin/marketplace.json` at the repo root:

```
.cursor-plugin/marketplace.json     lists the plugins in this repo
tokenmonk-probe-repo/               the plugin itself
  .cursor-plugin/plugin.json
  hooks/hooks.json                  19 events, all carrying the variable probes
  probe.js                          the logging hook
  skills/  rules/
```

## Use

Import this repo into a Cursor team marketplace, install `tokenmonk-probe-repo`, set
**Probe sentinel** in Configure, restart, use Cursor briefly, then inspect
`~/.tokenmonk-spike/cursor-events.jsonl`. Records from this plugin are tagged
`source=repo strategy=repo-plugin-root`, so it can run alongside a local install and still be told
apart.

Delete the repo when the experiment is done. It is not a product.
