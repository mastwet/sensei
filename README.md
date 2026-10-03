# sensei

A stability-first, self-maintained coding agent. Built like `oh-my-opencode-slim` but the other way around: the host is someone else's maintained project, everything we own is a thin layer on top.

- **Host**: pinned `@earendil-works/pi-coding-agent` (upstream `badlogic/pi-mono`, NOT senpi). Never forked, never patched. The payload sent to providers is exactly what upstream pi sends — no hook-layer mutation, no cache busting.
- **Owned layer**: one agent dir seeded from `agent-template/` — settings, extensions, skills, prompts. Single config surface, a handful of knobs.
- **Isolation**: runs with `PI_CODING_AGENT_DIR=~/.sensei`. Never touches `~/.pi`, `~/.senpi`, or your other agent installs. Coexists with them.

Source, issues, and release notes: [github.com/mastwet/sensei](https://github.com/mastwet/sensei) · MIT licensed.

## Install

```sh
npm install -g agent-sensei
sensei            # first run seeds ~/.sensei, then starts the TUI
```

The command is `sensei`; the package is `agent-sensei` (the unscoped `sensei` name is taken on npm).

Requires Node >= 22.19. Auth is per sensei (`~/.sensei/auth.json`); run `sensei` once and log in, or set the provider env var (e.g. `OPENAI_API_KEY`).

<details>
<summary>Install from source (for hacking on sensei itself)</summary>

```sh
./install.sh        # npm install --ignore-scripts && npm link
```

`install.sh` is POSIX. On Windows use `.\start.ps1`, which does the same install/link steps plus a version smoke check, then hands the console to the TUI:

```powershell
.\start.ps1                       # bootstrap + launch
.\start.ps1 -p "explain this repo" # args pass straight through to sensei
.\start.ps1 -NewWindow             # launch in a separate window (no TTY needed)
.\start.ps1 -SkipInstall -SkipLink # re-launch without reinstalling
```

If PowerShell blocks the script, either `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or run it via `powershell.exe -ExecutionPolicy Bypass -File .\start.ps1`.

Note that the source bootstrap installs with `--ignore-scripts`, so `@ast-grep/cli` never places its binary. The launcher falls back to the platform-specific package to find `sg`.

</details>

## Architecture

```
agent-sensei repo
├── bin/sensei.mjs        # wrapper: seeds agent dir, execs pinned pi with PI_CODING_AGENT_DIR
├── install.sh            # POSIX source bootstrap: npm install --ignore-scripts && npm link
├── start.ps1             # Windows source bootstrap + launch (same steps, plus smoke check)
├── agent-template/       # seeded to ~/.sensei on first run; your config+extensions live there after
│   ├── settings.json     # the only config file: few knobs
│   ├── models.json       # your compatible endpoints (empty by default — add your own)
│   ├── extensions/sensei/# owned extensions (tools/commands/hooks)
│   ├── skills/           # user skills (SKILL.md dirs)
│   └── prompts/          # prompt templates → /slash-commands
└── package.json          # pins the host version — the entire host contract
```

The wrapper resolves both dependencies by package name rather than by path. A local checkout nests them under `sensei/node_modules`, but a global `npm i -g` hoists them into an ancestor `node_modules` and `sensei/node_modules` may not exist at all — so `join(root, "node_modules", …)` would break every global install.

## Owned features (extensions/sensei)

### Orchestration and sustained work

| Feature | What it does | Replaces |
|---|---|---|
| `delegate` tool | Runs a self-contained subtask in a fresh headless pi subprocess (own session, same toolset, depth-capped at 2, timeout, 30k output cap). `task`, `role`, `background`, `cwd`, `model`, `timeoutSeconds`. | omo subagents/team-mode core value |
| `roles` | The six specialist role prompts behind `role`: explorer, librarian, oracle, designer, fixer, observer — each with its own tool limits and file-operation rules. | omo agent role prompts |
| `task_*` tools | Durable background tasks: `task_list` (spans earlier sessions), `task_status`, `task_cancel`, `task_revive` (respawn a dead task with its original parameters), `task_send` (attach a note delivered with the completion — pi subagents have no live input channel). Results wake the parent session at agent boundaries. | — (bg task lifecycle) |
| `/work <goal>` | Arms a run-until-done loop: at each settle boundary injects a continue nudge until the agent emits `<sensei:done/>` (cap: 40 continuations). Respects user aborts/errors. `/work stop` disarms, bare `/work` shows status. | omo ultrawork |
| `create_goal`/`update_goal`/`get_goal` + `/goal` | Durable session goal that keeps the agent working at each settle boundary via hidden continuation prompts with completion/blocked audits (cap 8, stall check after 3 toolless turns). Persisted in `~/.sensei/goals/`; `/work` yields while a goal is active. | senpi goal (pi-goal) |
| `council` tool | Fans one question out to up to 4 councillor models in parallel via the model registry (pure advisors, no tools), then synthesizes one council pass over their answers. Seats from the `councillors` param or `SENSEI_COUNCIL_MODELS`. | omo multi-model council |
| `loop` tool + `/loop` | Durable recurring prompts: every N minutes or daily `HH:MM`, optional fire count, persisted per session (`~/.sensei/loops/`). TUI timers + settle-boundary catch-up. | senpi loop + schedule |
| `wait_for_user` tool | Ends the turn while waiting on an external human action; the next user message resumes normal continuation. Warns instead if background delegates are still outstanding. | omo wait-for-user |
| `todo` tool + `/todos` | Session task list: list/add/toggle/clear. | omo task tracking |

### Code understanding and retrieval

| Feature | What it does | Replaces |
|---|---|---|
| `ast_grep_search`/`ast_grep_replace` | AST-level structural search and rewrite, shelling out to the vendored `sg` binary. Capped at 500 matches / 1MB output. Resolution: `SENSEI_SG_PATH` → `sg` on `PATH` → the installed package. | omo ast-grep |
| `nestedagents` | When `read` returns a file, walks up from that directory to the project root and appends each not-yet-injected `AGENTS.md` to the tool result. Per-session injection cache, 32KB/file + 128KB/read caps, containment via realpath. `--no-nested-agents` to disable. | senpi nested-agents-md |
| `history_search` tool + `/history` | Fuzzy-search user prompts across all past sessions on this machine, recency-weighted. | senpi history-search |

### Network and perception

| Feature | What it does | Replaces |
|---|---|---|
| `webfetch` tool | Fetches a URL, strips HTML to readable text, 20s timeout, ~20k char cap. | omo smartfetch (lean) |
| `web_search` tool | Web search via Brave (`BRAVE_API_KEY`), Tavily (`TAVILY_API_KEY`), SearXNG (`SEARXNG_URL`), or DuckDuckGo (no key). `/websearch` shows the active chain. | senpi websearch (multi-provider) |
| `read_video` tool | Reads a local video into the conversation as a base64 payload (100MB cap). Active only when the model declares video input; rides an `ImageContent` block with a `video/*` mimeType. | senpi video-in |
| `look_at` tool | Delegates media analysis to a vision-capable model (`SENSEI_VISION_MODEL` or first available image-input model). Auto-activates only when the active model lacks image input. | senpi look-at |
| `/btw <question>` | Side question on the current conversation via `modelRegistry.streamSimple` — answered in parallel, never touches the session. Bare `/btw` cancels. | senpi btw |

### Stability guardrails

| Feature | What it does | Replaces |
|---|---|---|
| `loopguard` | Catches the agent spinning. Identical-loop reminders, a first-veto block, and a hard-stop abort/recover at 3 repeats; similar (0.85) and cyclic loops stay advisory. | senpi loop-guard |
| `bashtimeout` | Applies a default `timeout` to bash calls that omit one (1800s default and ceiling) and documents the policy in the system prompt. `SENSEI_BASH_DEFAULT_TIMEOUT_SECONDS` / `SENSEI_BASH_MAX_TIMEOUT_SECONDS`. | senpi bash-timeout |
| `jsonerror` | When a tool result contains a JSON parse error — usually the model emitting malformed arguments — appends an immediate-action reminder so the next turn fixes the syntax instead of repeating the bad call. | omo json-error-recovery |

### Configuration and context

| Feature | What it does | Replaces |
|---|---|---|
| rules engine + `/rules` | Static rules (`<agentDir>/rules/`, project `.sensei|.pi|.omo|.claude|.cursor/rules/`, `.github/instructions`, `copilot-instructions.md`) append to the system prompt; `globs:`/`paths:`/`alwaysApply:` frontmatter rules (cursor-compatible) activate on first matching tool result. `SENSEI_RULES_MODE=static|dynamic|both|off`. | senpi rules + rule-activation |
| `/preset <name>` | Session-scoped system-prompt fragment from `~/.sensei/presets/*.md` or `<project>/.sensei/presets/*.md`. Appended, never replaces — tool guidance can't be clobbered. `SENSEI_PRESET` preselects. | senpi prompt-preset |
| `banner` | TUI header: what this is on line 1, live run facts (host version, active model, project, agent dir) on line 2, command hints on line 3. `/banner` cycles sensei ↔ pi's own header. | — (sensei identity) |

Everything else stays stock pi: tools `read/bash/edit/write/grep/find/ls` + `codemode` and `tool_search` enabled via `settings.json`. Extensions are dependency-free (raw JSON-Schema params, no third-party imports) so they never break on host upgrades.

## Skills

| Skill | What it does |
|---|---|
| `codemap` | Hierarchical `codemap.md` generation for unfamiliar repos, with `.sensei/codemap.json` change detection. Subagent fan-out goes through the `delegate` tool. |
| `clonedeps` | Clone a dependency's source into an ignored local workspace so the agent can read library internals when docs aren't enough. |
| `deepwork` | High-cost main-agent workflow for large, high-risk, multi-phase efforts with review gates. |
| `verification-planning` | Plan a credible, project-specific evidence path before a non-trivial feature, fix, or refactor. |
| `simplify` | Reduce complexity for clarity without changing behavior. |
| `worktrees` | Manage git worktrees as isolated lanes for complex, risky, or parallel work. |
| `loop-engineering` | Structured retries with explicit success criteria (Grill + Monitor). |
| `reflect` | Review recent sessions for repeated patterns and propose reusable skills, commands, rules, or presets. |
| `sensei-config` | Tune models, role prompts, presets, rules, skills, tool allowlists, and delegate behavior. |

## Quickstart

```sh
sensei              # first run seeds ~/.sensei, then starts the TUI
sensei -p "..."     # print/headless mode
sensei --version    # smoke check
```

`models.json` ships empty — it's yours and is never overwritten by re-syncs. Add OpenAI-compatible endpoints like:

```jsonc
{
  "providers": {
    "myendpoint": {
      "baseUrl": "https://example.com/v1",
      "api": "openai-completions",
      "apiKey": "$MY_ENDPOINT_KEY", // env var name, not the key itself
      "models": [{ "id": "model-id" }]
    }
  }
}
```

## Maintenance model

- **Upgrade host**: bump the one version in `package.json`, `npm install --ignore-scripts`, `npm run smoke`, run a real session. That's the whole host contract — no rebasing anyone's fork.
- **Add features**: write an extension in `agent-template/extensions/` (or a skill/prompt). Never patch the host. If a capability can't be an extension, that's a signal to reconsider the feature, not to fork.
- **Re-seed**: `extensions/` and `skills/` re-sync on every launch (owned surfaces — upgrades propagate automatically); `settings.json`/`models.json`/prompts are yours and never clobbered. `SENSEI_AGENT_DIR=/path` overrides the dir. To reset: `rm -rf ~/.sensei`.
- **Port backlog** (from oh-my-openagent, on demand only): pick features you actually use; each lands as an extension, one at a time.

## Why not senpi / omo

senpi is code-yeongyu's fork of pi-mono; oh-my-openagent is a ~50-package orchestration monorepo on top. Instability reports (hook payload mutation, GPT degradation, config complexity) live in that orchestration layer. sensei keeps zero of it: pi upstream is the host, and every owned feature is a small auditable extension.
