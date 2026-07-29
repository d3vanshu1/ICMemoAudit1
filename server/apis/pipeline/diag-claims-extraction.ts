/**
 * Diagnostic API: Run structured claim extraction on a deal's IC memos.
 *
 * Standalone test harness for Phase 1 verification of the claims-reconciliation loop.
 * Outputs the full claims ledger for manual inspection against the source-of-truth report.
 *
 * Does NOT trigger a pipeline run — safe to execute without consent gate.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { runClaimsExtraction, type ClaimsLedger } from "./claims-extraction.js";
import type { PipelineContext } from "./pipeline-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

export default api({
  name: "DiagClaimsExtraction",
  description: "Run structured claim extraction on IC memos for diagnostic inspection",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    ledger: z.object({
      claims: z.array(z.any()),
      extraction_metadata: z.object({
        docs_processed: z.number(),
        total_claims: z.number(),
        operating_metric_claims: z.number(),
        deal_mechanics_claims: z.number(),
        valuation_structuring_claims: z.number(),
        returns_projection_claims: z.number(),
        cross_reference_claims: z.number(),
        extraction_model: z.string(),
        extraction_timestamp: z.string(),
      }),
    }),
    // Diagnostic breakdowns
    scope_summary: z.array(z.object({
      scope_qualifier: z.string(),
      count: z.number(),
      category: z.string(),
      example_snippet: z.string(),
    })),
  }),

  async run(ctx, { dealId }) {
    const pipelineStartTime = Date.now();

    // Construct pipeline context compatible with claims-extraction
    const pipelineCtx: PipelineContext = {
      integrations: {
        db: ctx.integrations.db,
        ai: ctx.integrations.ai,
      },
    };

    // Run extraction with a generous time budget and bypassed headroom (diagnostic, no pipeline constraints)
    const ledger: ClaimsLedger = await runClaimsExtraction(
      pipelineCtx,
      dealId,
      pipelineStartTime,
      600_000, // 10 minutes — diagnostic has relaxed testApi timeout
      { bypassHeadroom: true },
    );

    // Build scope summary for diagnostic review
    const scopeMap = new Map<string, { count: number; category: string; example: string }>();
    for (const claim of ledger.claims) {
      const key = claim.scope_qualifier;
      const existing = scopeMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        scopeMap.set(key, {
          count: 1,
          category: claim.claim_category,
          example: claim.verbatim_snippet.slice(0, 120),
        });
      }
    }

    const scope_summary = Array.from(scopeMap.entries())
      .map(([scope, data]) => ({
        scope_qualifier: scope,
        count: data.count,
        category: data.category,
        example_snippet: data.example,
      }))
      .sort((a, b) => b.count - a.count);

    return { ledger, scope_summary };
  },
});
