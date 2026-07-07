import { api, z, anthropic } from "@superblocksteam/sdk-api";

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
const SUB_AGENT_MODEL = "claude-sonnet-4-6";
const SUB_AGENT_MAX_TOKENS = 8000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const PageImageSchema = z.object({
  pageNumber: z.number(),
  text: z.string(),
  imageBase64: z.string(),
  mediaType: z.literal("image/jpeg"),
});

const ChunkSchema = z.object({
  label: z.string(),
  sourceFile: z.string(),
  text: z.string(),
  pageImages: z.array(PageImageSchema),
});

// ---------------------------------------------------------------------------
// Universal Extraction Prompt
//
// This single prompt consolidates the extraction needs of ALL 8 analysis
// modules. Each chunk is processed ONCE instead of 8 times. The per-module
// merge prompts then receive the relevant sections of this extraction.
// ---------------------------------------------------------------------------
const UNIVERSAL_EXTRACTION_PROMPT = `You are a senior private equity due diligence analyst performing a comprehensive extraction on a document chunk from a deal data room. You must extract ALL information relevant to investment committee (IC) review in a single pass.

You will receive BOTH page images AND extracted text. Use both for thorough analysis.

## Extraction Framework

Extract everything relevant across ALL of the following dimensions simultaneously. Be comprehensive — downstream analysis modules depend on the completeness of your extraction.

### 1. Document Classification
- Document type (CIM, IC_MEMO, CUSTOMER_DATA, CONSULTANT_REPORT, FINANCIAL_MODEL, LEGAL, OTHER)
- Source perspective (deal_team, management, third_party, unclear)

### 2. Key Claims & Assertions
For each claim found, capture:
- The claim itself (precise statement)
- Claim type: "thesis" | "risk_mitigant" | "explicit_assumption" | "implicit_assumption" | "narrative" | "data_point" | "weak_point"
- Source type: "narrative" (CIM, IC memo, management presentation) or "data" (financial model, customer data, consultant report, QoE)
- Location within the document (section, page, table name)
- Confidence in your extraction accuracy ("high" | "medium" | "low")
- Which PE diligence dimension it relates to: "commercial" | "financial" | "management" | "technology" | "legal" | "competitive" | "customer" | "operational" | "exit" | "esg" | "multiple"

### 3. Quantitative Data Points
For each metric/data point:
- Metric name
- Value (exact figure)
- Context (why this matters)
- Category: "revenue" | "margin" | "customer" | "cost" | "capital" | "financing" | "entry_exit" | "returns" | "operational" | "other"
- Whether stated explicitly or derived
- Perspective: "deal_team" | "management" | "unclear"

### 4. Flags & Risks
For each flag identified:
- Type: "risk" | "gap" | "contradiction" | "assumption" | "omission"
- Description (direct statement of the issue)
- Severity: "critical" | "moderate" | "low"

### 5. Omissions & Missing Information
- Missing data, sections, time periods, benchmarks, or risk factors that should be present
- Cross-reference against PE checklist: customer concentration, churn/retention, key man risk, revenue recognition, regulatory exposure, competitive response, management incentives, exit assumptions, QoE items, capex requirements

### 6. Competitive & Market Context
- Named competitors and positioning claims
- Market size/TAM figures and their basis
- Industry trend narratives

### 7. Management & Leadership
- Named individuals, titles, background claims
- Key person dependencies
- Retention arrangements

### 8. Customer & Revenue Details
- Named customers, concentration data
- Contract durations, churn/retention figures
- NPS, CSAT, or satisfaction scores

### 9. Reputation & Social Signals
- Social media or web presence references
- Employee/culture claims (headcount, satisfaction, Glassdoor mentions)
- Brand/marketing claims
- Any acknowledged reputation risks

### 10. Legal & Regulatory
- Compliance status, pending litigation
- Regulatory risk, licensing requirements

## Output Rules

Return ONLY a valid JSON object. No text before or after.

Be precise and dense — every word should carry information:
- Each claim should be a single clear statement — no filler, no restating context.
- "claim" states WHAT is claimed. "location" states WHERE. Do not repeat one in the other.
- "description" in flags states the gap directly — do not explain why it matters.

Required top-level keys:
- "document_name" (string)
- "document_type" (string): CIM | IC_MEMO | CUSTOMER_DATA | CONSULTANT_REPORT | FINANCIAL_MODEL | LEGAL | OTHER
- "source_perspective" (string): deal_team | management | third_party | unclear
- "key_claims" (array): each with "id" (leave as empty string — will be assigned post-extraction), "claim", "claim_type", "source_type", "location", "confidence", "dimension"
- "data_points" (array): each with "metric", "value", "context", "category", "stated_or_derived", "perspective"
- "flags" (array): each with "type", "description", "severity"
- "omissions" (array of strings): missing items relative to PE diligence standards
- "competitive_market" (array): each with "claim", "named_competitors" (string[]), "figures_cited" (string or null)
- "management_leadership" (array): each with "name", "title", "background_claims" (string or null), "retention_detail" (string or null)
- "customer_revenue" (array): each with "customer" (string or null), "revenue_share" (string or null), "contract_detail" (string or null), "metric_cited" (string or null)
- "reputation_social" (array): each with "claim", "platform_or_source" (string or null), "metric_cited" (string or null)
- "legal_regulatory" (array): each with "topic", "detail"
- "stated_risks" (array): each with "risk", "mitigant_offered" (string or null)
- "raw_summary" (string): 3-4 dense sentences covering the most material findings`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inject stable claim IDs into the extraction JSON.
 * Format: "c{chunkIndex}-{claimIndex}" (0-based).
 * This happens post-extraction so IDs are deterministic and don't depend on
 * the model remembering to output them.
 */
function injectClaimIds(rawJson: string, chunkIndex: number): string {
  try {
    // Strip markdown code fences if present (```json ... ```)
    // The model may output prose before the fence, so search for it anywhere
    let jsonStr = rawJson.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    } else if (jsonStr.startsWith("```")) {
      // Fallback: fence without closing (shouldn't happen, but be safe)
      jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, "");
    }

    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed.key_claims)) {
      parsed.key_claims = parsed.key_claims.map(
        (claim: Record<string, unknown>, idx: number) => ({
          ...claim,
          id: `c${chunkIndex}-${idx}`,
        })
      );
    }
    return JSON.stringify(parsed);
  } catch {
    // If JSON parsing fails, return as-is — downstream will handle the error
    return rawJson;
  }
}

function sanitizeBraces(text: string): string {
  if (!text) return text;
  return text.replace(/\{/g, "\uFE5B").replace(/\}/g, "\uFE5C");
}

function buildMultimodalContent(
  chunk: z.infer<typeof ChunkSchema>
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  for (const page of chunk.pageImages) {
    if (page.imageBase64) {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: page.mediaType,
          data: page.imageBase64,
        },
      });
    }
  }

  if (chunk.text) {
    blocks.push({
      type: "text",
      text: `--- Extracted text from "${sanitizeBraces(chunk.label)}" ---\n\n${sanitizeBraces(chunk.text)}`,
    });
  }

  blocks.push({
    type: "text",
    text: `The above is "${sanitizeBraces(chunk.label)}" (source: ${sanitizeBraces(chunk.sourceFile)}). Perform a comprehensive extraction now using both the page images and the extracted text.`,
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// Anthropic response schema
// ---------------------------------------------------------------------------
const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(
    z.object({
      type: z.literal("text"),
      text: z.string(),
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
// API — Universal extraction for a single chunk
// ---------------------------------------------------------------------------
export default api({
  name: "UniversalExtract",
  description: "Performs comprehensive single-pass extraction on a document chunk for all analysis modules",

  integrations: {
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    chunkIndex: z.number(),
    totalChunks: z.number(),
    chunk: ChunkSchema,
  }),

  output: z.object({
    label: z.string(),
    extraction: z.string(),
    chunkIndex: z.number(),
    sourceFile: z.string(),
  }),

  async run(ctx, { chunkIndex, totalChunks, chunk }) {
    const content = buildMultimodalContent(chunk);
    const label = `Universal extract: ${sanitizeBraces(chunk.label)} (${chunkIndex + 1}/${totalChunks})`;

    const result = await ctx.integrations.ai.apiRequest(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: SUB_AGENT_MODEL,
          max_tokens: SUB_AGENT_MAX_TOKENS,
          system: [
            {
              type: "text",
              text: UNIVERSAL_EXTRACTION_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content }],
        },
      },
      { response: MessageResponseSchema },
      { label }
    );

    const textBlock = result.content.find(
      (c: { type: string }) => c.type === "text"
    );
    if (!textBlock || textBlock.type !== "text") {
      throw new Error(`No text content in Anthropic response for chunk ${chunkIndex}`);
    }

    // Inject stable claim IDs (c0-0, c0-1, c1-0, …) before wrapping in markdown
    const rawText = textBlock.text.trim();
    const idTaggedText = injectClaimIds(rawText, chunkIndex);

    const extraction = `### Universal Extraction from: ${sanitizeBraces(chunk.label)}\n\n${sanitizeBraces(idTaggedText)}`;

    return {
      label: sanitizeBraces(chunk.label),
      extraction,
      chunkIndex,
      sourceFile: sanitizeBraces(chunk.sourceFile),
    };
  },
});
