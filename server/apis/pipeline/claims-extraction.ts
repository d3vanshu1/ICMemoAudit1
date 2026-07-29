/**
 * Claims Extraction — Structured claim ledger from IC memos.
 *
 * PURPOSE: Extract every quantitative financial claim from IC memos into a typed
 * ledger with precise scope classification. This is the backbone of the
 * claims-reconciliation loop: LLM locates and classifies; code verifies arithmetic.
 *
 * KEY DESIGN PRINCIPLE: The scope_qualifier field is what prevents fabrication.
 * "£4m EBITDA acquired p.a. at 5.5x" → scope: "acquired-via-M&A (deal-sizing)"
 * This is NOT organic EBITDA and must NEVER be compared to the model's organic EBITDA.
 *
 * The extraction prompt enforces scope-family awareness:
 *   EBITDA: Adjusted / Reported / Cash / Organic Cash / Run-rate / Entry / acquired-via-M&A
 *   Revenue: Total Group / Pro-forma (PF) / excl-future-M&A / organic (excl recent acq)
 *   Multiples/Returns: structuring basis / entry basis / exit basis
 *
 * Architecture: Called as Step 0.8 in pipeline-core for contradiction_check runs,
 * after numeric-verify-inline (Step 0.7) and before the merge phase.
 */
import { z } from "@superblocksteam/sdk-api";
import { callLLMWithHeadroom, MessageResponseSchema, type LLMResponse } from "./call-llm.js";
import { SONNET_MODEL } from "./model-config.js";
import type { PipelineContext } from "./pipeline-config.js";

// ---------------------------------------------------------------------------
// Claim Schema — the typed ledger
// ---------------------------------------------------------------------------

export const ClaimSchema = z.object({
  metric: z.enum([
    "revenue",
    "EBITDA",
    "gross_margin",
    "net_income",
    "net_debt",
    "multiple",
    "growth_rate",
    "cost",
    "capex",
    "cash_flow",
    "returns",
    "other_financial",
  ]),
  scope_qualifier: z.string().describe(
    "The EXACT basis/scope — e.g. 'Organic Cash EBITDA', 'PF Revenue', " +
    "'acquired-via-M&A (deal-sizing)', 'PEP Cash EBITDA (Organic)', 'Group Revenue (excl-future-M&A)'. " +
    "This field PREVENTS fabrication by distinguishing metrics that share a name but have different scopes."
  ),
  period: z.string().describe("e.g. 'FY Mar-26', 'LTM Sep-26', 'FY23-26 CAGR', 'Jun-26 run-rate'"),
  value: z.number(),
  unit: z.enum(["£m", "%", "x", "£k", "£", "p", "years", "bps", "other"]),
  basis_note: z.string().describe(
    "Free-text: what the number refers to. E.g. 'avg EBITDA acquired per M&A deal', " +
    "'pro-forma revenue including completed acquisitions', 'entry EV / Adj EBITDA'"
  ),
  source_doc: z.string(),
  source_page: z.string().nullable(),
  verbatim_snippet: z.string().describe("The EXACT memo text containing this claim — REQUIRED for auditability"),
  claim_category: z.enum([
    "operating_metric",       // Revenue, EBITDA, margins, costs — reconcilable against operating model
    "deal_mechanics",         // M&A pacing, deal-sizing multiples, IRR targets, exit assumptions
    "valuation_structuring",  // Entry EV, equity check, leverage, structuring EBITDA
    "returns_projection",     // IRR, MoM, DPI — depend on returns model not provided
    "cross_reference",        // Figures referencing external reports (FDD, legal DD, QoE)
  ]).describe(
    "Classification determining whether this claim is reconcilable against the operating model. " +
    "Only 'operating_metric' claims are matched to model lines. Others are tagged but not reconciled."
  ),
});

export type Claim = z.infer<typeof ClaimSchema>;

export interface ClaimsLedger {
  claims: Claim[];
  extraction_metadata: {
    docs_processed: number;
    total_claims: number;
    operating_metric_claims: number;
    deal_mechanics_claims: number;
    valuation_structuring_claims: number;
    returns_projection_claims: number;
    cross_reference_claims: number;
    extraction_model: string;
    extraction_timestamp: string;
  };
}

// ---------------------------------------------------------------------------
// Extraction Prompt
// ---------------------------------------------------------------------------

const CLAIMS_EXTRACTION_PROMPT = `You are a senior private equity analyst performing STRUCTURED CLAIM EXTRACTION from IC memos.

Your job: Extract every quantitative financial claim into a typed ledger with PRECISE scope classification.

## CRITICAL: Scope Classification Rules

The scope_qualifier field is the ANTI-FABRICATION field. It determines whether two numbers CAN be compared.
A wrong scope_qualifier causes false divergence findings — the exact failure mode we are eliminating.

⚠️ ABSOLUTE RULE: scope_qualifier must reflect the ACTUAL BASIS of the number as stated in the memo.
DO NOT default to "Total Group Revenue" or any other generic label. If in doubt, use a more specific scope.

### EBITDA Scope Families (all distinct, never interchangeable):
- "Reported EBITDA" — as per statutory accounts
- "Adjusted EBITDA" — post management adjustments (add-backs, one-offs removed). Use ONLY when the memo explicitly says "Adjusted" without "Non Pro Forma" qualifier.
- "Cash EBITDA (Reported / Non Pro Forma)" — the REPORTED (non-pro-forma) adjusted cash EBITDA from the financials table. ⚠️ When a table is labelled "Non Pro Forma" or "Non-PF", use THIS scope — it is DISTINCT from PEP/management case figures. E.g., "Adj. Cash EBITDA (Non Pro Forma) 33.5 38.7 44.5 54.9" → scope = "Cash EBITDA (Reported / Non Pro Forma)", NOT "Adjusted EBITDA".
- "Cash EBITDA" — standalone usage without "adjusted" or "non-PF" qualifier (e.g., "£55m Cash EBITDA" in deal scorecard)
- "Organic Cash EBITDA" — excludes contribution from recent/pending acquisitions
- "PEP Cash EBITDA (Organic)" — specific to the PEP methodology, organic only. Use when the context explicitly references the "PEP case" or "PEP plan" EBITDA.
- "Run-rate EBITDA" — annualised from a recent period (NOT a full-year actual)
- "Entry EBITDA" — the EBITDA used for entry multiple calculation (may differ from reported)
- "Structuring EBITDA" — basis for leverage/pricing in the deal structure
- "EBITDA acquired via M&A (deal-sizing)" — average per-deal acquired EBITDA for M&A pacing assumptions
  ⚠️ THIS IS NOT ORGANIC EBITDA. "~£4m EBITDA p.a. at 5.5x" in context of M&A deal-sizing = this category.

⚠️ CRITICAL EBITDA DISAMBIGUATION: The model's PEP case may show ~£57m for FY26, while the REPORTED (Non Pro Forma) table shows ~£54.9m for the same year. These are DIFFERENT figures with DIFFERENT scopes. If the table says "Non Pro Forma", scope it "Cash EBITDA (Reported / Non Pro Forma)" — NEVER "Adjusted EBITDA" which would false-match against the PEP figure.

### Revenue Scope Families (all distinct — DO NOT CONFLATE):
- "Total Group Revenue" — ONLY use when the figure explicitly represents all entities, all sources, REPORTED (not adjusted). The headline "£194m revenue" or "FY26 Revenue: £194m" = Total Group Revenue.
- "Revenue (PF / pro-forma)" — ONLY when explicitly labelled "pro-forma" or "PF" or the table header says "Pro Forma"
- "Revenue (LfL / like-for-like)" — organic revenue growth series stripped of acquisition effects. ⚠️ LfL figures are DIFFERENT from Total Group Revenue. E.g., if reported revenue is £125m/£145m/£168m but LfL shows £154m/£166m/£177m, these are DIFFERENT series with DIFFERENT scopes.
- "Revenue (excl-future-M&A)" — group revenue minus uncommitted future M&A
- "Revenue (organic, excl recent acquisitions)" — strips out recent M&A contribution
- "Revenue (run-rate)" — annualised from a recent sub-period
- "Revenue (segment: <segment_name>)" — segment-level revenue, MUST carry the segment name. E.g., "Revenue (segment: Surgery Connect)", "Revenue (segment: IT Services)"

### Operational Rates (NOT revenue, NOT EBITDA — these are distinct metrics):
- "Recurring Revenue %" — percentage of revenue that is recurring (e.g., "96% recurring revenue")
- "Net Revenue Retention (NRR)" — net retention rate (e.g., "102% NRR")
- "Gross Revenue Retention" — before upsell
- "Customer Churn Rate" — percentage of customers lost (e.g., "~5% churn", "7% churn L3Y")
- "Cash Conversion %" — OCF/EBITDA or similar ratio (e.g., "90% cash conversion")
⚠️ These are NEVER "Total Group Revenue" even though they relate to the revenue base. They are rates/percentages describing quality, not absolute revenue figures.

### Market / TAM (NOT company metrics):
- "TAM (market size)" — addressable market size (e.g., "£12.5bn UK B2B comms market")
- "TAM growth rate" — market growth rate (e.g., "growing 3%")
- "Segment TAM (<segment>)" — segment-level market (e.g., "UCaaS seats growing 5%")
⚠️ Market figures are NEVER "Total Group Revenue". They describe the market, not the company's revenue.

### Gross Profit Scope Families:
- "Total Gross Profit" — all-entity, all-source gross profit (reported)
- "Gross Profit (PF / pro-forma)" — pro-forma basis
- "Gross Profit (LfL / like-for-like)" — organic/LfL gross profit, excludes M&A
- "Gross Profit (segment: <segment_name>)" — segment-level GP
- "GP Margin" — gross profit margin as a percentage

### EBITDA Margin vs Absolute:
- "Cash EBITDA Margin" — percentage (e.g., "29% Cash EBITDA margin") — NOT "Cash EBITDA"
- "GP Margin" — gross profit margin percentage

### Valuation/Multiple Families:
- "EV/EBITDA (entry)" — entry valuation basis
- "EV/EBITDA (structuring)" — for leverage/pricing
- "EV/EBITDA (exit)" — assumed exit multiple
- "Per-deal M&A multiple" — price per M&A bolt-on (deal-sizing context)

### Returns:
- "Gross IRR" / "Net IRR" / "MoM" / "DPI" — these depend on a returns model

### Cost / Capex / Other:
- "DD Costs" — due diligence expenditure
- "Capex" — capital expenditure
- "OCF" — operating cash flow (EBITDA - Capex - WC typically)
- "EFCF" — equity free cash flow
- "Pro-forma adjustment" — bridge items (e.g., synergies, trading outperformance)

## CRITICAL: Claim Category Classification

Classify each claim into exactly one category:

1. **operating_metric** — Revenue, EBITDA, margins, costs that relate to the company's OPERATING performance.
   These are reconcilable against the operating/financial model.
   Examples: "£57m Cash EBITDA FY Mar-26", "£194m revenue", "£63m June RR EBITDA", "96% recurring revenue"
   ⚠️ Operational rates (NRR, churn, recurring %) ARE operating_metrics but their scope is the rate name, not "Total Group Revenue"

2. **deal_mechanics** — M&A pacing assumptions, per-deal sizes, bolt-on pipeline, DD costs.
   NOT reconcilable against the operating model (these describe deal activity, not current operations).
   Examples: "~£4m EBITDA acquired p.a. at 5.5x", "~£3m total DD cost"

3. **valuation_structuring** — Entry EV, equity check, leverage ratios, structuring EBITDA.
   May reference operating metrics but the claim itself is about deal structure.
   Examples: "£655m entry EV", "£400m equity at 6.0x", "4.9x net leverage"

4. **returns_projection** — IRR, MoM, DPI. Depend on a returns model not in the operating model.
   Examples: "23.4% gross IRR", "2.9x MoM base case"

5. **cross_reference** — Figures attributed to external reports (FDD findings, legal DD, QoE).
   Examples: "FDD identifies £2.1m normalisation"

## Context Signals for Classification

When a number appears in a sentence about M&A deal-sizing ("acquire ~£X EBITDA at Y.Yx", 
"bolt-on at Zx"), classify as deal_mechanics regardless of the metric name.

When a number is used to compute entry multiples, leverage, or equity sizing, 
classify as valuation_structuring.

When a number projects future returns (IRR, MoM, exit), classify as returns_projection.

## Scope Qualifier Self-Check (MANDATORY before outputting each claim)

Before writing each claim, ask yourself:
1. Is this a COMPANY metric or a MARKET metric? If market → "TAM (market size)" or "TAM growth rate"
2. Is this a RATE/PERCENTAGE describing business quality? If yes → use the specific rate name (NRR, churn, recurring %, cash conversion %, margin)
3. Is this from a LfL/like-for-like/organic series? If yes → "Revenue (LfL / like-for-like)" NOT "Total Group Revenue"
4. Is this from a pro-forma table? If yes → "(PF / pro-forma)"
5. Is this from a segment breakdown? If yes → carry the segment name
6. Only use "Total Group Revenue" if the number genuinely represents ALL reported revenue across the entire group

## Extraction Rules

1. Extract the VERBATIM snippet — the exact text from the memo. This is required.
2. Do NOT invent claims or reinterpret. If a number appears, extract what it SAYS.
3. If the scope is ambiguous, use the most specific scope you can infer from context.
4. For run-rate vs full-year: "June RR" or "annualised from [month]" = run-rate. "FY Mar-26" = full-year.
5. For PF (pro-forma): any revenue/EBITDA explicitly labelled "pro-forma" or "PF" = PF scope.
6. Multiple claims from the same sentence are fine — extract each distinct metric separately.
7. If a claim references another document's finding (e.g. "FDD shows £X"), tag as cross_reference.
8. Preserve the period exactly as stated — don't normalise "FY Mar-26" to "2026".
9. For growth rates (CAGRs), use the scope of what's growing: "Organic Cash EBITDA" CAGR → scope = "Organic Cash EBITDA", NOT "Total Group Revenue".

## Output Format

Return a JSON array of claim objects. Each claim:
{
  "metric": "revenue" | "EBITDA" | "gross_margin" | "net_income" | "net_debt" | "multiple" | "growth_rate" | "cost" | "capex" | "cash_flow" | "returns" | "other_financial",
  "scope_qualifier": "<exact scope — MUST reflect actual basis, never a lazy default>",
  "period": "<period string>",
  "value": <numeric value>,
  "unit": "£m" | "%" | "x" | "£k" | "£" | "p" | "years" | "bps" | "other",
  "basis_note": "<what this number refers to>",
  "source_doc": "<filename>",
  "source_page": "<page/section reference or null>",
  "verbatim_snippet": "<exact text from the memo>",
  "claim_category": "operating_metric" | "deal_mechanics" | "valuation_structuring" | "returns_projection" | "cross_reference"
}

Return ONLY the JSON array. No markdown fences, no commentary.`;

// ---------------------------------------------------------------------------
// DB Schemas
// ---------------------------------------------------------------------------

const MemoDocSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  parsed_text: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * Run structured claim extraction on all IC memos for a deal.
 *
 * @param ctx Pipeline context (db + ai integrations)
 * @param dealId The deal UUID
 * @param pipelineStartTime Pipeline start timestamp for headroom calculations
 * @param timeBudgetMs Maximum time budget for the entire extraction phase
 * @returns ClaimsLedger with all extracted claims
 */
export interface ClaimsExtractionOptions {
  /** When true, calls AI directly without headroom guard (for diagnostics with relaxed timeouts) */
  bypassHeadroom?: boolean;
}

export async function runClaimsExtraction(
  ctx: PipelineContext,
  dealId: string,
  pipelineStartTime: number,
  timeBudgetMs: number,
  options?: ClaimsExtractionOptions,
): Promise<ClaimsLedger> {
  const phaseStart = Date.now();
  console.log(`[ClaimsExtraction] Starting — budget ${Math.round(timeBudgetMs / 1000)}s`);

  // Load all IC memos for this deal
  const memos = await ctx.integrations.db.query(
    `SELECT id, file_name, parsed_text
     FROM documents
     WHERE deal_id = $1 AND document_tag = 'ic_memo' AND parsed_text IS NOT NULL
     ORDER BY uploaded_at ASC`,
    MemoDocSchema,
    [dealId],
    { label: "ClaimsExtraction: load IC memos" },
  );

  if (memos.length === 0) {
    console.log(`[ClaimsExtraction] No IC memos found for deal — skipping`);
    return {
      claims: [],
      extraction_metadata: {
        docs_processed: 0,
        total_claims: 0,
        operating_metric_claims: 0,
        deal_mechanics_claims: 0,
        valuation_structuring_claims: 0,
        returns_projection_claims: 0,
        cross_reference_claims: 0,
        extraction_model: SONNET_MODEL,
        extraction_timestamp: new Date().toISOString(),
      },
    };
  }

  console.log(`[ClaimsExtraction] Found ${memos.length} IC memo(s): ${memos.map(m => m.file_name).join(", ")}`);

  const allClaims: Claim[] = [];

  // Prepare memo extraction tasks
  const validMemos = memos.filter(m => m.parsed_text && m.parsed_text.trim().length > 0);

  // Process memos in parallel (2 concurrent) for time efficiency
  const CONCURRENCY = options?.bypassHeadroom ? 4 : 2;

  const extractMemo = async (memo: { id: string; file_name: string; parsed_text: string | null }) => {
    // Truncate very long memos to fit in context window (Sonnet: ~200K tokens)
    // 150K chars ≈ 37K tokens, leaving plenty for prompt + output
    const rawText = memo.parsed_text ?? "";
    const text = rawText.length > 150_000
      ? rawText.slice(0, 150_000) + "\n\n[TRUNCATED — document exceeds 150K chars]"
      : rawText;

    console.log(`[ClaimsExtraction] Processing: "${memo.file_name}" (${Math.round(text.length / 1000)}K chars)`);

    let response: LLMResponse;
    const llmBody = {
      model: SONNET_MODEL,
      max_tokens: 16_384,
      temperature: 0, // Deterministic extraction — no sampling variance
      system: CLAIMS_EXTRACTION_PROMPT,
      messages: [
        {
          role: "user",
          content: `## Document: ${memo.file_name}\n\nExtract all quantitative financial claims from this IC memo:\n\n${text}`,
        },
      ],
    };

    if (options?.bypassHeadroom) {
      // Direct call — no headroom guard (diagnostic/test path)
      response = await ctx.integrations.ai.apiRequest(
        { method: "POST", path: "/v1/messages", body: llmBody },
        { response: MessageResponseSchema },
        { label: `ClaimsExtraction: ${memo.file_name}` },
      );
    } else {
      // Pipeline path — full headroom guard
      response = await callLLMWithHeadroom(
        ctx,
        llmBody,
        `ClaimsExtraction: ${memo.file_name}`,
        { pipelineStartTime, maxPerCallTimeout: 180_000, retries: 1 },
      );
    }

    // Parse the response
    const responseText = response.content[0]?.text ?? "";
    const claims = parseClaimsResponse(responseText, memo.file_name);

    console.log(
      `[ClaimsExtraction] "${memo.file_name}": ${claims.length} claims ` +
      `(${claims.filter(c => c.claim_category === "operating_metric").length} operating, ` +
      `${claims.filter(c => c.claim_category === "deal_mechanics").length} deal-mechanics, ` +
      `${claims.filter(c => c.claim_category === "valuation_structuring").length} valuation, ` +
      `${claims.filter(c => c.claim_category === "returns_projection").length} returns)`
    );
    return claims;
  };

  // Run with bounded concurrency
  const results = await Promise.allSettled(
    (() => {
      const queue = [...validMemos];
      const inFlight: Promise<Claim[]>[] = [];
      const allPromises: Promise<Claim[]>[] = [];

      function launchNext(): void {
        while (inFlight.length < CONCURRENCY && queue.length > 0) {
          const memo = queue.shift()!;
          const p = extractMemo(memo).finally(() => {
            inFlight.splice(inFlight.indexOf(p), 1);
            launchNext();
          });
          inFlight.push(p);
          allPromises.push(p);
        }
      }
      launchNext();
      return allPromises;
    })()
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      allClaims.push(...result.value);
    } else {
      console.warn(`[ClaimsExtraction] One memo failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  }

  const ledger: ClaimsLedger = {
    claims: allClaims,
    extraction_metadata: {
      docs_processed: memos.length,
      total_claims: allClaims.length,
      operating_metric_claims: allClaims.filter(c => c.claim_category === "operating_metric").length,
      deal_mechanics_claims: allClaims.filter(c => c.claim_category === "deal_mechanics").length,
      valuation_structuring_claims: allClaims.filter(c => c.claim_category === "valuation_structuring").length,
      returns_projection_claims: allClaims.filter(c => c.claim_category === "returns_projection").length,
      cross_reference_claims: allClaims.filter(c => c.claim_category === "cross_reference").length,
      extraction_model: SONNET_MODEL,
      extraction_timestamp: new Date().toISOString(),
    },
  };

  console.log(
    `[ClaimsExtraction] Complete: ${allClaims.length} total claims from ${memos.length} memo(s). ` +
    `Elapsed: ${Math.round((Date.now() - phaseStart) / 1000)}s`
  );

  return ledger;
}

// ---------------------------------------------------------------------------
// Response parser — robust to LLM formatting quirks
// ---------------------------------------------------------------------------

function parseClaimsResponse(responseText: string, sourceFile: string): Claim[] {
  let jsonStr = responseText.trim();

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  } else if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "");
  }

  // Handle case where LLM wraps in { "claims": [...] }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Attempt repair: if JSON array was truncated by max_tokens, find last complete object
    const lastCompleteObj = jsonStr.lastIndexOf("}");
    if (lastCompleteObj > 0) {
      const repaired = jsonStr.slice(0, lastCompleteObj + 1) + "]";
      try {
        parsed = JSON.parse(repaired);
        console.warn(`[ClaimsExtraction] Repaired truncated JSON for ${sourceFile} (cut at char ${lastCompleteObj + 1})`);
      } catch {
        console.warn(`[ClaimsExtraction] JSON parse failed for ${sourceFile} — repair also failed. First 500 chars: ${jsonStr.slice(0, 500)}`);
        return [];
      }
    } else {
      console.warn(`[ClaimsExtraction] JSON parse failed for ${sourceFile}. First 500 chars: ${jsonStr.slice(0, 500)}`);
      return [];
    }
  }

  let rawArray: unknown[];
  if (Array.isArray(parsed)) {
    rawArray = parsed;
  } else if (parsed && typeof parsed === "object" && "claims" in parsed && Array.isArray((parsed as any).claims)) {
    rawArray = (parsed as any).claims;
  } else {
    console.warn(`[ClaimsExtraction] Unexpected response structure for ${sourceFile}: ${typeof parsed}`);
    return [];
  }

  // Validate each claim individually (don't let one bad claim kill the batch)
  const validClaims: Claim[] = [];
  for (const raw of rawArray) {
    try {
      // Ensure source_doc is set correctly (LLM may omit or misname)
      const withSource = { ...raw as object, source_doc: sourceFile };
      const claim = ClaimSchema.parse(withSource);
      validClaims.push(claim);
    } catch {
      // Log but don't fail — partial extraction is better than none
      const label = (raw as any)?.metric ?? "unknown";
      const snippet = (raw as any)?.verbatim_snippet?.slice(0, 60) ?? "";
      console.warn(`[ClaimsExtraction] Skipped invalid claim (${label}): "${snippet}..."`);
    }
  }

  return validClaims;
}
