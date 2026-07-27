/**
 * Standalone NumericVerify API — delegates to the inline engine.
 *
 * This API exists for the DealDashboard to call directly (with moduleRunId
 * and documentIds). It resolves deal_id from the documents table, delegates
 * all verification logic to runNumericVerifyInline(), persists results to
 * numeric_reports, and returns the standard output shape.
 *
 * REWRITTEN 2026-07-27: Now delegates to numeric-verify-inline.ts instead of
 * maintaining a separate copy of the verification logic. The inline engine is
 * the single source of truth for all numeric verification.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  runNumericVerifyInline,
  type NumericVerifyResult,
  type Figure,
  type Discrepancy,
} from "../pipeline/numeric-verify-inline.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Output Schemas
// ---------------------------------------------------------------------------

const FigureSchema = z.object({
  name: z.string(),
  period: z.string(),
  value: z.number(),
  source_doc: z.string(),
  source_cell: z.string(),
  source_sheet: z.string(),
});

const DiscrepancySchema = z.object({
  description: z.string(),
  severity: z.enum(["critical", "warning", "info"]),
  check_type: z.enum(["cross_doc_agreement"]),
  sources: z.array(z.string()),
  period: z.string(),
  metrics: z.array(
    z.object({
      label: z.string(),
      sourceA: z.number(),
      sourceB: z.number(),
      absDiff: z.number(),
      relDiffPct: z.number(),
    })
  ),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "NumericVerify",
  description: "Runs deterministic numeric verification on doc_tables for a deal run",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    moduleRunId: z.string().uuid(),
    documentIds: z.array(z.string()),
  }),

  output: z.object({
    numericReportId: z.string().nullable(),
    figureCount: z.number(),
    discrepancyCount: z.number(),
    criticalCount: z.number(),
    figures: z.array(FigureSchema),
    discrepancies: z.array(DiscrepancySchema),
    partial: z.boolean(),
    documentsProcessed: z.number(),
    documentsTotal: z.number(),
    tablesLoaded: z.number(),
    tablesTotal: z.number(),
  }),

  async run(ctx, { moduleRunId, documentIds }) {
    if (documentIds.length === 0) {
      return {
        numericReportId: null,
        figureCount: 0,
        discrepancyCount: 0,
        criticalCount: 0,
        figures: [],
        discrepancies: [],
        partial: false,
        documentsProcessed: 0,
        documentsTotal: 0,
        tablesLoaded: 0,
        tablesTotal: 0,
      };
    }

    // Resolve deal_id from the documents table using the provided documentIds.
    // The inline engine needs deal_id to find all doc_tables for the deal.
    const DealIdSchema = z.object({ deal_id: z.string() });
    const dealIdRows = await ctx.integrations.db.query(
      `SELECT DISTINCT deal_id FROM documents WHERE id = ANY($1::uuid[])`,
      DealIdSchema,
      [documentIds],
      { label: "Resolve deal_id from documentIds" }
    );

    if (dealIdRows.length === 0) {
      ctx.log.warn(`[NumericVerify] No deal found for documents [${documentIds.join(", ")}]`);
      return {
        numericReportId: null,
        figureCount: 0,
        discrepancyCount: 0,
        criticalCount: 0,
        figures: [],
        discrepancies: [],
        partial: false,
        documentsProcessed: 0,
        documentsTotal: documentIds.length,
        tablesLoaded: 0,
        tablesTotal: 0,
      };
    }

    const dealId = dealIdRows[0].deal_id;

    // Delegate to the inline engine — 270s budget (30s headroom under 300s platform limit)
    const TIME_BUDGET_MS = 270_000;
    const result: NumericVerifyResult = await runNumericVerifyInline(
      ctx.integrations.db,
      dealId,
      TIME_BUDGET_MS
    );

    // Persist to numeric_reports
    const reportRows = await ctx.integrations.db.query(
      `INSERT INTO numeric_reports (module_run_id, figures, discrepancies)
       VALUES ($1, $2, $3)
       RETURNING id`,
      z.object({ id: z.string() }),
      [
        moduleRunId,
        JSON.stringify(result.figures),
        JSON.stringify(result.discrepancies),
      ],
      { label: "Save numeric_reports" }
    );

    const numericReportId = reportRows[0]?.id ?? null;
    const criticalCount = result.discrepancies.filter((d) => d.severity === "critical").length;

    if (result.partial) {
      ctx.log.warn(
        `[NumericVerify] PARTIAL report: ${result.documentsProcessed}/${result.documentsTotal} docs, ` +
        `${result.tablesLoaded}/${result.tablesTotal} tables loaded. ` +
        `Downstream modules will be explicitly warned that numeric grounding is incomplete.`
      );
    }

    ctx.log.info(
      `NumericVerify: ${result.figures.length} figures, ${result.discrepancies.length} discrepancies`
    );

    return {
      numericReportId,
      figureCount: result.figures.length,
      discrepancyCount: result.discrepancies.length,
      criticalCount,
      figures: result.figures,
      discrepancies: result.discrepancies,
      partial: result.partial,
      documentsProcessed: result.documentsProcessed,
      documentsTotal: result.documentsTotal,
      tablesLoaded: result.tablesLoaded,
      tablesTotal: result.tablesTotal,
    };
  },
});
