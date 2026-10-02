// bashtimeout — port of senpi builtin `bash-timeout/`.
// Applies a default `timeout` to bash tool calls that omit it, and appends the
// timeout policy section to the system prompt so the model knows the contract.
// Env: SENSEI_BASH_DEFAULT_TIMEOUT_SECONDS, SENSEI_BASH_MAX_TIMEOUT_SECONDS.

const BASH_DEFAULT_TIMEOUT_SECONDS = 1800;
const BASH_MAX_TIMEOUT_SECONDS = 1800;

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveDefaults(): { defaultSeconds: number; maxSeconds: number } {
  const env = process.env;
  const defaultSeconds = parsePositiveInt(env.SENSEI_BASH_DEFAULT_TIMEOUT_SECONDS) ?? BASH_DEFAULT_TIMEOUT_SECONDS;
  const rawMax = parsePositiveInt(env.SENSEI_BASH_MAX_TIMEOUT_SECONDS) ?? BASH_MAX_TIMEOUT_SECONDS;
  return { defaultSeconds, maxSeconds: Math.max(rawMax, defaultSeconds) };
}

function buildTimeoutPrompt(defaults: { defaultSeconds: number; maxSeconds: number }): string {
  const minutes = (s: number): string => (s % 60 === 0 ? `${s / 60} min` : `${s}s`);
  return `\n## Bash Tool Timeout Policy\n\nThe \`bash\` tool's \`timeout\` parameter is the process kill deadline, not how long you wait for output: the command is killed when it reaches the deadline.\n\n- Default timeout: ${defaults.defaultSeconds}s (${minutes(defaults.defaultSeconds)}). Applied automatically when you do not set \`timeout\`.\n- Recommended maximum timeout: ${defaults.maxSeconds}s (${minutes(defaults.maxSeconds)}). Explicit \`timeout\` values are preserved because different hosts may use different timeout units.`;
}

export default function (pi: any): void {
  const defaults = resolveDefaults();

  pi.on("tool_call", (event: any) => {
    if (event.toolName !== "bash") return undefined;
    const input = event.input as { timeout?: number };
    if (input.timeout === undefined || input.timeout <= 0) {
      input.timeout = defaults.defaultSeconds;
    }
    return undefined;
  });

  pi.on("before_agent_start", (event: any) => {
    return { systemPrompt: `${event.systemPrompt}${buildTimeoutPrompt(defaults)}` };
  });
}
