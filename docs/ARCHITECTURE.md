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
4. Verify native child-process tool restrictions and skill behavior, then publish the scoped change for review. Background-runtime replacement, independent Council agents and richer team presets remain assessments, not enabled features.
5. Apply the subsequent product decision below: ship Interview as a native Pi conversation skill; close the excluded peripheral products and document unverified infrastructure as pending research.

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

### Product decisions

The following user decisions supersede the initial feasibility assessment. Only Interview is selected for implementation among these products. A technically possible extension is not by itself a reason to ship a product.

| Product | Pi-native integration path | Current decision |
|---|---|---|
| Agent/skill marketplace | Native Pi package installation already exists | **Not doing.** No Sensei marketplace, catalog, store or marketplace compatibility layer. Normal Pi package usage remains host-owned. |
| Interview/specification workflow | Native skill discovery, `/skill:interview`, ordinary user/assistant turns, session JSONL and project file tools | **Implemented as a skill.** One decision per turn, explicit unknowns and a draft specification for confirmation. Saving uses an agreed project document; implementation needs a separate instruction. |
| ACP-connected external agents | Would require an external-agent adapter | **Not doing.** No ACP bridge or SDK dependency. |
| Companion/desktop UI | Would require a separate UI product | **Not doing.** No desktop client, installer or background service. |
| Terminal panes | Would require environment-specific terminal integration | **Not doing.** No pane manager or multiplexer adapters. |
| Separate evaluation product | Pi execution and existing repository tests remain available | **Not doing.** No upstream evaluation dashboard, model judge or separate evaluation service. Ordinary regression tests remain part of development. |

Interview design: use a single prompt skill because the requested behavior is interactive requirements discovery within Pi. Native conversation and session history already supply turn-taking and persistence. The official `question.ts`/`questionnaire.ts` examples offer custom terminal UI, and `ctx.ui` offers dialogs, but neither is needed for this flow. A custom tool, dashboard or server would add an implementation and interaction surface without a confirmed need. The skill is instructional, so it does not enforce approval or automatically pause `/work`/goals; the user must pause active continuation before starting. Compaction/reopen recovery depends on surviving Pi history or a referenced specification, not a guaranteed recovery hook.

Verification for the skill covers native discovery/command expansion, packaging, and a fresh-context behavioral check for one-decision turn-taking, skipped answers, confirmation, saving and continuation. It does not establish deterministic model compliance or a live-provider interview benchmark.

### Remaining functionality: native coverage and pending research

Apply the root native-infrastructure rule before any further port. Reuse confirmed native behavior; when a higher-level subsystem would still need to be built or the native coverage is uncertain, leave it unimplemented and record **pending research**. The table does not classify an available primitive as absent, and pending research is not an implementation commitment.

| Remaining behavior | Confirmed Pi infrastructure | Current disposition / next research question |
|---|---|---|
| Background admission queues and provider/model concurrency budgets | Official subagent example has bounded in-process parallelism; current Sensei uses separate CLI children | **Pending research; not ported.** Establish whether that example covers shared background admission, ownership and cancellation before adding any queue. |
| Live child messages, child questions and continuation of the original child context | SDK/RPC can steer, follow up, answer extension UI requests and resume session files | **Pending research; not ported.** Current `--no-session` print children have no input channel or saved child conversation. Do not claim `task_send`/`task_revive` provide these behaviors or replace the task runtime now. |
| Durable restart/checkpoint execution | Official `pi-durable` exists as a separate Harness, not a coding-agent CLI facility | **Pending research; not adopted.** Prove a compatible CLI integration and state ownership first; no second engine. |
| Independent tool-using Council seats | Native isolated Pi processes and tool/model selection exist | **Pending research; not ported.** Validate reliable terminal results and bounded seat orchestration on those primitives before replacing the existing text-only Council. |
| Complete team presets, custom agent definitions and role-model profiles | Single-session model/thinking APIs, CLI model selection and official preset/subagent examples exist | **Pending research; not ported.** No complete native team-profile manager was established. Preserve current prompt presets and explicit per-call model selection. |
| Automatic model-chain fallback | Native retries, `registerVirtualModel`, retry metadata and branch-persisted route state exist | **Pending research for policy; no new fallback enabled.** Determine the required chain, supported failure semantics and retry/cache behavior. Use Pi routing if later confirmed, not an imported fallback engine. |
| Automatic Deepwork pointer recovery | Native lifecycle hooks, session history and custom entries exist | **Pending research; not ported.** No native Deepwork index recovery facility was established; retain the documented manual recovery procedure. |
| Independent Validator and extra workflow skills | Native delegation and skill loading already exist | Reuse existing Fixer/Oracle checks and the Deepwork reassessment step. No new role or skill catalog is required by this scope; additional workflow proposals remain **pending research** for a concrete need. |
| Advanced Smartfetch, path rescue and patch-recovery hooks | Pi owns file/search/edit tools; Sensei has a lean fetcher | **Pending research; not ported.** Establish exact native coverage and reproduce a missing behavior before adding wrappers or dependencies. |

The already-reproduced task success-classification defect above remains an existing correctness issue, not a new feature deferred for lack of native infrastructure. Source/API assessments here do not establish live-provider, durable-restart or platform behavior. No optional runtime dependency, model change or autonomous scheduler is activated.

### Official evidence inspected

All references below are pinned to Pi v1.4.0, commit `4a080252f06caf63a525d7873c5d94d3c23887e0`:

- [CLI scope](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/README.md), [official subprocess subagent example](https://github.com/earendil-works/pi/tree/v1.4.0/packages/coding-agent/examples/extensions/subagent).
- [SDK](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/sdk.md), [RPC integration](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/cli-integration.md), [injected session environment](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/environment-variables.md).
- [Durable Harness and background examples](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/README.md#abort-and-subagents).
- [Official preset example](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/examples/extensions/preset.ts), [virtual models](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/virtual-models.md), [settings](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/settings.md).
- [Pi packages](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/packages.md), [extension interfaces](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/extensions/types.ts).
- [Native skills and command expansion](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/skills.md), [optional question UI example](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/examples/extensions/question.ts), [optional questionnaire example](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/examples/extensions/questionnaire.ts).
