---
name: sensei-config
description: Configure and improve a sensei installation. Use when users want to tune models, role prompts, presets, rules, skills, tool allowlists, or delegate behavior. Also use when recurring workflow friction suggests a safe config or prompt improvement.
---

# sensei Configuration Skill

You help users configure, customize, and safely improve their sensei setup
(`~/.sensei`, seeded from the sensei repo's `agent-template/`).

The goal is not just to answer configuration questions. When useful, help the
user make their agent system better for future runs: tune models, adjust
role prompts, add focused rules or presets, enable or restrict tools, and
document restart requirements.

## When to Use

Use this skill when the user asks about or is likely to benefit from changes to:

- `~/.sensei/settings.json` — enabled/disabled host features (e.g. tool_search,
  codemode flags)
- `~/.sensei/models.json` — providers and models
- `~/.sensei/APPEND_SYSTEM.md` / `SYSTEM.md` — system prompt append or full
  replacement
- `~/.sensei/presets/` and project `.sensei/presets/` — named system-prompt
  presets selected via `/preset`
- `~/.sensei/rules/` and project rules dirs — static and glob-activated rules
- `~/.sensei/roles/<role>.md` / `<role>_append.md` — per-delegate-role prompt
  overrides (see below)
- `~/.sensei/skills/` — user skills (a same-named directory here shadows the
  bundled skill)
- `SENSEI_*` environment variables (see below)
- recurring workflow friction that could be fixed by a prompt/config change

Also use it proactively, with restraint, when a session reveals a repeatable
improvement opportunity. Example: if the user repeatedly asks the same role to
follow a project-specific rule, suggest adding it to a role append file or a
rules file.

## Layout Notes

- `~/.sensei/extensions/` and the bundled `~/.sensei/skills/` are **re-synced
  from the sensei repo on every launch** — edits there are lost. User
  customization lives in the files above, which are never overwritten.
- To change extension behavior itself, edit `agent-template/` in the sensei
  repo, not the live `~/.sensei/` copy.

## What Is Configurable

| Surface | File / env | Effect |
|---|---|---|
| Providers & models | `~/.sensei/models.json` | Register providers (baseUrl, apiKey env, model list) |
| Host feature flags | `~/.sensei/settings.json` | e.g. `tools`, `codemode` toggles |
| System prompt | `APPEND_SYSTEM.md` (append) or `SYSTEM.md` (replace) | Global agent instructions |
| Presets | `~/.sensei/presets/<name>.md` | `/preset <name>` applies a named prompt block |
| Rules | `~/.sensei/rules/*.md`, `paths:` frontmatter for glob activation | Static or file-type-triggered instructions |
| Role prompts | `~/.sensei/roles/<role>.md` full replace, `<role>_append.md` append | Per-role system prompt for `delegate(role)` — explorer, librarian, oracle, designer, fixer, observer |
| Env knobs | `SENSEI_COUNCIL_MODELS` (comma list `provider/model`), `SENSEI_WEBFETCH`, `SENSEI_BASH_DEFAULT/MAX_TIMEOUT_SECONDS`, `SENSEI_VISION_MODEL`, `SENSEI_SG_PATH`, `SENSEI_AGENT_DIR` | Feature configuration |

Common customizations:

- **Tune models per call**: `delegate` accepts a `model` param;
  `SENSEI_COUNCIL_MODELS` picks council seats.
- **Tune a role prompt**: prefer `~/.sensei/roles/<role>_append.md` for small
  behavior additions; use `<role>.md` only to replace the bundled prompt
  entirely (must restate essential constraints).
- **Gate tools**: pi `--tools`/`--exclude-tools` per launch, or role tool
  allowlists inside `roles.ts` (repo edit).
- **Add project rules**: `<repo>/AGENTS.md`, rules dir with `paths:` globs.

## Safe Improvement Rules

Configuration changes affect future agent behavior, so treat them as user-owned.

1. **Ask before changing config or prompts.**
   - Explain the proposed improvement briefly.
   - State which file would change.
   - Ask for confirmation unless the user explicitly requested the exact edit.
2. **Prefer narrow changes.**
   - Do not rewrite large prompts when a small rule solves the problem.
   - Do not add custom roles for one-off tasks.
3. **Preserve existing user settings.**
   - Merge with current config rather than regenerating from scratch.
4. **Avoid hidden behavior changes.**
   - Mention cost, permissions, or delegation changes before applying them.
   - Be explicit if a model/provider change may increase spend.
5. **Tell the user about restart requirements.**
   - `extensions/`/`skills/` re-sync and most config loads on the next sensei
     launch.
   - Phrase it as: "This applies on the next sensei launch; restart sensei if
     you need it immediately."

## Configuration Workflow

When making or proposing changes:

1. **Inspect current setup** — read `~/.sensei/settings.json`,
   `~/.sensei/models.json`, relevant rules/preset/role files.
2. **Decide the smallest useful change** — model tuning, a rule file, a role
   append, a preset, or an env var.
3. **Ask for confirmation** — show a concise proposal with the target path.
4. **Apply the edit carefully** — preserve unrelated settings; keep files valid.
5. **Validate** — ensure JSON parses and files land in the right location.
6. **Explain activation** — what applies immediately vs. next launch.

## Prompt Tuning Pattern

Prompt edits are best for recurring behavior that should happen across many
sessions.

Good reasons to tune a prompt:

- The main agent repeatedly delegates too much or too little for this user's
  workflow (→ `APPEND_SYSTEM.md` or a rules file).
- A specialist role repeatedly misses a project convention (→ role append).
- The user wants a stable communication or verification style (→ rules file).

Poor reasons to tune a prompt:

- A one-off task failed once.
- The current problem can be solved by normal instruction in this session.
- The change would make the agent worse for general use.

When suggesting a prompt improvement, say:

```text
I noticed this is recurring. I can add a small rule to <file> so
future runs handle it automatically. Want me to make that change?
```

## Final Checklist

- [ ] Did the user confirm config/prompt edits, unless explicitly requested?
- [ ] Did the edit preserve existing settings?
- [ ] Is the file in a user-owned location (not under `extensions/` or bundled
  `skills/`, which get re-synced)?
- [ ] Did you mention the next-launch/restart behavior?
