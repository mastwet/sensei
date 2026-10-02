// webfetch — port of senpi builtin `webfetch/` (vendored pi-webfetch), dependency-free.
// Faithful behavior: markdown|text|html formats, browser headers + per-format Accept,
// manual redirect cap, 5MB body limit, 50KB output cap with line-aware truncation.
// Deps in senpi (undici/linkedom/readability/turndown) are host-vendored and unreachable
// from user extensions, so this uses global fetch + a compact HTML converter.

const MAX_RESPONSE_SIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_REDIRECTS = 20;
const OUTPUT_MAX_BYTES = 50 * 1024;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

type WebfetchFormat = "markdown" | "text" | "html";

const ARTICLE_NOISE_TAGS =
  /<(script|style|noscript|iframe|object|embed|meta|link|nav|aside|footer|template|form|svg)\b[\s\S]*?<\/\s*\1\s*>/gi;
const NOISE_CLASS_RE =
  /<(nav|aside|footer|div|section|span)\b[^>]*(?:class|id)="[^"]*(?:sidebar|comment|related|adsbygoogle|revenue|postbtn|tagTrail|footer|nav|menu|cookie|banner|popup|share|social)[^"]*"[^>]*>[\s\S]*?<\/\s*\1\s*>/gi;
const EXPLICIT_ARTICLE_RE =
  /<(article|main|div|section)\b[^>]*(?:class|id)="[^"]*(?:article|entry-content|post-content|content-article|article-content|contents_style|article_view|content)[^"]*"[^>]*>/i;

function codePoint(n: number): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d) => codePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => codePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&middot;/g, "·")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»");
}

function resolveUrl(value: string, base: string): string | undefined {
  try {
    return new URL(value, base).href;
  } catch {
    return undefined;
  }
}

function stripNoise(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, " ");
  let prev: string;
  do {
    prev = out;
    out = out.replace(ARTICLE_NOISE_TAGS, " ");
  } while (out !== prev);
  do {
    prev = out;
    out = out.replace(NOISE_CLASS_RE, " ");
  } while (out !== prev);
  return out;
}

/** Keep the likely article body when a recognizable container exists. */
function extractArticle(html: string): string {
  const cleaned = stripNoise(html);
  const m = EXPLICIT_ARTICLE_RE.exec(cleaned);
  if (m) {
    // take from the container start; stop at a footer/comments-ish boundary if present
    const start = m.index;
    const tail = cleaned.slice(start);
    const endMatch = /<(footer|div)\b[^>]*(?:class|id)="[^"]*(?:footer|comments|comment|related)[^"]*"/i.exec(tail);
    const slice = endMatch ? tail.slice(0, endMatch.index) : tail;
    if (slice.replace(/<[^>]+>/g, "").trim().length >= 30) return slice;
  }
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/\s*body\s*>/i.exec(cleaned);
  return bodyMatch ? bodyMatch[1] : cleaned;
}

function pageTitle(html: string): string {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html) ?? /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim() : "";
}

function htmlToMarkdown(html: string, url: string): string {
  const title = pageTitle(html);
  let frag = extractArticle(html);
  frag = frag.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href, inner) => {
    const text = decodeEntities(String(inner).replace(/<[^>]+>/g, "")).trim();
    const dest = resolveUrl(String(href), url);
    if (!dest || dest.startsWith("javascript:")) return text;
    return text ? `[${text}](${dest})` : dest;
  });
  frag = frag.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc="([^"]*)"/i.exec(tag)?.[1];
    if (!src) return "";
    const dest = resolveUrl(src, url);
    const alt = /\balt="([^"]*)"/i.exec(tag)?.[1] ?? "";
    return dest ? `![${alt}](${dest})` : "";
  });
  frag = frag
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/\s*h\1\s*>/gi, (_m, n, inner) => `\n\n${"#".repeat(Number(n))} ${decodeEntities(String(inner).replace(/<[^>]+>/g, "")).trim()}\n\n`)
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/\s*pre\s*>/gi, (_m, inner) => `\n\n\`\`\`\n${decodeEntities(String(inner).replace(/<[^>]+>/g, "")).replace(/^\n+|\n+$/g, "")}\n\`\`\`\n\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/\s*code\s*>/gi, (_m, inner) => `\`${decodeEntities(String(inner).replace(/<[^>]+>/g, ""))}\``)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/\s*blockquote\s*>/gi, (_m, inner) => `\n\n${decodeEntities(String(inner).replace(/<[^>]+>/g, "")).trim().split("\n").map((l) => `> ${l}`).join("\n")}\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/\s*li\s*>/gi, (_m, inner) => `\n- ${decodeEntities(String(inner).replace(/<[^>]+>/g, "")).trim()}`)
    .replace(/<(td|th)\b[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi, (_m, _t, inner) => `${decodeEntities(String(inner).replace(/<[^>]+>/g, "")).trim()} | `)
    .replace(/<\/tr\s*>/gi, "\n")
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(/<hr\b[^>]*>/gi, "\n\n---\n\n")
    .replace(/<\/(p|div|ul|ol|table|section|header|dl|dd|dt|figure|figcaption|address|tr)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  let md = decodeEntities(frag)
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (title && !/^#\s/.test(md) && !md.startsWith(`# ${title}`)) md = `# ${title}\n\n${md}`.trim();
  return md;
}

function htmlToText(html: string): string {
  const title = pageTitle(html);
  let frag = extractArticle(html);
  frag = frag
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " ")
    .replace(/<\/(td|th|tr)\s*>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|main|blockquote|pre|dl|dd|dt|figure|figcaption|address|hr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(frag)
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return title && !text.startsWith(title) ? `${title}\n\n${text}` : text;
}

class WebfetchTimeoutError extends Error {}
class WebfetchResponseTooLargeError extends Error {}

function validateUrl(url: string): void {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error(`URL must start with http:// or https://`);
  }
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
}

function clampTimeout(t: number | undefined): number {
  if (t === undefined || !Number.isFinite(t) || t <= 0) return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(Math.ceil(t), MAX_TIMEOUT_SECONDS);
}

function buildAcceptHeader(format: WebfetchFormat): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  }
}

function buildHeaders(format: WebfetchFormat): Record<string, string> {
  return {
    Accept: buildAcceptHeader(format),
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": BROWSER_USER_AGENT,
  };
}

async function readBodyCapped(res: Response, signal: AbortSignal): Promise<{ body: Uint8Array; truncated: boolean }> {
  const len = res.headers.get("content-length");
  if (len && Number.parseInt(len, 10) > MAX_RESPONSE_SIZE_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new WebfetchResponseTooLargeError("Response too large (exceeds 5MB limit)");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (!reader) return { body: new Uint8Array(), truncated: false };
  while (true) {
    if (signal.aborted) {
      reader.cancel().catch(() => {});
      throw new Error("Request aborted");
    }
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = MAX_RESPONSE_SIZE_BYTES - total;
    const piece = value.length > remaining ? value.subarray(0, remaining) : value;
    chunks.push(piece);
    total += piece.length;
    if (total >= MAX_RESPONSE_SIZE_BYTES) {
      reader.cancel().catch(() => {});
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return { body: out, truncated: true };
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return { body: out, truncated: false };
}

function sliceUtf8Head(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, "utf-8");
  if (buf.length <= maxBytes) return value;
  const decoded = new TextDecoder("utf-8").decode(buf.subarray(0, maxBytes));
  return decoded.endsWith("") ? decoded.slice(0, -1) : decoded;
}

function takeHeadBytes(text: string, maxBytes: number): string {
  const lines: string[] = [];
  let used = 0;
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    const line = nl === -1 ? text.slice(start) : text.slice(start, nl);
    const lineBytes = Buffer.byteLength(line, "utf-8") + (lines.length > 0 ? 1 : 0);
    if (used + lineBytes > maxBytes) break;
    lines.push(line);
    used += lineBytes;
    if (nl === -1) break;
    start = nl + 1;
  }
  return lines.length === 0 ? sliceUtf8Head(text, maxBytes) : lines.join("\n");
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export default function (pi: any) {
  const envOff = process.env.SENSEI_WEBFETCH?.trim().toLowerCase();
  if (envOff === "0" || envOff === "false" || envOff === "no" || envOff === "off") return;

  pi.registerTool({
    name: "webfetch",
    label: "Web Fetch",
    description:
      "Fetches content from a URL and returns it as markdown, plain text, or HTML. " +
      "Network use is bounded by timeout and response size limits.",
    promptSnippet: "webfetch: retrieve URL content as markdown, text, or html",
    promptGuidelines: [
      "Use webfetch when a specific URL must be retrieved.",
      "Prefer markdown format unless raw HTML or plain text is explicitly needed.",
      "The tool is read-only and does not modify files.",
    ],
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch content from" },
        format: { type: "string", enum: ["markdown", "text", "html"], description: "The format to return the content in. Defaults to markdown." },
        timeout: { type: "number", description: "Optional timeout in seconds. Maximum 120." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async execute(_id: string, params: any, signal: AbortSignal | undefined, onUpdate: any) {
      const format: WebfetchFormat = params.format === "text" || params.format === "html" ? params.format : "markdown";
      const timeoutSeconds = clampTimeout(params.timeout);
      validateUrl(params.url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new WebfetchTimeoutError(`Request timed out after ${timeoutSeconds}s`)), timeoutSeconds * 1000);
      const onAbort = () => controller.abort(signal?.reason);
      if (signal?.aborted) controller.abort(signal.reason);
      else signal?.addEventListener("abort", onAbort, { once: true });

      onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.url} as ${format} (timeout ${timeoutSeconds}s)` }] });

      let res: Response;
      try {
        res = await fetch(params.url, {
          signal: controller.signal,
          redirect: "follow",
          headers: buildHeaders(format),
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }

      const { body, truncated } = await readBodyCapped(res, controller.signal);
      const raw = new TextDecoder().decode(body);
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
      let text = raw;
      let converted = false;
      if (isHtml && format === "markdown") { text = htmlToMarkdown(raw, res.url); converted = true; }
      else if (isHtml && format === "text") { text = htmlToText(raw); converted = true; }

      const totalBytes = Buffer.byteLength(text, "utf-8");
      let outText = text;
      let notice = "";
      if (totalBytes > OUTPUT_MAX_BYTES) {
        outText = takeHeadBytes(text, OUTPUT_MAX_BYTES);
        const outBytes = Buffer.byteLength(outText, "utf-8");
        notice = `\n[Output truncated: ${formatByteSize(outBytes)} of ${formatByteSize(totalBytes)} shown (${formatByteSize(OUTPUT_MAX_BYTES)} limit). Re-fetch a more specific URL or use web_search for targeted content.]`;
      }

      const header = `${res.status} ${res.statusText} — ${res.url}\n\n`;
      return {
        content: [{ type: "text", text: header + outText + notice }],
        details: {
          url: params.url,
          finalUrl: res.url,
          format,
          status: res.status,
          contentType,
          bytes: body.length,
          converted,
          truncated,
          outputTruncated: totalBytes > OUTPUT_MAX_BYTES,
        },
      };
    },
  });
}
