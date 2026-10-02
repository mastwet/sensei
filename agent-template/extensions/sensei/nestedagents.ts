// nestedagents — port of senpi builtin `nested-agents-md/` (vendored pi-nested-agents-md).
// When the `read` tool returns a file, walk UP from that file's directory to the
// project root and append each not-yet-injected AGENTS.md to the tool result.
// Per-session injection cache, 32KB/file + 128KB/read caps, containment via realpath.
// Disable with --no-nested-agents.

import { constants, promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const DEFAULT_FILE_NAMES = ["AGENTS.md"];
const MAX_BYTES_PER_FILE = 32 * 1024;
const MAX_BYTES_PER_READ = 128 * 1024;

class InjectionCache {
  private readonly sessions = new Map<string, Set<string>>();
  has(sessionKey: string, dir: string): boolean {
    return this.sessions.get(sessionKey)?.has(dir) ?? false;
  }
  mark(sessionKey: string, dir: string): void {
    let set = this.sessions.get(sessionKey);
    if (!set) {
      set = new Set();
      this.sessions.set(sessionKey, set);
    }
    set.add(dir);
  }
  list(sessionKey: string): string[] {
    return Array.from(this.sessions.get(sessionKey) ?? []);
  }
  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isWithinRoot(rootDir: string, candidate: string): boolean {
  const rel = relative(rootDir, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolveAndContain(filePath: string, rootDir: string): Promise<{ canonicalPath: string; canonicalRoot: string } | null> {
  if (!filePath) return null;
  const resolved = isAbsolute(filePath) ? filePath : resolve(rootDir, filePath);
  let canonicalRoot: string;
  let canonicalPath: string;
  try {
    canonicalRoot = await fs.realpath(rootDir);
    canonicalPath = await fs.realpath(resolved);
  } catch {
    return null;
  }
  if (canonicalPath === canonicalRoot) return null;
  const boundary = canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep;
  if (!canonicalPath.startsWith(boundary)) return null;
  return { canonicalPath, canonicalRoot };
}

async function findAgentsMdUp(startDir: string, rootDir: string): Promise<string[]> {
  const collected: string[] = [];
  let current = startDir;
  while (true) {
    const isRoot = current === rootDir;
    if (!isRoot) {
      for (const name of DEFAULT_FILE_NAMES) {
        const candidate = join(current, name);
        if (await fileExists(candidate)) {
          collected.push(candidate);
          break;
        }
      }
    }
    if (isRoot) break;
    const parent = dirname(current);
    if (parent === current || !isWithinRoot(rootDir, parent)) break;
    current = parent;
  }
  return collected.reverse();
}

function truncateBytes(content: string, maxBytes: number): { result: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength <= maxBytes) return { result: content, truncated: false };
  let decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, maxBytes));
  while (decoded.endsWith("")) decoded = decoded.slice(0, -1);
  return { result: decoded, truncated: true };
}

function formatDirectoryContext(absolutePath: string, content: string, truncated: boolean): string {
  const notice = truncated
    ? `\n\n[Note: Content was truncated to save context window space. For full context, please read the file directly: ${absolutePath}]`
    : "";
  return `\n\n[Directory Context: ${absolutePath}]\n${content}${notice}`;
}

function sessionKey(ctx: any): string {
  return ctx.sessionManager?.getSessionFile?.() ?? "__sensei_nested_agents_singleton__";
}

export default function (pi: any): void {
  pi.registerFlag?.("no-nested-agents", {
    description: "Disable nested AGENTS.md context injection.",
    type: "boolean",
    default: false,
  });

  const cache = new InjectionCache();
  let disabled = false;

  pi.on("session_start", async () => {
    disabled = pi.getFlag?.("no-nested-agents") === true;
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    if (disabled) return undefined;
    if (event.toolName !== "read" || event.isError) return undefined;
    const filePath = event.input?.path;
    if (typeof filePath !== "string" || filePath.length === 0) return undefined;
    if (!event.content?.some((b: any) => b.type === "text")) return undefined;

    const key = sessionKey(ctx);
    const contained = await resolveAndContain(filePath, ctx.cwd);
    if (!contained) return undefined;

    const candidates = await findAgentsMdUp(dirname(contained.canonicalPath), contained.canonicalRoot);
    let injectedText = "";
    let budget = MAX_BYTES_PER_READ;

    for (const agentsPath of candidates) {
      const agentsDir = dirname(agentsPath);
      if (cache.has(key, agentsDir)) continue;
      if (budget <= 0) break;
      let content: string;
      try {
        content = await fs.readFile(agentsPath, "utf-8");
      } catch {
        continue;
      }
      const { result, truncated } = truncateBytes(content, Math.min(MAX_BYTES_PER_FILE, budget));
      injectedText += formatDirectoryContext(agentsPath, result, truncated);
      cache.mark(key, agentsDir);
      budget -= new TextEncoder().encode(result).byteLength;
    }

    if (!injectedText) return undefined;
    return { content: [...event.content, { type: "text", text: injectedText }] };
  });

  pi.on("session_compact", async (event: any, ctx: any) => {
    if (!event.accepted) return;
    cache.clearSession(sessionKey(ctx));
  });
  pi.on("session_shutdown", async (_e: any, ctx: any) => {
    cache.clearSession(sessionKey(ctx));
  });

  pi.registerCommand("nested-agents", {
    description: "Show which nested AGENTS.md files have been injected this session.",
    handler: async (_args: any, ctx: any) => {
      const files = cache.list(sessionKey(ctx));
      ctx.ui.notify(
        files.length ? `Nested AGENTS.md injected:\n${files.join("\n")}` : "No nested AGENTS.md injected yet",
        "info",
      );
    },
  });
}
