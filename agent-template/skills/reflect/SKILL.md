---
name: reflect
description: Review recent work, find repeated workflow patterns, and suggest reusable skills, commands, rules, presets, config changes, or playbooks. Use when the user asks to learn from past sessions, improve recurring workflows, or identify what should be turned into reusable agent instructions.
---

# Reflect

Reflect is a main-agent workflow for learning from repeated work. It
looks back over recent sessions, project notes, and existing agent assets, then
recommends the smallest useful improvement: a skill, command, rule file, preset,
configuration change, prompt rule, documentation playbook, or no change.

The goal is to identify real repeated friction and suggest practical improvements with evidence.

## When to Use

Use Reflect when the user asks to:

- run `/reflect` or `/reflect <focus>`;
- run `/reflect --sessions` for session archaeology;
- learn from recent sessions or repeated workflows;
- find work they keep doing manually;
- improve their sensei setup based on actual usage;
- review whether a recurring process should become a reusable playbook;
- turn repeated workflow friction into a safer future default.

Do not use Reflect for ordinary implementation work, one-off debugging, broad
architecture review, or speculative agent creation without workflow evidence.

## Session Mode

When the user includes `--sessions` in their reflect command, shift to session
archaeology: analyze historical sensei sessions across all repos to find
repeated patterns, friction, and improvement opportunities.

### Session Discovery

1. **List recent session files** — sensei stores sessions as JSONL under
   `~/.sensei/sessions/<cwd-slug>/<ISO-timestamp>_<id>.jsonl`:
   ```bash
   find ~/.sensei/sessions -name '*.jsonl' -printf '%T@ %p\n' | sort -rn | head -50
   ```
   Adjust `50` to `--last N` if specified. The `<cwd-slug>` directory encodes the
   working directory each session ran in.

2. **Load session messages** — each line is one JSON record; user/assistant
   content lives in `{"type":"message","message":{"role","content":[...]}}`:
   ```bash
   jq -r 'select(.type=="message") | .message.role' <session-file>
   ```

3. **Search across sessions** — prefer the `history_search` tool for targeted
   lookups (e.g. `history_search` with a friction-related query) instead of
   reading every file.

### Per-Session Analysis

For each session, analyze and produce a structured summary:

```json
{
  "session": "2026-06-10T15-08-45_abc123",
  "project": "/home/user/projects/example",
  "timestamp": "2026-06-10T15:08:45.427Z",
  "goal": "Fix CI failure",
  "success": true,
  "frictions": [
    "Repeated grep to find test file",
    "Three failed test runs before passing"
  ],
  "recommendations": [
    "Create a /test-ci prompt template"
  ],
  "duration_minutes": 18,
  "models_used": ["provider/model-id"],
  "tools_used": ["read", "edit", "bash"],
  "confidence": 0.85
}
```

**Confidence scoring:**
- 0.9-1.0: Clear success/failure, obvious patterns
- 0.7-0.9: Likely outcome, patterns inferred from tool usage
- 0.5-0.7: Uncertain outcome, limited evidence
- <0.5: Skip or mark as "needs more evidence"

### Storage and Caching

Store session summaries in `~/.sensei/reflections/sessions/`.

**Cache logic:**
1. Check if `<session-file-stem>.json` exists in reflections directory
2. If yes, load it (saves tokens)
3. If no, analyze session and save summary
4. Aggregate across all summaries for final report

### Aggregation

After analyzing all sessions, aggregate findings:

1. **Group by theme** - sessions with similar frictions cluster together
2. **Count frequency** - "42/50 sessions had repeated grep before editing"
3. **Rank by impact** - prioritize recommendations that appear most often
4. **Filter noise** - skip one-off issues, focus on repeated patterns
5. **Cross-reference** - see if patterns correlate with specific models or repos

**Scope categories:**
- **Global** - applies to all repos (pattern seen in >50% of repos)
- **Cross-repo** - applies to specific repos where pattern appears
- **Project-specific** - only relevant to one repo

### Output Format

Return a compact report with scope and confidence:

```text
Session Reflection Report
Analyzing 50 most recent sessions across 8 repos.

Repos analyzed:
- <repo> (<N> sessions)
- ... (M more)

Findings
- <pattern>: N/50 sessions across M repos.
  - Scope: global | cross-repo (<repos>) | project-specific (<repo>)
  - Confidence: 0.95
  - Impact: High | Medium | Low

Recommended changes
- <asset>: <purpose>
  - Scope: global | cross-repo (<repos>) | project-specific (<repo>)
  - Confidence: 0.97
  - Estimated time saved: High | Medium | Low

Skipped
- <candidate>: why not worth packaging now.
  - Scope: <reason>
  - Confidence: <score>

Needs more evidence
- <candidate>: what would make it actionable.
  - Current scope: <what we've seen>
  - Required scope: <what would confirm>
```

### Error Handling

**Session directory issues:**
- `~/.sensei/sessions` doesn't exist → "No sensei sessions found. Run sensei in at least one repo first."
- Directory is empty → "No sensei sessions to analyze."

**Session loading issues:**
- Session file not loadable → Skip with warning: "Session <id> could not be loaded, skipping."
- Session has no messages → Skip: "Session <id> has no messages."

**Recovery pattern:**
- Log the failure
- Continue with remaining sessions
- Report failures at end: "3 sessions skipped due to load errors"

## Core Contract

Reflect must be conservative and evidence-driven.

Required behavior:

- inspect existing assets before suggesting new ones;
- prefer recent, repeated, user-visible friction over isolated incidents;
- recommend the smallest useful form;
- treat "create nothing" as a successful result when evidence is weak;
- ask before changing prompts, skills, commands, rules, or config;
- avoid duplicating existing assets;
- explain restart requirements for settings, prompt, skill, rule, or
  extension changes.

## Evidence Sources

Use available evidence in this order:

1. Current conversation and explicit user instructions.
2. Project-local guidance and memories, such as `AGENTS.md`, `.sensei/`,
   notes, checkpoints, task progress files, and codemaps.
3. Existing skills, commands, rules, prompt templates, and presets.
4. Recent sensei sessions (`~/.sensei/sessions/`) and `history_search` results
   if they are available and safe to inspect.
5. External docs only when a proposed workflow depends on a third-party tool or
   library whose behavior needs confirmation.

Respect privacy and safety boundaries. Do not inspect unrelated personal files,
credentials, private messages, or external accounts unless the user explicitly
asks and the workflow requires it.

## Workflow

Reflect can be triggered directly:

```text
/reflect
/reflect release workflow and checks
/reflect --sessions
/reflect --sessions --last 100
```

With no arguments, review recent work broadly. With arguments, focus the review
on that workflow area while still checking whether existing assets already cover
it.

### 1. Inventory Existing Assets

Before proposing anything, identify what already exists:

- bundled and user-installed skills (`~/.sensei/skills/`, `<repo>/.sensei/`);
- registered commands (`/sensei` lists the loaded feature set);
- rules (`~/.sensei/rules/`, project rules dirs);
- presets (`~/.sensei/presets/`, `<repo>/.sensei/presets/`);
- prompt templates and `APPEND_SYSTEM.md` / `SYSTEM.md` overrides;
- `settings.json` tool allowlists and `models.json` providers;
- project playbooks, docs, codemaps, and local workflow notes.

If an existing asset already covers the candidate, recommend extending or using
that asset instead of creating a near-duplicate.

### 2. Find Repeated Workflow Patterns

Look for repeated signals such as:

- the same command sequence appears across sessions;
- the user repeatedly asks for the same review, setup, release, or debugging
  process;
- the same manual research or context-gathering steps keep recurring;
- the same delegate-role routing decision is repeatedly needed;
- the same project-specific rule is repeatedly re-explained;
- repeated failures happen because an agent lacks a stable instruction, tool, or
  permission boundary.

Strong candidates usually have at least two occurrences, stable inputs, a clear
output, and a clear stopping condition.

### 3. Score Candidates

For each candidate, decide:

- **Frequency:** How often has it happened?
- **Cost:** Does it waste meaningful time, context, money, or attention?
- **Risk:** Does inconsistent execution cause bugs, regressions, bad decisions,
  or unsafe changes?
- **Stability:** Are the inputs and desired output predictable?
- **Coverage:** Is there already an asset that handles it well?

Only recommend creating or changing assets when confidence is high.

### 4. Choose the Smallest Useful Form

Pick the least powerful form that solves the repeated problem:

- **Rule/prompt snippet:** a small behavior change via a rules file or
  `APPEND_SYSTEM.md`.
- **Skill:** reusable workflow guidance for a task shape.
- **Command:** a repeatable manual trigger with stable inputs.
- **Preset:** a reusable system-prompt preset for a recurring working mode.
- **Config change:** a settings/tools/models adjustment for the agent dir.
- **Project playbook/doc:** human-readable process guidance when automation is too
  heavy.
- **Skip:** weak, one-off, ambiguous, sensitive, or already-covered work.

Avoid creating new extensions when a rule or skill is enough. Avoid skills
when a short project playbook is enough. Avoid config changes when the benefit is
unclear.

### 5. Propose Before Changing

Unless the user explicitly requested a specific edit, present a concise proposal
before writing files or changing config:

```text
Found 2 strong repeated workflows and 1 weak candidate.

Recommended:
- Add a small rule file for <workflow> because <evidence>.
- Extend existing <skill> instead of creating a new one because <overlap>.

Skip:
- <candidate> because it only appeared once.

Proceed with the proposed edits?
```

When applying changes, preserve existing user settings and prefer narrow,
append-only edits.

## Output Format

Return a compact report:

```text
Findings
- <workflow>: evidence, frequency/confidence, recommended form.

Recommended changes
- <asset/config/doc>: one-line purpose and why this is the smallest useful form.

Skipped
- <candidate>: why not worth packaging now.

Needs more evidence
- <candidate>: what would make it actionable.
```

If nothing qualifies, say:

```text
No strong repeated workflow found. I would not add or change any reusable assets
yet.
```

## Guardrails

- Do not manufacture assets to justify the workflow.
- Do not create overlapping skills or rules.
- Do not silently change global config, prompts, or permissions.
- Do not add broad instructions that make agents more eager, expensive, or
  invasive without a clear benefit.
- Do not overfit to a single session unless the user explicitly asks for that
  exact reusable workflow.
- Do not use private or sensitive material as examples in generated assets.
- When extension, skill, settings, prompt, or rule files change, tell the user:
  "This applies on the next sensei launch; restart sensei if you need it
  immediately."
