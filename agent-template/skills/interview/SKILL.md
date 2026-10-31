---
name: interview
description: Use when a user requests a requirements interview, product discovery, specification clarification, or continuation of an unfinished requirements discussion in Sensei on Pi.
---

# Interview on Pi

Start with `/skill:interview <topic>`. This is a main-agent conversation:
use ordinary Pi messages, the next user turn, and native session history.
The deliverable is a specification the user can confirm, not product code.

## Establish the starting point

Run outside automatic continuation. If `/work` or a goal is active, tell
the user to run `/work stop` or `/goal pause` before proceeding. A question
in prose does not suspend those mechanisms. Do not mark a goal complete
just to silence continuation.

Read the relevant existing brief and project instructions. State the known
goal and constraints briefly. Reference existing documents rather than
repeating an interview when the answers are already recorded.

## Ask one decision at a time

Ask the single unanswered question that most changes the specification,
then end the turn and wait for the user's reply. Even the opening question
covers one decision: the intended user, the input, and the result are
separate questions. Use the user's language and concrete examples.

Choose questions from observed gaps: intended user, useful outcome, main
flow, scope, constraints, failure behavior and observable acceptance.
Skip categories already settled. Start open-ended; offer a few choices
when they make an actual decision easier, leaving room for another answer.
Separate user-confirmed facts, agent proposals and open questions.

"Skip" leaves an item open. "Finish" ends requirements questions and produces a draft.
Cancellation stops the interview without implementation. Missing answers
remain unknown; ending the interview does not approve the specification.

## Produce a reviewable specification

Use only the sections the work needs:

- Goal and intended users.
- Confirmed flows, scope and exclusions.
- Constraints and important failure behavior.
- Observable acceptance checks.
- Proposals and open questions, with consequences if unresolved.

Show the draft and ask whether it captures the user's intent; this is review
of the draft, not another requirements round. When the user requests saving
or editing a named project document, use that agreed path, preferring its existing
brief/specification document. Preserve unrelated content and identify the
changes. If the destination is unknown, ask before creating a new file.
Report draft/confirmed/saved status accurately.

After compaction or reopening, recover from Pi history and the referenced
project specification. Summarize what is confirmed and still open, then
ask the next missing question. Apply requested changes without reopening
unaffected decisions. If history is unavailable, say what is missing.

Use Pi's existing file tools for requested document edits. No server,
browser dashboard, task manager, private state store or automatic recovery
hook is installed. Begin implementation only on a separate user instruction.
