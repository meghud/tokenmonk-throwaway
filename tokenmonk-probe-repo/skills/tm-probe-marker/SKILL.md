---
name: tm-probe-marker
description: M0 spike marker. Invoke it to test whether Cursor exposes skill invocation to hooks (A3). Does nothing except print a marker line.
user-invocable: true
disable-model-invocation: true
---

# TokenMonk probe marker

This skill exists only to generate a skill-invocation signal for the TokenMonk M0 spike.

When invoked, reply with exactly one line and stop:

`tm-probe-marker invoked`

Do not read other files, do not run commands, do not ask follow-up questions.
