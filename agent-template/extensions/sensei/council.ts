// council — port of omo-slim multi-model council, sensei edition.
// Fan-out: the same question goes to N councillor models in parallel via
// ctx.modelRegistry.streamSimple (no tools — pure advisors; the caller may
// attach code context). Synthesis: one council pass over all responses.
// Councillor list: `councillors` param or SENSEI_COUNCIL_MODELS env
// (comma-separated "provider/model-id"). Max 4 seats.

const MAX_COUNCILLORS = 4;
const COUNCILLOR_TIMEOUT_MS = 300_000;
const SEAT_NAMES = ["alpha", "bravo", "charlie", "delta"];

const COUNCILLOR_PROMPT = `You are a councillor in a multi-model council.

**Role**: Provide your best independent analysis and solution to the given problem.

You have NO tools — you are an advisor, not an implementer. Work only from the question and any provided context. State clearly when information is missing rather than guessing at code you cannot see.

**Behavior**:
- Analyze the problem thoroughly
- Provide a complete, well-reasoned response
- Focus on the quality and correctness of your solution
- Be direct and concise
- Don't be influenced by what other councillors might say - you won't see their responses

**Output**:
- Give your honest assessment
- Reference specific files and line numbers when relevant
- Include relevant reasoning
- State any assumptions clearly
- Note any uncertainties`;

const COUNCIL_PROMPT = `You are the Council agent - a synthesizer for multi-model consensus.

**Role**: You receive raw responses from multiple councillors (different models) and synthesize them into a structured council report.

**Tools**: You have NO tools. You synthesize purely from the councillor responses provided in your context.

**Synthesis Process** (MANDATORY - follow in order):
1. Read the original user prompt (provided in the context)
2. Review each councillor's response individually - note each councillor's key insight and unique contribution by name
3. Identify agreements and contradictions between councillors
4. Resolve contradictions with explicit reasoning
5. Synthesize the optimal final answer
6. Format output per the Required Output Format below

**Behavior**:
- Credit specific insights from individual councillors using their names
- If councillors disagree, explain why you chose one approach over another
- Be transparent about trade-offs when different approaches have valid pros/cons
- Do not omit per-councillor details from the final response
- Do not collapse the output into only a final summary - keep the per-councillor and summary sections distinct
- Don't just average responses - choose the best approach and improve upon it

**Required Output Format**:

Always include these sections in your final response:

## Council Response
Provide the best synthesized answer. Integrate the strongest points from the councillors, resolve disagreements, and give the user a clear final recommendation or answer. Include relevant code examples and concrete details.

## Per-Councillor Details
For each councillor, show:
- Their key insight, idea, or recommendation (using their exact name - the seat name, e.g. "alpha", not the model label)
- Their confidence level (if expressed)
- Notable points of agreement/disagreement with other councillors
- If a councillor failed or timed out, note that status briefly instead of omitting it

## Council Summary
- **Consensus Level**: unanimous | majority | split (pick one)
- **Agreed Points**: what all councillors agreed on
- **Disagreements**: where councillors differed and your resolution
- **Remaining Uncertainty**: any caveats, untested assumptions, or open questions the council could not fully resolve
- **Recommended Action**: what to do next`;

interface SeatResult {
  seat: string;
  model: string;
  text?: string;
  error?: string;
}

async function ask(registry: any, model: any, systemPrompt: string, prompt: string, signal: AbortSignal | undefined): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COUNCILLOR_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const stream = await registry.streamSimple(
      model,
      { systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }], tools: [] },
      { signal: controller.signal },
    );
    let text = "";
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.delta;
      else if (event.type === "error") throw new Error(event.error?.errorMessage ?? "stream error");
    }
    return text.trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export default function council(pi: any): void {
  pi.registerTool({
    name: "council",
    label: "Council",
    description:
      "Ask the same question to multiple models in parallel (councillors), then synthesize a structured council report: " +
      "synthesized answer, per-councillor details, and a consensus summary. " +
      "Use for high-stakes decisions, architecture choices, or when a second opinion reduces risk.",
    promptSnippet: "council — multi-model parallel query + synthesized consensus report",
    promptGuidelines: [
      "Council is for judgment calls, not information retrieval — delegate research to librarian/explorer roles instead.",
      "Pass relevant code or findings in `context`; councillors have no tools.",
      "Configure the seats with SENSEI_COUNCIL_MODELS or the `councillors` param.",
    ],
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question or problem for the council" },
        context: { type: "string", description: "Optional supporting material (code, findings, constraints) given to every councillor" },
        councillors: {
          type: "array",
          items: { type: "string" },
          description: `Model refs "provider/model-id" (max ${MAX_COUNCILLORS}). Default: SENSEI_COUNCIL_MODELS env.`,
        },
        synthesisModel: { type: "string", description: "Model ref for the synthesis pass (default: current model)" },
      },
      required: ["question"],
      additionalProperties: false,
    },
    async execute(_id: string, params: any, signal: any, _onUpdate: any, ctx: any) {
      const registry = ctx.modelRegistry;
      if (typeof registry?.streamSimple !== "function") {
        throw new Error("council: modelRegistry.streamSimple unavailable on this host");
      }

      const refs: string[] =
        params.councillors?.length ? params.councillors : (process.env.SENSEI_COUNCIL_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (refs.length === 0) {
        throw new Error("council: no councillors configured — pass `councillors` or set SENSEI_COUNCIL_MODELS=provider/model,provider/model");
      }
      if (refs.length > MAX_COUNCILLORS) refs.length = MAX_COUNCILLORS;

      const seats: { seat: string; ref: string; model: any }[] = [];
      const missing: string[] = [];
      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        const slash = ref.indexOf("/");
        const model = slash > 0 ? registry.find(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
        if (model) seats.push({ seat: SEAT_NAMES[i], ref, model });
        else missing.push(ref);
      }
      if (seats.length === 0) {
        throw new Error(`council: none of the councillor models resolved: ${missing.join(", ")}`);
      }

      const prompt = params.context ? `${params.question}\n\n<context>\n${params.context}\n</context>` : params.question;
      const results: SeatResult[] = await Promise.all(
        seats.map(async ({ seat, ref, model }) => {
          try {
            return { seat, model: ref, text: await ask(registry, model, COUNCILLOR_PROMPT, prompt, signal) };
          } catch (e) {
            return { seat, model: ref, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );

      // Synthesis pass.
      const dossier =
        `Original question:\n${prompt}\n\n` +
        results
          .map((r) => `--- Councillor ${r.seat} (${r.model}) ---\n${r.error ? `[FAILED: ${r.error}]` : r.text || "[empty response]"}`)
          .join("\n\n");
      let synthesis = "";
      const synRef: string | undefined = params.synthesisModel;
      let synModel = ctx.model;
      if (synRef) {
        const slash = synRef.indexOf("/");
        const found = slash > 0 ? registry.find(synRef.slice(0, slash), synRef.slice(slash + 1)) : undefined;
        if (found) synModel = found;
      }
      if (!synModel) {
        synthesis = "(no synthesis model available — raw responses below)";
      } else {
        try {
          synthesis = await ask(registry, synModel, COUNCIL_PROMPT, dossier, signal);
        } catch (e) {
          synthesis = `(synthesis failed: ${e instanceof Error ? e.message : String(e)} — raw responses below)`;
        }
      }

      const raw = results
        .map((r) => `## Councillor ${r.seat} — ${r.model}\n\n${r.error ? `FAILED: ${r.error}` : r.text || "(empty)"}`)
        .join("\n\n");
      const missingNote = missing.length ? `\n\n[unresolved councillor refs skipped: ${missing.join(", ")}]` : "";
      return {
        content: [{ type: "text", text: `${synthesis}\n\n---\n\n# Raw councillor responses\n\n${raw}${missingNote}` }],
        details: {
          seats: results.map((r) => ({ seat: r.seat, model: r.model, status: r.error ? "failed" : "ok" })),
          skipped: missing,
        },
      };
    },
  });
}
