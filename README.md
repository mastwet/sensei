# sensei

A stability-first, self-maintained coding agent. Built like `oh-my-opencode-slim` but the other way around: the host is someone else's maintained project, everything we own is a thin layer on top.

- **Host**: pinned `@earendil-works/pi-coding-agent` (upstream `badlogic/pi-mono`, NOT senpi). Never forked, never patched. The payload sent to providers is exactly what upstream pi sends — no hook-layer mutation, no cache busting.
- **Owned layer**: one agent dir seeded from `agent-template/` — settings, extensions, skills, prompts. Single config surface, a handful of knobs.
- **Isolation**: runs with `PI_CODING_AGENT_DIR=~/.sensei`. Never touches `~/.pi`, `~/.senpi`, or your other agent installs. Coexists with them.

## Architecture

```
sensei repo
├── bin/sensei.mjs        # wrapper: seeds agent dir, execs pinned pi with PI_CODING_AGENT_DIR
├── install.sh            # POSIX bootstrap: npm install --ignore-scripts && npm link
├── start.ps1             # Windows bootstrap + launch (same steps, plus smoke check)
├── agent-template/       # seeded to ~/.sensei on first run; your config+extensions live there after
│   ├── settings.json     # the only config file: few knobs
│   ├── models.json       # your compatible endpoints (empty by default — add your own)
│   ├── extensions/sensei/# owned extensions (tools/commands/hooks)
│   ├── skills/           # user skills (SKILL.md dirs)
│   └── prompts/          # prompt templates → /slash-commands
└── package.json          # pins the host version — the entire host contract
```

## Owned features (extensions/sensei)

| Feature | What it does | Replaces |
|---|---|---|
| banner | TUI header: what this is on line 1, live run facts (host version, active model, project, agent dir) on line 2, command hints on line 3. `/banner` cycles sensei ↔ pi's own header. | — (sensei identity) |
| `delegate` tool | Runs a self-contained subtask in a fresh headless pi subprocess (own session, same toolset, depth-capped at 2, timeout, 30k output cap). `task`, `cwd`, `model`, `timeoutSeconds`. | omo subagents/team-mode core value |
| `/work <goal>` | Arms a run-until-done loop: at each settle boundary injects a continue nudge until the agent emits `<sensei:done/>` (cap: 40 continuations). Respects user aborts/errors. `/work stop` disarms, bare `/work` shows status. | omo ultrawork |
| `todo` tool + `/todos` | Session task list: list/add/toggle/clear. | omo task tracking |
| `webfetch` tool | Fetches a URL, strips HTML to readable text, 20s timeout, ~20k char cap. | omo smartfetch (lean) |
| `web_search` tool | Web search via Brave (`BRAVE_API_KEY`), Tavily (`TAVILY_API_KEY`), SearXNG (`SEARXNG_URL`), or DuckDuckGo (no key). `/websearch` shows the active chain. | senpi websearch (multi-provider) |
| `history_search` tool + `/history` | Fuzzy-search user prompts across all past sessions on this machine, recency-weighted. | senpi history-search |
| `/btw <question>` | Side question on the current conversation via `modelRegistry.streamSimple` — answered in parallel, never touches the session. Bare `/btw` cancels. | senpi btw |
| `look_at` tool | Delegates media analysis to a vision-capable model (`SENSEI_VISION_MODEL` or first available image-input model). Auto-activates only when the active model lacks image input. | senpi look-at |
| rules engine + `/rules` | Static rules (`<agentDir>/rules/`, project `.sensei|.pi|.omo|.claude|.cursor/rules/`, `.github/instructions`, `copilot-instructions.md`) append to the system prompt; `globs:`/`paths:`/`alwaysApply:` frontmatter rules (cursor-compatible) activate on first matching tool result. `SENSEI_RULES_MODE=static|dynamic|both|off`. | senpi rules + rule-activation |
| `/preset <name>` | Session-scoped system-prompt fragment from `~/.sensei/presets/*.md` or `<project>/.sensei/presets/*.md`. Appended, never replaces — tool guidance can't be clobbered. `SENSEI_PRESET` preselects. | senpi prompt-preset |
| `loop` tool + `/loop` | Durable recurring prompts: every N minutes or daily `HH:MM`, optional fire count, persisted per session (`~/.sensei/loops/`). TUI timers + settle-boundary catch-up. | senpi loop + schedule |
| `create_goal`/`update_goal`/`get_goal` + `/goal` | Durable session goal that keeps the agent working at each settle boundary via hidden continuation prompts with completion/blocked audits (cap 8, stall check after 3 toolless turns). Persisted in `~/.sensei/goals/`; `/work` yields while a goal is active. | senpi goal (pi-goal) |

Skill: `codemap` (vendored from omo-slim, `node` stdlib only) — hierarchical `codemap.md` generation with `.sensei/codemap.json` change detection; subagent fan-out goes through the `delegate` tool.

Everything else stays stock pi: tools `read/bash/edit/write/grep/find/ls` + `codemode` and `tool_search` enabled via `settings.json`. Extensions are dependency-free (raw JSON-Schema params, no imports) so they never break on host upgrades.

## Quickstart

```sh
./install.sh        # npm install --ignore-scripts && npm link
sensei              # first run seeds ~/.sensei, then starts the TUI
sensei -p "..."     # print/headless mode
sensei --version    # smoke check
```

### Windows

`install.sh` is POSIX. On Windows use the bundled PowerShell entry point, which does
the same install/link steps plus a version smoke check, then hands the console to
the TUI:

```powershell
.\start.ps1                       # bootstrap + launch
.\start.ps1 -p "explain this repo" # args pass straight through to sensei
.\start.ps1 -NewWindow             # launch in a separate window (no TTY needed)
.\start.ps1 -SkipInstall -SkipLink # re-launch without reinstalling
```

If PowerShell blocks the script, either `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
once, or run it via `powershell.exe -ExecutionPolicy Bypass -File .\start.ps1`.

Requires Node >= 22.19. Auth is per sensei (`~/.sensei/auth.json`); run `sensei` once and log in, or set the provider env var (e.g. `OPENAI_API_KEY`).

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
