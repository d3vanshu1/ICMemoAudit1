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
    // Optional filter: only return claims for this category. If null, returns all.
    category_filter: z.enum(["operating_metric", "deal_mechanics", "valuation_structuring", "returns_projection", "cross_reference"]).nullable(),
    // Pagination: 0-based page number (50 claims per page)
    page: z.number().nullable(),
  }),

  output: z.object({
    // Compact pipe-delimited ledger — fits within testApi response size limit
    // Format: metric | scope_qualifier | period | value | unit | claim_category | source_doc | source_page | verbatim_snippet
    tsv_ledger: z.string(),
    // Pagination info
    pagination: z.object({
      page: z.number(),
      total_pages: z.number(),
      claims_on_page: z.number(),
      total_claims_filtered: z.number(),
      category_filter_applied: z.string().nullable(),
    }),
    // Category breakdown counts (always reflects full ledger, unfiltered)
    category_counts: z.object({
      operating_metric: z.number(),
      deal_mechanics: z.number(),
      valuation_structuring: z.number(),
      returns_projection: z.number(),
      cross_reference: z.number(),
      total: z.number(),
      docs_processed: z.number(),
    }),
    // Scope summary for diagnostic review (reflects filtered set)
    scope_summary: z.array(z.object({
      scope_qualifier: z.string(),
      count: z.number(),
      category: z.string(),
      example_snippet: z.string(),
    })),
  }),

  async run(ctx, { dealId, category_filter, page }) {
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

    // Apply category filter if specified
    let filteredClaims = ledger.claims;
    if (category_filter) {
      filteredClaims = ledger.claims.filter((c) => c.claim_category === category_filter);
    }

    // Apply pagination (50 claims per page)
    const PAGE_SIZE = 50;
    const pageNum = page ?? 0;
    const totalPages = Math.ceil(filteredClaims.length / PAGE_SIZE);
    const pagedClaims = filteredClaims.slice(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE);

    // Build compact pipe-delimited ledger (much smaller than JSON)
    const header = "metric|scope_qualifier|period|value|unit|claim_category|source_doc|source_page|verbatim_snippet";
    const rows = pagedClaims.map((c) => {
      const sanitize = (s: string) => (s || "").replace(/\|/g, "/").replace(/\n/g, " ").trim();
      return [
        sanitize(c.metric),
        sanitize(c.scope_qualifier),
        sanitize(c.period),
        sanitize(String(c.value)),
        sanitize(c.unit),
        sanitize(c.claim_category),
        sanitize(c.source_doc).slice(0, 40), // truncate long filenames
        sanitize(String(c.source_page)),
        sanitize(c.verbatim_snippet).slice(0, 150), // cap snippet length
      ].join("|");
    });
    const tsv_ledger = [header, ...rows].join("\n");

    // Category counts (always full ledger, unfiltered)
    const category_counts = {
      operating_metric: ledger.extraction_metadata.operating_metric_claims,
      deal_mechanics: ledger.extraction_metadata.deal_mechanics_claims,
      valuation_structuring: ledger.extraction_metadata.valuation_structuring_claims,
      returns_projection: ledger.extraction_metadata.returns_projection_claims,
      cross_reference: ledger.extraction_metadata.cross_reference_claims,
      total: ledger.extraction_metadata.total_claims,
      docs_processed: ledger.extraction_metadata.docs_processed,
    };

    // Pagination metadata
    const pagination = {
      page: pageNum,
      total_pages: totalPages,
      claims_on_page: pagedClaims.length,
      total_claims_filtered: filteredClaims.length,
      category_filter_applied: category_filter ?? null,
    };

    // Build scope summary from filtered claims (not paged — shows full category breakdown)
    const scopeMap = new Map<string, { count: number; category: string; example: string }>();
    for (const claim of filteredClaims) {
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

    return { tsv_ledger, pagination, category_counts, scope_summary };
  },
});
