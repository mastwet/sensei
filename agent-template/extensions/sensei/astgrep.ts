// astgrep — port of omo-slim `tools/ast-grep` (search + replace), dependency-free.
// Shells out to the ast-grep `sg` binary. Resolution: SENSEI_SG_PATH →
// `sg` on PATH → <host package>/node_modules/@ast-grep/cli/sg (installed by
// `npm install` in the sensei repo; the launcher exports SENSEI_SG_PATH).
// slim's auto-downloader is intentionally not ported (supply chain).

import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_MATCHES = 500;

const CLI_LANGUAGES = [
  "bash", "c", "cpp", "csharp", "css", "elixir", "go", "haskell", "html", "java",
  "javascript", "json", "kotlin", "lua", "nix", "php", "python", "ruby", "rust",
  "scala", "solidity", "swift", "typescript", "tsx", "yaml",
] as const;

interface CliMatch {
  file: string;
  range: { start: { line: number; column: number }; end: { line: number; column: number } };
  lines: string;
  text: string;
  replacement?: string;
  language: string;
}

interface SgResult {
  matches: CliMatch[];
  totalMatches: number;
  truncated: boolean;
  truncatedReason?: "timeout" | "max_output_bytes" | "max_matches";
  error?: string;
}

function onPath(cmd: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(":");
  for (const dir of dirs) {
    const p = `${dir}/${cmd}`;
    try {
      if (existsSync(p) && statSync(p).size > 10_000) return p;
    } catch {}
  }
  return undefined;
}

function findSg(): string | undefined {
  const env = process.env.SENSEI_SG_PATH;
  if (env && existsSync(env)) return env;
  return onPath(process.platform === "win32" ? "sg.exe" : "sg");
}

interface RunOptions {
  pattern: string;
  lang: string;
  paths?: string[];
  globs?: string[];
  rewrite?: string;
  context?: number;
  updateAll?: boolean;
}

async function runSg(options: RunOptions): Promise<SgResult> {
  const sg = findSg();
  if (!sg) {
    return {
      matches: [],
      totalMatches: 0,
      truncated: false,
      error:
        "ast-grep CLI binary not found.\n\n" +
        "Install options:\n" +
        "  npm install @ast-grep/cli (in the sensei repo — the launcher picks it up automatically)\n" +
        "  cargo install ast-grep --locked\n" +
        "  brew install ast-grep",
    };
  }

  const args = ["run", "-p", options.pattern, "--lang", options.lang, "--json=compact"];
  if (options.rewrite) {
    args.push("-r", options.rewrite);
    if (options.updateAll) args.push("--update-all");
  }
  if (options.context && options.context > 0) args.push("-C", String(options.context));
  if (options.globs) for (const g of options.globs) args.push("--globs", g);
  args.push(...(options.paths && options.paths.length > 0 ? options.paths : ["."]));

  const proc = spawn(sg, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => {
    stdout += d;
    if (stdout.length > MAX_OUTPUT_BYTES) proc.kill("SIGTERM");
  });
  proc.stderr.on("data", (d) => (stderr += d));

  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve(-1);
    }, DEFAULT_TIMEOUT_MS);
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(-2);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  if (exitCode === -1) {
    return { matches: [], totalMatches: 0, truncated: true, truncatedReason: "timeout", error: `Search timeout after ${DEFAULT_TIMEOUT_MS}ms` };
  }
  if (exitCode === -2) {
    return { matches: [], totalMatches: 0, truncated: false, error: `Failed to spawn ast-grep` };
  }
  if (exitCode !== 0 && stdout.trim() === "") {
    if (stderr.includes("No files found")) return { matches: [], totalMatches: 0, truncated: false };
    if (stderr.trim()) return { matches: [], totalMatches: 0, truncated: false, error: stderr.trim() };
    return { matches: [], totalMatches: 0, truncated: false };
  }
  if (!stdout.trim()) return { matches: [], totalMatches: 0, truncated: false };

  const outputTruncated = stdout.length >= MAX_OUTPUT_BYTES;
  const outputToProcess = outputTruncated ? stdout.substring(0, MAX_OUTPUT_BYTES) : stdout;

  let matches: CliMatch[] = [];
  try {
    matches = JSON.parse(outputToProcess) as CliMatch[];
  } catch {
    if (outputTruncated) {
      try {
        const lastValidIndex = outputToProcess.lastIndexOf("}");
        if (lastValidIndex > 0) {
          const bracketIndex = outputToProcess.lastIndexOf("},", lastValidIndex);
          if (bracketIndex > 0) {
            matches = JSON.parse(`${outputToProcess.substring(0, bracketIndex + 1)}]`) as CliMatch[];
          }
        }
      } catch {
        return { matches: [], totalMatches: 0, truncated: true, truncatedReason: "max_output_bytes", error: "Output too large and could not be parsed" };
      }
    } else {
      return { matches: [], totalMatches: 0, truncated: false };
    }
  }

  const totalMatches = matches.length;
  const matchesTruncated = totalMatches > MAX_MATCHES;
  return {
    matches: matchesTruncated ? matches.slice(0, MAX_MATCHES) : matches,
    totalMatches,
    truncated: outputTruncated || matchesTruncated,
    truncatedReason: outputTruncated ? "max_output_bytes" : matchesTruncated ? "max_matches" : undefined,
  };
}

function formatSearchResult(result: SgResult): string {
  if (result.error) return `Error: ${result.error}`;
  if (result.matches.length === 0) return "No matches found.";
  const lines: string[] = [];
  const byFile = new Map<string, CliMatch[]>();
  for (const m of result.matches) {
    const existing = byFile.get(m.file) || [];
    existing.push(m);
    byFile.set(m.file, existing);
  }
  for (const [file, matches] of byFile) {
    lines.push(`\n${file}:`);
    for (const m of matches) {
      const startLine = m.range.start.line + 1;
      const text = m.text.length > 100 ? `${m.text.substring(0, 100)}...` : m.text;
      lines.push(`  ${startLine}: ${text.replace(/\n/g, "\\n")}`);
    }
  }
  const summary = `Found ${result.totalMatches} matches in ${byFile.size} files`;
  lines.push(`\n${summary}${result.truncated ? ` (output truncated: ${result.truncatedReason})` : ""}`);
  return lines.join("\n");
}

function formatReplaceResult(result: SgResult, isDryRun: boolean): string {
  if (result.error) return `Error: ${result.error}`;
  if (result.matches.length === 0) return "No matches found for replacement.";
  const lines: string[] = [];
  const mode = isDryRun ? "[DRY RUN]" : "[APPLIED]";
  const byFile = new Map<string, CliMatch[]>();
  for (const m of result.matches) {
    const existing = byFile.get(m.file) || [];
    existing.push(m);
    byFile.set(m.file, existing);
  }
  for (const [file, matches] of byFile) {
    lines.push(`\n${file}:`);
    for (const m of matches) {
      const startLine = m.range.start.line + 1;
      const original = m.text.length > 60 ? `${m.text.substring(0, 60)}...` : m.text;
      const replacement = m.replacement
        ? m.replacement.length > 60
          ? `${m.replacement.substring(0, 60)}...`
          : m.replacement
        : "[no replacement]";
      lines.push(`  ${startLine}: "${original.replace(/\n/g, "\\n")}" → "${replacement.replace(/\n/g, "\\n")}"`);
    }
  }
  lines.push(`\n${mode} ${result.totalMatches} replacements in ${byFile.size} files`);
  if (isDryRun) lines.push("\nTo apply changes, run with dryRun=false");
  return lines.join("\n");
}

function getEmptyResultHint(pattern: string, lang: string): string | null {
  const src = pattern.trim();
  if (lang === "python") {
    if (src.startsWith("class ") && src.endsWith(":")) return `Hint: Remove trailing colon. Try: "${src.slice(0, -1)}"`;
    if ((src.startsWith("def ") || src.startsWith("async def ")) && src.endsWith(":"))
      return `Hint: Remove trailing colon. Try: "${src.slice(0, -1)}"`;
  }
  if (["javascript", "typescript", "tsx"].includes(lang)) {
    if (/^(export\s+)?(async\s+)?function\s+\$[A-Z_]+\s*$/i.test(src))
      return `Hint: Function patterns need params and body. Try "function $NAME($$$) { $$$ }"`;
  }
  return null;
}

const langSchema = { type: "string", enum: [...CLI_LANGUAGES], description: "Target language" };

export default function (pi: any): void {
  pi.registerTool({
    name: "ast_grep_search",
    label: "AST Grep Search",
    description:
      "Search code patterns across filesystem using AST-aware matching. Supports 25 languages. " +
      "Use meta-variables: $VAR (single node), $$$ (multiple nodes). " +
      "IMPORTANT: Patterns must be complete AST nodes (valid code). " +
      "For functions, include params and body: 'export async function $NAME($$$) { $$$ }' not 'export async function $NAME'. " +
      "Examples: 'console.log($MSG)', 'def $FUNC($$$):', 'async function $NAME($$$)'",
    promptSnippet: "ast_grep_search: AST-aware structural code search across 25 languages",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "AST pattern with meta-variables ($VAR, $$$). Must be complete AST node." },
        lang: langSchema,
        paths: { type: "array", items: { type: "string" }, description: "Paths to search (default: ['.'])" },
        globs: { type: "array", items: { type: "string" }, description: "Include/exclude globs (prefix ! to exclude)" },
        context: { type: "number", description: "Context lines around match" },
      },
      required: ["pattern", "lang"],
      additionalProperties: false,
    },
    async execute(_id: string, params: any, signal: AbortSignal | undefined) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const result = await runSg({
        pattern: params.pattern,
        lang: params.lang,
        paths: params.paths,
        globs: params.globs,
        context: params.context,
      });
      let output = formatSearchResult(result);
      if (result.matches.length === 0 && !result.error) {
        const hint = getEmptyResultHint(params.pattern, params.lang);
        if (hint) output += `\n\n${hint}`;
      }
      return { content: [{ type: "text", text: output }], details: { totalMatches: result.totalMatches, truncated: result.truncated } };
    },
  });

  pi.registerTool({
    name: "ast_grep_replace",
    label: "AST Grep Replace",
    description:
      "Replace code patterns across filesystem with AST-aware rewriting. " +
      "Dry-run by default. Use meta-variables in rewrite to preserve matched content. " +
      "Example: pattern='console.log($MSG)' rewrite='logger.info($MSG)'",
    promptSnippet: "ast_grep_replace: AST-aware structural rewrite (dry-run default)",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "AST pattern to match" },
        rewrite: { type: "string", description: "Replacement pattern (can use $VAR from pattern)" },
        lang: langSchema,
        paths: { type: "array", items: { type: "string" }, description: "Paths to search" },
        globs: { type: "array", items: { type: "string" }, description: "Include/exclude globs" },
        dryRun: { type: "boolean", description: "Preview changes without applying (default: true)" },
      },
      required: ["pattern", "rewrite", "lang"],
      additionalProperties: false,
    },
    async execute(_id: string, params: any, signal: AbortSignal | undefined) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const result = await runSg({
        pattern: params.pattern,
        rewrite: params.rewrite,
        lang: params.lang,
        paths: params.paths,
        globs: params.globs,
        updateAll: params.dryRun === false,
      });
      const output = formatReplaceResult(result, params.dryRun !== false);
      return { content: [{ type: "text", text: output }], details: { totalMatches: result.totalMatches } };
    },
  });
}
