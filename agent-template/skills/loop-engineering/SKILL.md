---
name: loop-engineering
description: Loop engineering runtime Grill + Monitor — structured retries with explicit success criteria
---

# Loop Engineering Skill

Sensei has no dedicated verify-loop runtime; engineer the loop out of the
primitives it does have: `delegate` (execute), `delegate` roles (verify),
`goal`/`/work` (continuation until done), `task_list`/`task_status` (async
monitoring), and `wait_for_user` (manual review gates). This skill is the
discipline for doing that reliably.

## Grill (main-agent interview)

Before starting any retry loop, pin down these answers — ask the user when
they are not derivable from the task:

1. Goal: "What are you trying to accomplish?"
2. Success criteria: "Describe how we know the loop succeeded."
3. Success type: choose from `test`, `build`, `lint`, `command`, `fileExists`,
   `oracle`, `observer`, `manual`. For CLI checks capture the exact
   `successCommand`; for file detection capture the `successPath`.
4. Execute agent: fixer / designer / explorer / librarian
5. Verify agent: oracle / observer / test
6. Max attempts (default 3)
7. Optional context files: which files or directories should be read before
   execution?

## Loop Monitor

Track each attempt explicitly — a todo item or a `task_status` check per
iteration:

- Attempt N: dispatch the execute delegate → collect result → run the
  verification step (`oracle`/`observer` delegate or the success command)
- On verify pass → report final outcome and stop
- On verify fail with attempts remaining → feed the failure evidence into the
  next execute prompt; never re-dispatch the identical failing prompt
- On max attempts exhausted → stop and report: goal, attempts, last failure
  evidence, what was ruled out
- On `manual` success type → present the failure/output state to the user and
  call `wait_for_user` to pause; do not auto-resolve a manual gate
- If the user forces cancellation → `task_cancel` any running delegate task
  and stop

## Notes

- Manual verification is the minimal on-ramp. It pauses the loop until the
  user responds via `wait_for_user`. Do not auto-resolve.
- For long-running loops prefer `delegate(background=true)` so monitoring
  happens through task-result injection instead of blocking the main lane.
