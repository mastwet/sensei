// jsonerror — port of omo-slim hooks/json-error-recovery.
// When a tool result contains a JSON parse error (usually the model emitting
// malformed arguments upstream), append an immediate-action reminder so the
// next turn fixes the syntax instead of repeating the same bad call.

const EXCLUDED_TOOLS = new Set(["bash", "read", "find", "ls", "webfetch"]);

const JSON_ERROR_PATTERNS = [
  /json parse error/i,
  /failed to parse json/i,
  /invalid json/i,
  /malformed json/i,
  /unexpected end of json input/i,
  /syntaxerror:\s*unexpected token.*json/i,
  /json[^\n]*expected '\}'/i,
  /json[^\n]*unexpected eof/i,
];

const MARKER = "[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]";

const REMINDER = `
[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]

You sent invalid JSON arguments. The system could not parse your tool call.
STOP and do this NOW:

1. LOOK at the error message above to see what was expected vs what you sent.
2. CORRECT your JSON syntax (missing braces, unescaped quotes, trailing commas, etc).
3. RETRY the tool call with valid JSON.

DO NOT repeat the exact same invalid call.
`;

export default function jsonerror(pi: any): void {
  pi.on("tool_result", (event: any) => {
    if (EXCLUDED_TOOLS.has(String(event.toolName ?? "").toLowerCase())) return;
    const parts = event.content;
    if (!Array.isArray(parts)) return;
    const text = parts
      .filter((p: any) => p?.type === "text")
      .map((p: any) => String(p.text ?? ""))
      .join("\n");
    if (!text || text.includes(MARKER)) return;
    if (JSON_ERROR_PATTERNS.some((re) => re.test(text))) {
      parts.push({ type: "text", text: REMINDER });
    }
  });
}
