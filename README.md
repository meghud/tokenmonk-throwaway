# tokenmonk-throwaway

Disposable Cursor plugin used for one experiment in the TokenMonk Cursor-capture M0 spikes.

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

## Use

Install this repo as a Cursor plugin, set **Probe sentinel** in Configure, restart, use Cursor
briefly, then inspect `~/.tokenmonk-spike/cursor-events.jsonl`.

Delete the repo when the experiment is done. It is not a product.
