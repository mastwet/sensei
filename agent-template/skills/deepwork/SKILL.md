---
name: deepwork
description: Use when an explicitly requested Deepwork session or a large, risky Pi-based coding effort needs several dependent delivery passes and coordinated verification. Skip routine bounded changes.
---

# Deepwork for Sensei

Use this optional workflow through Pi's `/skill:deepwork <task>` command.
Keep the main agent responsible for planning, integration and acceptance.
Implement small steps directly; delegate independent, well-bounded work when
doing so reduces total effort. A skill supplies instructions, not a scheduler,
file watcher or durable task engine.

## Deliver the whole flow in passes

1. **Sketch:** make every required user flow work end to end at a useful minimum.
2. **Structure:** establish real data, module boundaries and principal failure paths.
3. **Detail:** harden observed risks and polish to the requested quality.

Choose the number of passes from the task. Each pass ends with a usable
delivery and a ranked known-issues list. Security and money/data correctness
belong in the first usable delivery. Stop when acceptance is met; hand over
remaining issues with their consequences.

Record the pass goal, ownership, dependencies, failure behavior and evidence
in the project's existing plan. Use its existing decision documents for
durable decisions. Add a new project document only when no suitable home exists.

## Use Pi and Sensei roles

Use `delegate(task, role, background?, cwd?, model?, timeoutSeconds?)`.
Choose `background` only for work that can proceed independently. The caller
must supply relevant paths, context, constraints, output and acceptance checks.
State which files each writer owns before parallel dispatch.

| Role | Responsibility | Capability boundary |
|---|---|---|
| `explorer` | Codebase and external documentation research | Read/retrieval tools; returns findings to the parent |
| `oracle` | Architecture and code review | Read/retrieval tools; returns findings to the parent |
| `fixer` | Bounded implementation, wiring and assigned checks | Pi file/shell tools; no Sensei delegation controls |
| `designer` | UI design, implementation and visual review | Pi file/shell/retrieval tools; no Sensei delegation controls |
| `observer` | Visual inspection | Media/read tools |

`librarian` remains a compatibility alias for `explorer`; use `explorer`
for new research. Read-only roles cannot write research artifacts or run shell
diagnostics. The parent records accepted findings in existing project docs.
Pi's tool selection enforces available tools; prompt wording alone is not a
shell sandbox.

Keep further delegation in the parent. Shell-capable workers remain trusted
executors; omitting a tool does not prevent launching programs through shell.

Use task handles from actual results. Consume terminal results before acting
on them; inspect reported exit, timeout and error evidence rather than treating
text or a `done` label as proof of success. `task_send` attaches a completion
note; it does not steer the running subprocess. `task_revive` starts fresh
work from saved parameters; it does not resume the old child context.

## Keep a small resume index

Obtain the current Pi session ID from the shell tool's injected environment:

```sh
node -e "console.log(process.env.PI_SESSION_ID || '')"
```

Use the returned value, never a guessed ID. If it is unavailable, use the
existing project progress document and report that no session head was created.

For a known session ID, keep only:

- `.sensei/deepwork/<session-id>.md`: `status:` and `slug:` pointing to this task.
- `.sensei/deepwork/<task-slug>/progress.md`: about 40 lines, rewritten in place.
  Include status, pass/goal, next step, constraints, decisions, running task
  handles with ownership, References to project documents, and ranked issues.

Keep this local index ignored by git. Other durable artifacts remain at their
existing project paths. Do not store duplicate plans, per-lane transcript
copies or process diaries under the index.

Only the parent writes its head and progress. Before adopting an existing
task, check whether another active session head names its slug; choose a
separate task when another writer owns it. This convention does not provide
cross-process locking.

On continuation after compaction or reopening, use the visible Pi session
history (or read the JSONL path in `PI_SESSION_FILE` when needed; ephemeral
sessions have no file), then this session's head, its progress and only the References
needed for the next action. On a fork or new session, create its own head and
respect existing ownership. If the pointer cannot be resolved unambiguously,
report what is missing instead of claiming automatic restoration.

Pi owns sessions and compaction. This skill does not install an automatic
pointer-injection hook, receipts/claims guard or separate persistence engine.
Update the index at pass transitions, decisions and blockers.

## Verify, review and finish

Run checks appropriate to the pass and its real risks. Build success alone
does not prove runtime, UI, persistence or external-service behavior.
Integrate writers before final verification and reuse evidence while valid.

At each meaningful pass boundary, request one scoped `oracle` review when
the changed risk warrants it. Include the goal, changed paths, established
decisions and actual evidence. Repair material findings in one bounded pass;
allow at most two justified re-reviews focused on changed or unresolved risks.
Keep design changes with `designer` and mechanical follow-up with `fixer`.

Commit an independently valid pass. If effort keeps growing, step back,
reassess the direction and revise the next pass rather than extending a patch
chain. Honor user-requested checkpoints; otherwise continue within authorization.

When acceptance is met, rewrite progress to a short completion record with
deliverable references, verification, known issues and date; mark its head
completed. Report implemented, verified and unverified outcomes separately.
