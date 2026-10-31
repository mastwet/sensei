# Sensei architecture

Sensei pins the official Pi **1.4.0** host and owns a thin configuration and extension layer. The release and npm `latest` tag were checked on **2026-10-31**; the release was published on 2026-10-21 UTC. Upstream: [earendil-works/pi](https://github.com/earendil-works/pi), [v1.4.0](https://github.com/earendil-works/pi/releases/tag/v1.4.0).

The authoritative project constraints are in [AGENTS.md](../AGENTS.md): Pi only, native infrastructure first, minimal owned machinery and selective upstream adoption. This document records the corresponding architecture and evidence.

## Ownership and execution

| Layer | Owner | Contract |
|---|---|---|
| Launcher | Sensei, `bin/sensei.mjs` | Resolve the installed host by package name, seed the isolated agent directory, sync owned resources, and pass arguments and exit status through to Pi. |
| Agent runtime | Official Pi package | TUI, print/JSON/RPC, session persistence and compaction, model registry, authentication, provider requests, and built-in tools. |
| Tool composition | Official Pi built-in extensions | MCP transports and OAuth, `codemode` sandbox and nested tool execution, `tool_search`, exposure and namespaces. |
| Owned behavior | `agent-template/extensions/sensei/index.ts` | Register Sensei tools, commands and supported lifecycle hooks. Delegate subprocesses use the same pinned Pi CLI and inherited agent directory. |
| Owned resources | `agent-template/extensions/`, `skills/` | Copied into the agent directory on every launch, so installed upgrades propagate. |
| User configuration and state | Agent directory, normally `~/.sensei` | Existing settings, models, auth, prompts, presets, rules, sessions, goals, loops and task records remain user-owned. |

The host stays an exact dependency pin with a committed npm lockfile. Forking Pi or replacing its runtime would add another upgrade surface without a requirement that justifies it. A floating `latest` dependency would make identical Sensei releases run against different APIs. Neither is needed for this update.

The launcher remains a process boundary, rather than embedding the SDK. This keeps the native CLI modes and lets delegated tasks reuse the same executable without maintaining a second runtime integration.

## Pi 1.4 contracts used by Sensei

- `defaultTools` contains additive entries: `+grep`, `+find`, `+ls`, `+codemode`, `+tool_search`. Pi retains its default coding tools. Extension tools keep their normal activation behavior; this is not a global allowlist. PowerShell is an optional upstream tool, enabled on Windows with `--tools +powershell`.
- MCP remains upstream-owned. Configure servers in `<agentDir>/mcp.json` or trusted project `.pi/mcp.json`; use Pi's `/mcp` and `sensei mcp` commands. Sensei does not add a second MCP manager.
- Calls from `codemode` pass through Pi's validation and Sensei's `tool_call`/`tool_result` hooks. Nested calls carry `parentToolCallId`; bash defaults and nested `AGENTS.md` injection must work for these calls too.
- `before_agent_start` runs for user prompts and custom-message-triggered runs. Rules, presets and the bash timeout policy apply to both; these handlers do not require `event.prompt`.
- Commands submit prompts with `pi.sendUserMessage()`. Ordinary command contexts do not expose `ctx.sendUserMessage()`.
- `/work`, active goals and due headless loops append hidden messages at `agent_before_settle`. `context.canContinue` describes the current context before that handler's entries. A finished assistant message usually makes it false; Pi rebuilds and validates the context after applying returned entries. Sensei gates continuation on a completed outcome, appends its message, and returns `continue: true`. Abort and error outcomes do not restart work.
- Goal continuation takes precedence over `/work`. Existing continuation caps and goal stall audits remain in place.
- Background task completions retain boundary delivery and persisted `reported` tracking. A restored completion reaches the conversation once; a later launch does not redeliver it.

## Upgrading from Pi 0.87.1

The launcher automatically syncs updated owned extensions and skills. It does **not** rewrite existing `settings.json`, `models.json`, authentication or task data.

For an existing profile, optionally replace only its `defaultTools` value with:

```json
["+grep", "+find", "+ls", "+codemode", "+tool_search"]
```

The old explicit tool list still works on Pi 1.4.0. Additive entries allow future default-tool changes to be inherited. New profiles also include the upstream settings schema for editor completion.

Pi 1.0 changed the default TUI to fullscreen. To retain terminal scrollback, set `"tuiMode": "regular"` or launch with `sensei --tui-mode regular`. Sensei's custom header continues to use the supported TUI header API.

Pi 1.0.3 renamed the Azure provider from `azure-openai-responses` to `azure`. If used, update that provider key in settings, models and auth, or log in again with the new provider name. The `AZURE_OPENAI_*` environment variables are unchanged. Sensei does not silently migrate credentials.

For sustained slash-command work, use the TUI or a long-lived RPC process. One-shot print/JSON mode is intended for supplied prompts; command-triggered asynchronous runs can outlive the command handler. RPC clients must consume through `agent_settled`, not treat a successful `prompt` response as completion.

## Upgrade verification

The implementation sequence for this upgrade is: pin the release and lockfile; exercise owned APIs against the real host; fix reproduced API and continuation failures; verify packaging and document profile migration. No additional runtime dependencies are introduced by Sensei.

```sh
npm ci --ignore-scripts
npm test
npm run smoke
npm pack --dry-run
```

`npm test` runs the actual launcher and pinned CLI with temporary profiles and a deterministic local model extension. It covers profile preservation, extension loading, codemode calling owned and stock tools, bash timeout policy, nested instructions, `/work` continuation and aborted outcomes, goal resume and continuation, continuation caps, due headless and restored loops, custom-message prompt hooks, and background completion deduplication. It uses no live provider credentials or paid model calls.

Before publishing a new Sensei release, also validate an authenticated provider session and the native Windows launcher/TUI. The offline suite does not establish live provider behavior, MCP server connectivity, or Windows terminal rendering.

## Pi-native adoption assessment — 2026-10-31

The smallest viable approach is to keep the official Pi CLI as the host, adapt accepted workflow text and specialist tool selections, and assess larger products independently. Importing another host's orchestration or configuration machinery contradicts the project boundary. Replacing the current CLI with a durable Harness is a separate runtime integration with materially more state ownership; the inspected source does not justify that cost for the present task.

### Applied scope and implementation sequence

1. Record the Pi-only and minimal-design rules in the root `AGENTS.md`.
2. Check the pinned Pi source and official examples for background work, models, presets and packages before choosing an integration.
3. Adapt Deepwork as a Pi skill and consolidate specialist research into Explorer, retaining the Librarian alias and its existing prompt override paths.
4. Verify native child-process tool restrictions and skill behavior, then publish the scoped change for review. Background-runtime replacement, independent Council agents, richer model presets and peripheral products remain assessments, not enabled features.

Deepwork uses `/skill:deepwork`, Pi's injected `PI_SESSION_ID`, a small local resume index and references to existing project documents. It adds no hook, scheduler or guard. This is an explicit choice: the skill provides a manual recovery procedure, not guaranteed automatic pointer restoration after compaction. Its old references to receipts and shadow guards are removed.

There are five canonical specialists. Explorer combines codebase and external-documentation research; `librarian` selects the same bundled role while alias-specific user override files continue to work. Explorer and Oracle use Pi `--tools` retrieval-only selections, excluding shell, mutation, codemode and task controls. Workers receive explicit implementation tool selections; they do not receive delegation or task-revival controls. These are tool boundaries, not an operating-system sandbox: installed extensions and network providers remain trusted code.

### Background tasks: equivalents and remaining gaps

| Pi surface | What the inspected official implementation provides | Fit for Sensei |
|---|---|---|
| Coding-agent CLI | Session JSONL, JSON/RPC events, steering/follow-up queues, abort and extension lifecycle hooks. Its README explicitly leaves subagent policy to extensions. | Reuse the host; it does not supply a built-in durable background task manager. |
| Official `examples/extensions/subagent` | Separate Pi subprocesses, isolated contexts, role/tool/model selection, parallel and chained execution, streaming, usage collection, abort and failure handling. It is an example extension, not a default installed feature. | Closest reference for the current `delegate`; adapt only missing behavior and failure cases. Do not register a second competing subagent tool. |
| Coding-agent SDK and `RpcClient` | Embedded sessions or a long-lived Pi process with typed prompts, steering and cancellation. | Useful for live control or a future external UI; using them alone does not make work survive process death. |
| Official `@earendil-works/pi-durable` 1.4.0 | Persistent tasks and checkpoints, ownership, cancellation, stored waits, background anchor/reporter tasks and restart-safe request IDs. Official examples 22/23 cover foreground/background subagents. | A real official equivalent at the library level, but a separate Harness/storage/conversation API. It is not plugged into the coding-agent CLI, so adding it creates another runtime integration. Defer adoption pending a demonstrated need for durable restart/resume. |

Decision: retain one minimal Pi-process delegation path for now, using the official subagent example as the behavioral reference. Before expanding it, fix the already-reproduced success-classification gap: child failure with partial text must remain failure, and interrupted/recovered output needs terminal evidence. Existing `task_revive` replays saved parameters in a fresh child; it does not restore the original child conversation. None of the assessment implies that the current task layer already has pi-durable guarantees.

### Independent Council agents

This is feasible through independent Pi CLI/SDK sessions. A candidate design uses existing delegation for read-only councillor sessions with explicit models, then one separate synthesis session with no tools. Pi supplies model/auth/session handling and tool selection; Sensei would own the bounded seat fan-out and result assembly only. Seats stay independent, with no peer-response rounds or majority-vote engine. Keep the existing four-seat limit and make errors, incomplete results and timeout evidence visible; require reliable task outcomes before adopting the design.

Current `council` remains direct model calls with no tools. Independent code-reading seats and a separate synthesis agent are **not implemented by this change**. Evaluate their additional model turns, context, startup cost and observed review quality against the current text-only flow before selecting them. No accuracy or latency improvement has been measured.

### Configuration and models

| Need | Pi 1.4.0 infrastructure | Assessment |
|---|---|---|
| Provider/auth/model catalog | `models.json`, `ModelRuntime`/registry, `/model`, `--model`, thinking levels and session model entries | Reuse directly; do not create another credential or model registry. |
| Named model/tool/prompt presets | Official `examples/extensions/preset.ts` uses `setModel`, `setThinkingLevel`, tool selection and persisted `appendEntry` state | Feasible as a small adaptation of the existing Sensei `/preset`. This is an optional example, not a built-in rich preset manager. Preserve existing Markdown prompt presets if later expanded. |
| Fallback/routing | `registerVirtualModel`, routing reasons `user/continuation/retry/direct`, previous/failed response metadata and branch-persisted routing state; built-in retry settings | Public primitives exist. A small explicit fallback policy is feasible; provider-specific error interpretation, retry limits and cross-model cache effects still need design and tests. Do not port an external fallback state machine. |
| Team/role-to-model profiles | Delegate `--model` selection and official agent-definition examples; Pi session state for the selected model | No ready-made team-profile manager was established in the CLI. Add a small role-to-model mapping only when a concrete roster requirement is confirmed. No new profile/config schema is introduced here. |
| Enabling optional resources | Native Pi packages and resource filters, extension registration/activation and `pi config` | Prefer package/resource selection over additional global switches. Individually selectable features need independent extension/package entries; the current aggregate Sensei entry does not make every internal module separately configurable. |

### Peripheral products: separate Pi feasibility assessments

| Product | Pi-native integration path | Current decision |
|---|---|---|
| Agent/skill marketplace | Native Pi packages, npm/git/local sources, gallery discovery, install/list/remove/update/config and resource filters | Reuse package infrastructure. A curated catalog could be external data/UI; no separate transactional package store or foreign manifest format. |
| Interview/specification workflow | A Pi skill or optional command using existing `ctx.ui` dialogs and project documents; RPC clients answer extension dialogs | Feasible without an embedded web server. Product flow and useful output still need to be selected; no interview subsystem is added. |
| ACP-connected external agents | Optional Pi extension speaking ACP to a configured subprocess, returning results through a Pi tool | No native ACP client was established in the inspected coding-agent interfaces. Feasible as an independent adapter, with separate external-agent permissions, model selection, cancellation and protocol tests. No adapter or SDK dependency is added. |
| Companion/desktop UI | Read Pi JSON/RPC events in a separate client; use Pi's existing sessions and control protocol | Feasible as an external product. Desktop packaging, OS integration and its permissions are outside the coding core. |
| Terminal panes | Launch native Pi processes in a selected terminal/multiplexer and observe JSON/RPC | Feasible as an optional environment-specific integration. Do not import terminal viewers or wiring tied to another host; verify native Windows and WSL separately. |
| Evaluation harness | Existing real-host offline tests plus Pi CLI/RPC/SDK for future task trials | Reuse Pi execution; deterministic scoring and optional model judging must stay distinct. Live trials require their own scoped, token-cost-aware validation. |

These conclusions are source/API feasibility assessments. They are not live-provider, live-ACP, durable-restart or desktop prototypes. No optional runtime dependency, model change, autonomous scheduling policy or peripheral product is activated.

### Official evidence inspected

All references below are pinned to Pi v1.4.0, commit `4a080252f06caf63a525d7873c5d94d3c23887e0`:

- [CLI scope](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/README.md), [official subprocess subagent example](https://github.com/earendil-works/pi/tree/v1.4.0/packages/coding-agent/examples/extensions/subagent).
- [SDK](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md), [RPC integration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/cli-integration.md), [injected session environment](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/environment-variables.md).
- [Durable Harness and background examples](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/README.md#abort-and-subagents).
- [Official preset example](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/examples/extensions/preset.ts), [virtual models](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/virtual-models.md), [settings](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/settings.md).
- [Pi packages](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/packages.md), [extension interfaces](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/extensions/types.ts).
