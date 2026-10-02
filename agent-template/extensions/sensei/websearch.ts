// sensei websearch — slim port of senpi's builtin/websearch.
// Registered `web_search` tool; no provider-payload mutation.
// Provider order: Brave (BRAVE_API_KEY) -> Tavily (TAVILY_API_KEY) ->
// SearXNG (SEARXNG_URL) -> DuckDuckGo HTML (no key).

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

type Provider = { id: string; search: (query: string, count: number, signal: AbortSignal) => Promise<SearchResult[]> };

const TIMEOUT_MS = 20_000;

async function getJson(url: string, init: RequestInit, signal: AbortSignal): Promise<any> {
	const res = await fetch(url, { ...init, signal });
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	return res.json();
}

async function getText(url: string, init: RequestInit, signal: AbortSignal): Promise<string> {
	const res = await fetch(url, { ...init, signal });
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	return res.text();
}

function stripTags(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

const providers: Provider[] = [
	{
		id: "brave",
		async search(query, count, signal) {
			const key = process.env.BRAVE_API_KEY;
			if (!key) throw new Error("no BRAVE_API_KEY");
			const data = await getJson(
				`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
				{ headers: { "X-Subscription-Token": key, Accept: "application/json" } },
				signal,
			);
			return (data.web?.results ?? []).map((r: any) => ({
				title: String(r.title ?? ""),
				url: String(r.url ?? ""),
				snippet: String(r.description ?? ""),
			}));
		},
	},
	{
		id: "tavily",
		async search(query, count, signal) {
			const key = process.env.TAVILY_API_KEY;
			if (!key) throw new Error("no TAVILY_API_KEY");
			const data = await getJson(
				"https://api.tavily.com/search",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ api_key: key, query, max_results: count }),
				},
				signal,
			);
			return (data.results ?? []).map((r: any) => ({
				title: String(r.title ?? ""),
				url: String(r.url ?? ""),
				snippet: String(r.content ?? ""),
			}));
		},
	},
	{
		id: "searxng",
		async search(query, count, signal) {
			const base = (process.env.SEARXNG_URL ?? "").replace(/\/+$/, "");
			if (!base) throw new Error("no SEARXNG_URL");
			const data = await getJson(
				`${base}/search?q=${encodeURIComponent(query)}&format=json`,
				{ headers: { Accept: "application/json" } },
				signal,
			);
			return (data.results ?? []).slice(0, count).map((r: any) => ({
				title: String(r.title ?? ""),
				url: String(r.url ?? ""),
				snippet: String(r.content ?? ""),
			}));
		},
	},
	{
		id: "duckduckgo",
		async search(query, count, signal) {
			const html = await getText(
				`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
				{ headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) sensei/0" } },
				signal,
			);
			const out: SearchResult[] = [];
			const blocks = html.split(/class="result results_links/);
			for (const block of blocks.slice(1)) {
				const link = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
				if (!link) continue;
				let url = link[1];
				const uddg = url.match(/[?&]uddg=([^&]+)/);
				if (uddg) url = decodeURIComponent(uddg[1]);
				const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
				out.push({ title: stripTags(link[2]), url, snippet: snippet ? stripTags(snippet[1]) : "" });
				if (out.length >= count) break;
			}
			if (out.length === 0) throw new Error("no results parsed");
			return out;
		},
	},
];

function configuredProviders(): Provider[] {
	const list: Provider[] = [];
	if (process.env.BRAVE_API_KEY) list.push(providers[0]);
	if (process.env.TAVILY_API_KEY) list.push(providers[1]);
	if (process.env.SEARXNG_URL) list.push(providers[2]);
	list.push(providers[3]);
	return list;
}

export default function websearch(pi: any): void {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web and return titles, URLs and snippets. Uses Brave (BRAVE_API_KEY), Tavily (TAVILY_API_KEY), SearXNG (SEARXNG_URL), or DuckDuckGo when no key is configured. Use for current or online information; prefer it over guessing when freshness matters.",
		promptSnippet: "web_search <query> — search the web, returns titles/urls/snippets",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query" },
				count: { type: "number", description: "Max results (default 5, max 10)" },
			},
			required: ["query"],
			additionalProperties: false,
		},
		async execute(_id: string, params: any, signal: AbortSignal) {
			const count = Math.min(Math.max(1, params.count ?? 5), 10);
			const errors: string[] = [];
			for (const p of configuredProviders()) {
				try {
					const results = await p.search(params.query, count, signal);
					const lines = results.map(
						(r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`,
					);
					return {
						content: [
							{
								type: "text",
								text: `web_search "${params.query}" via ${p.id} — ${results.length} result(s)\n\n${lines.join("\n\n")}`,
							},
						],
						details: { provider: p.id, count: results.length },
					};
				} catch (e) {
					errors.push(`${p.id}: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
			throw new Error(`web_search failed on all providers — ${errors.join("; ")}`);
		},
	});

	pi.registerCommand("websearch", {
		description: "Show which web_search backend will be used",
		handler: async (_args: string, ctx: any) => {
			const names = configuredProviders().map((p) => p.id).join(" -> ");
			ctx.ui.notify(`web_search providers (first working wins): ${names}`, "info");
		},
	});
}
