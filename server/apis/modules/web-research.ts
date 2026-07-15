import { api, z, anthropic } from "@superblocksteam/sdk-api";

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// Models & Config
// ---------------------------------------------------------------------------
const RESEARCH_MODEL = "claude-sonnet-4-6";
const RESEARCH_MAX_TOKENS = 4096;
const WEB_SEARCH_MAX_USES = 10;

/** Per-call timeout for the Anthropic web_search request (ms) */
const PER_CALL_TIMEOUT_MS = 90_000; // 90s — adjustable once real timing data exists

/** Retry config */
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 2000; // 2s, 4s, 8s

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const ResearchIterationSchema = z.object({
  iteration: z.number(),
  query: z.string(),
  finding: z.string(),
  confidence: z.number(),
  platform: z.string().optional(),
  category: z.string().optional(),
  sources: z.array(z.string()).optional(),
  materiality: z.string().optional(),
  truncated: z.boolean().optional(),
  failed: z.boolean().optional(),
});

// Anthropic response with tool_use support
const ToolUseResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      input: z.record(z.unknown()).optional(),
    })
  ),
  model: z.string(),
  stop_reason: z.string().nullable(),
  stop_sequence: z.string().nullable().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeBraces(text: string): string {
  if (!text) return text;
  return text.replace(/\{/g, "\uFE5B").replace(/\}/g, "\uFE5C");
}

/**
 * Internal result shape for the raw LLM call.
 */
interface WebSearchRawResult {
  text: string;
  truncated: boolean;
}

/**
 * Run one web search iteration using Anthropic's built-in web_search tool.
 * Includes retry with exponential backoff and per-call timeout via Promise.race.
 *
 * Budget-check-per-retry: the caller passes `deadlineMs` (wall-clock ms since
 * epoch by which we must stop). Before each retry attempt we check remaining
 * budget — if less than 30s remains, bail early rather than starting a call
 * that will almost certainly exceed the overall budget.
 */
async function runWebSearchIteration(
  ai: { apiRequest: Function },
  systemPrompt: string,
  iterationPrompt: string,
  deadlineMs: number | null, // null = no deadline (for legacy client-side calls)
  label: string = "Web search iteration"
): Promise<WebSearchRawResult> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Budget check before each attempt (lesson from callExtractionLLM)
    if (deadlineMs !== null) {
      const remaining = deadlineMs - Date.now();
      if (remaining < 30_000) {
        throw new Error(
          `Budget exhausted mid-retry (attempt ${attempt}/${MAX_RETRIES}, ${Math.round(remaining / 1000)}s left): ${label}`
        );
      }
    }

    try {
      // Race against per-call timeout
      const timeoutMs = deadlineMs !== null
        ? Math.min(PER_CALL_TIMEOUT_MS, deadlineMs - Date.now())
        : PER_CALL_TIMEOUT_MS;

      const response = await Promise.race([
        ai.apiRequest(
          {
            method: "POST",
            path: "/v1/messages",
            body: {
              model: RESEARCH_MODEL,
              max_tokens: RESEARCH_MAX_TOKENS,
              system: [
                {
                  type: "text",
                  text: systemPrompt,
                  cache_control: { type: "ephemeral" },
                },
              ],
              messages: [{ role: "user", content: iterationPrompt }],
              tools: [
                {
                  type: "web_search_20250305" as string,
                  name: "web_search",
                  max_uses: WEB_SEARCH_MAX_USES,
                },
              ],
            },
          },
          { response: ToolUseResponseSchema },
          { label }
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Web search timed out after ${Math.round(timeoutMs / 1000)}s: ${label}`)),
            timeoutMs
          )
        ),
      ]);

      // Collect all text blocks from the single response
      let text = "";
      for (const block of response.content) {
        if (block.type === "text" && block.text) {
          text += block.text;
        }
      }

      // Truncation detection: stop_reason === "max_tokens" means the response
      // was cut off mid-generation. The text may be incomplete/invalid JSON.
      const truncated = response.stop_reason === "max_tokens";

      return { text, truncated };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = /503|429|rate.?limit|service.?unavailable|overloaded|timed out/i.test(msg);
      if (!isRetryable || attempt === MAX_RETRIES) throw err;
      const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt - 1), 15_000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("Unreachable");
}

/**
 * Parse a JSON iteration result from the research response text.
 */
export function parseIterationResult(
  responseText: string,
  iteration: number
): {
  query: string;
  finding: string;
  confidence: number;
  platform?: string;
  category?: string;
  sources?: string[];
  materiality?: string;
} {
  try {
    // Find the outermost JSON object — handles cases where the model wraps text around it
    const firstBrace = responseText.indexOf("{");
    const lastBrace = responseText.lastIndexOf("}");
    const jsonStr =
      firstBrace >= 0 && lastBrace > firstBrace
        ? responseText.slice(firstBrace, lastBrace + 1)
        : responseText;
    const parsed = JSON.parse(jsonStr);
    return {
      query: String(parsed.query ?? "web search"),
      finding: String(parsed.finding ?? responseText.slice(0, 1000)),
      confidence: Math.min(10, Math.max(1, Number(parsed.confidence) || 5)),
      platform: parsed.platform ? String(parsed.platform) : undefined,
      category: parsed.category ? String(parsed.category) : undefined,
      sources: Array.isArray(parsed.sources)
        ? parsed.sources.map(String)
        : undefined,
      materiality: parsed.materiality ? String(parsed.materiality) : undefined,
    };
  } catch {
    return {
      query: "research iteration",
      finding: responseText.slice(0, 1000),
      confidence: 3,
    };
  }
}

// ---------------------------------------------------------------------------
// Research prompt builders (exported for use by web-research-phase.ts)
// ---------------------------------------------------------------------------

// System prompt for the external risk research agent
export const EXTERNAL_RISK_SYSTEM_PROMPT = `You are an elite external risk research agent conducting due diligence for a private equity acquisition. Your job is to uncover risks that the deal team may have missed, understated, or not yet considered.

Use the web_search tool aggressively — search for specific companies, executives, regulations, competitors, and market dynamics. Cross-reference what you find against the deal documents provided.

Do NOT research social media reputation, employee sentiment, or brand perception — those are handled by a separate Social Reputation Intelligence module.

Be thorough but creative. The best diligence uncovers what nobody thought to ask about.`;

export const SOCIAL_REPUTATION_SYSTEM_PROMPT = "You are a reputation and social intelligence research agent conducting due diligence for a private equity acquisition. Use the web_search tool to research social signals, employee sentiment, customer perception, and brand reputation. Focus ONLY on public external sources.";

export function buildExternalRiskIterationPrompt(
  dealContext: string,
  docContext: string,
  previousFindings: string
): string {
  return [
    `You are researching: ${dealContext}`,
    "",
    docContext
      ? `Deal materials extracted from data room (use as context, cross-reference your findings against these):\n${docContext}`
      : "",
    "",
    "RESEARCH FRAMEWORK (use as guidance, not as constraints):",
    "These categories help organize your thinking, but do NOT limit yourself to them.",
    "If you discover something unexpected or deal-specific that doesn't fit neatly — pursue it.",
    "The best diligence uncovers what nobody thought to ask about.",
    "",
    "Categories to get you started:",
    "- REGULATORY: Pending legislation, enforcement actions, compliance shifts affecting this sector",
    "- COMPETITIVE: Emerging competitors, market share shifts, pricing pressure, disruptive models",
    "- CUSTOMER_MARKET: Customer concentration risks, demand shifts, churn signals, TAM challenges",
    "- TECHNOLOGY: Tech debt indicators, platform risks, security incidents, AI/automation disruption",
    "- MACRO: Interest rate exposure, supply chain, geopolitical, labor market headwinds",
    "- MANAGEMENT: Leadership track record, turnover patterns, litigation, governance concerns",
    "- OTHER: Anything else that strikes you as material — follow your curiosity",
    "",
    previousFindings
      ? `Previous research iterations:\n${previousFindings}`
      : "This is your first research iteration.",
    "",
    "Your task:",
    "1. Based on what you know so far, decide what to search for next — prioritize areas with gaps or where your confidence is lowest",
    "2. Use the web_search tool to search for it",
    "3. Analyse what you find",
    "4. Respond with a JSON object:",
    "﹛",
    '  "query": "what you searched for",',
    '  "finding": "summary of what you found and its risk implications",',
    '  "category": "REGULATORY|COMPETITIVE|CUSTOMER_MARKET|TECHNOLOGY|MACRO|MANAGEMENT|OTHER",',
    '  "sources": ["url1", "url2"],',
    '  "materiality": "HIGH|MEDIUM|LOW",',
    '  "in_deal_docs": true/false,',
    '  "confidence": <1-10 how confident you are that your cumulative research is comprehensive enough>',
    "﹜",
    "",
    "IMPORTANT: The categories above are starting points, not a checklist.",
    "If your research surfaces a thread that feels material — a strange patent filing,",
    "an unusual executive departure pattern, a niche regulatory body nobody watches —",
    "follow it. Tag it OTHER if it doesn't fit. The goal is to find what the deal team",
    "missed, and that often lives in the unexpected.",
    "",
    "Return ONLY the JSON object, nothing else.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export function buildSocialReputationIterationPrompt(
  dealContext: string,
  docContext: string,
  previousFindings: string,
  researchCategories: string
): string {
  return [
    "You are a reputation and social intelligence research agent investigating a company for private equity due diligence.",
    "",
    `Deal context:\n${dealContext}`,
    "",
    docContext
      ? `Deal materials summary (reputation-relevant claims extracted from data room):\n${docContext}`
      : "",
    "",
    `RESEARCH CATEGORIES (investigate each one systematically):\n${researchCategories}`,
    "",
    previousFindings
      ? `Previous research iterations:\n${previousFindings}`
      : "This is your first research iteration.",
    "",
    "Your task:",
    "1. Choose the next unresearched category from the list above (or follow up on a high-signal finding)",
    "2. Use the web_search tool to investigate",
    "3. Analyse what you find, especially comparing to any claims made in the deal materials",
    '4. Respond with a JSON object:',
    "﹛",
    '  "query": "what you searched for",',
    '  "platform": "GLASSDOOR | INDEED | LINKEDIN | TWITTER | INSTAGRAM | FACEBOOK | CUSTOMER_REVIEWS | REDDIT | NEWS | C-SUITE",',
    '  "finding": "summary of what you found and how it compares to deal team claims",',
    '  "confidence": <1-10 how confident you are that your cumulative research across ALL categories is comprehensive enough>',
    "﹜",
    "",
    "Focus ONLY on social, reputation, employee sentiment, customer perception, and brand signals from PUBLIC EXTERNAL sources.",
    "Do NOT research regulatory, competitive, or macro-economic risks — those are covered by the External Risk Overlay module.",
    "",
    "Return ONLY the JSON object, nothing else.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

// Social reputation research categories (exported for web-research-phase.ts)
export const SOCIAL_REPUTATION_CATEGORIES = [
  "GLASSDOOR & INDEED: Employee reviews, ratings trends, management approval",
  "LINKEDIN: Employee growth/decline, sentiment in posts, talent retention signals",
  "TWITTER/X: Brand mentions, customer complaints, viral incidents",
  "INSTAGRAM & FACEBOOK: Brand engagement, customer comments, ad transparency",
  "CUSTOMER REVIEWS: G2, Trustpilot, BBB, industry-specific review platforms",
  "REDDIT: Employee throwaway accounts, customer complaints, competitive comparisons",
  "NEWS MEDIA: PR crises, leadership controversies, corporate culture exposés",
  "C-SUITE: Executive social presence, thought leadership, public statements",
].join("\n");

// ---------------------------------------------------------------------------
// API — Run one web research iteration (hardened with retry + timeout)
// ---------------------------------------------------------------------------
export default api({
  name: "WebResearch",
  description:
    "Runs one web research iteration using Anthropic web_search tool with retry and timeout",

  integrations: {
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    moduleId: z.enum(["external_risk_overlay", "social_reputation"]),
    iteration: z.number(),
    dealContext: z.string(),
    docContext: z.string(),
    previousFindings: z.string(),
    researchCategories: z.string().nullable().optional(),
    deadlineMs: z.number().nullable().optional(), // Wall-clock deadline (epoch ms); null = no deadline
  }),

  output: ResearchIterationSchema,

  async run(
    ctx,
    {
      moduleId,
      iteration,
      dealContext,
      docContext,
      previousFindings,
      researchCategories,
      deadlineMs,
    }
  ) {
    let iterationPrompt: string;

    if (moduleId === "social_reputation") {
      iterationPrompt = buildSocialReputationIterationPrompt(
        sanitizeBraces(dealContext),
        sanitizeBraces(docContext),
        sanitizeBraces(previousFindings),
        sanitizeBraces(researchCategories ?? SOCIAL_REPUTATION_CATEGORIES)
      );
    } else {
      iterationPrompt = buildExternalRiskIterationPrompt(
        sanitizeBraces(dealContext),
        sanitizeBraces(docContext),
        sanitizeBraces(previousFindings)
      );
    }

    // Pick the system prompt based on module
    const systemPrompt =
      moduleId === "social_reputation"
        ? SOCIAL_REPUTATION_SYSTEM_PROMPT
        : EXTERNAL_RISK_SYSTEM_PROMPT;

    const label = `Web search: ${moduleId} iteration ${iteration}`;

    try {
      const { text, truncated } = await runWebSearchIteration(
        ctx.integrations.ai,
        systemPrompt,
        iterationPrompt,
        deadlineMs ?? null,
        label
      );

      const result = parseIterationResult(text, iteration);

      return {
        iteration,
        query: result.query,
        finding: truncated
          ? `[TRUNCATED] ${result.finding}`
          : result.finding,
        confidence: result.confidence,
        platform: result.platform,
        category: result.category,
        sources: result.sources,
        materiality: result.materiality,
        truncated,
        failed: false,
      };
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "unknown error";
      return {
        iteration,
        query: "error",
        finding: `Research iteration failed: ${msg}`,
        confidence: 1,
        truncated: false,
        failed: true,
      };
    }
  },
});

// Re-export the raw iteration runner for use by web-research-phase.ts (server-side loop)
export { runWebSearchIteration, PER_CALL_TIMEOUT_MS, MAX_RETRIES, BACKOFF_BASE_MS };
