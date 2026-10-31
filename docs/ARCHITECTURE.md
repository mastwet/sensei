# Sensei architecture

Sensei pins the official Pi **1.4.0** host and owns a thin configuration and extension layer. The release and npm `latest` tag were checked on **2026-10-31**; the release was published on 2026-10-21 UTC. Upstream: [earendil-works/pi](https://github.com/earendil-works/pi), [v1.4.0](https://github.com/earendil-works/pi/releases/tag/v1.4.0).

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
