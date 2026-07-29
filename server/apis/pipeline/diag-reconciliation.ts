/**
 * Diagnostic Reconciliation API — standalone test harness for Phase 2 verification.
 *
 * Runs the full claims extraction → reconciliation pipeline WITHOUT triggering
 * a pipeline run or writing to the database. Read-only diagnostic.
 *
 * Steps:
 *   1. Load numeric report (figures + discrepancies) from the most recent completed
 *      contradiction_check run for the deal.
 *   2. Run claims extraction (same as DiagClaimsExtraction).
 *   3. Run reconciliation against the verified figures.
 *   4. Return all findings in structured format for manual grading.
 *
 * This API is safe to call without consent gate — no data is written.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { runClaimsExtraction, type ClaimsLedger } from "./claims-extraction.js";
import { runReconciliation, type ReconciliationResult, type ReconciliationFinding } from "./claims-reconciliation.js";
import { runNumericVerifyInline, type Figure, type Discrepancy, type NumericVerifyResult } from "./numeric-verify-inline.js";
import type { PipelineContext } from "./pipeline-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

export default api({
  name: "DiagReconciliation",
  description: "Run extraction + reconciliation standalone for diagnostic grading",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string(),
    /** If provided, only return findings on this page (0-based, 10 per page) */
    page: z.number().nullable(),
    /** Max operating_metric claims to send to LLM matching (default: all). Use to stay within time budget. */
    max_claims: z.number().nullable(),
  }),

  output: z.object({
    // Summary counts
    summary: z.object({
      total_findings: z.number(),
      data_divergence: z.number(),
      unreconcilable: z.number(),
      scope_mismatch: z.number(),
      cross_version: z.number(),
      within_tolerance: z.number(),
      reconciled: z.number(),
      extraction_total_claims: z.number(),
      extraction_operating_metrics: z.number(),
      figures_available: z.number(),
      discrepancies_available: z.number(),
    }),
    // Pagination
    pagination: z.object({
      page: z.number(),
      total_pages: z.number(),
      findings_on_page: z.number(),
    }),
    // Diagnostic: reconciliation error if any
    reco_error: z.string().nullable(),
    // Findings (paginated, structured for grading)
    findings: z.array(z.object({
      finding_kind: z.string(),
      severity: z.string(),
      title: z.string(),
      detail: z.string(),
      full_analysis: z.string(),
      // Source claim fields (null for cross_version)
      claim_metric: z.string().nullable(),
      claim_scope: z.string().nullable(),
      claim_period: z.string().nullable(),
      claim_value: z.string().nullable(),
      claim_source_doc: z.string().nullable(),
      // Model figure matched (null if unreconcilable)
      model_label: z.string().nullable(),
      model_period: z.string().nullable(),
      model_value_m: z.string().nullable(),
      // Code-computed delta
      delta_abs_m: z.string().nullable(),
      delta_pct: z.string().nullable(),
      // Source docs
      source_docs: z.array(z.string()),
    })),
  }),

  async run(ctx, { dealId, page, max_claims }) {
    const startTime = Date.now();

    const pipelineCtx: PipelineContext = {
      integrations: {
        db: ctx.integrations.db,
        ai: ctx.integrations.ai,
      },
    };

    // --- Steps 1+2 (parallel): Numeric figures + Claims extraction ---
    // These are independent: numeric reads model tables, extraction reads IC memos + AI.
    // Running in parallel cuts total time from ~240s to ~180s.
    const [numericResult, ledger] = await Promise.all([
      // Numeric verify inline
      runNumericVerifyInline(ctx.integrations.db, dealId, 60_000)
        .then(result => {
          console.log(
            `[DiagReconciliation] Numeric inline: ${result.figures.length} figures, ` +
            `${result.discrepancies.length} discrepancies, partial=${result.partial}`
          );
          return result;
        })
        .catch(err => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[DiagReconciliation] Numeric inline failed: ${msg}`);
          return { figures: [] as Figure[], discrepancies: [] as Discrepancy[], partial: false, documentsProcessed: 0, documentsTotal: 0, tablesLoaded: 0, tablesTotal: 0 } as NumericVerifyResult;
        }),
      // Claims extraction
      runClaimsExtraction(pipelineCtx, dealId, startTime, 300_000, { bypassHeadroom: true }),
    ]);

    const figures = numericResult.figures;
    const discrepancies = numericResult.discrepancies;

    console.log(`[DiagReconciliation] Extracted ${ledger.claims.length} claims (${ledger.extraction_metadata.operating_metric_claims} operating_metric)`);

    // --- Step 3: Run reconciliation ---
    // Use a fresh start time for reconciliation's headroom calculations.
    // DiagReconciliation runs in a testApi context with 500s timeout — the platform
    // won't kill us at 300s. The extraction phase already consumed most of the
    // original startTime budget, so we reset to avoid headroom exhaustion.
    const recoStartTime = Date.now();

    // If max_claims is set, limit the operating_metric claims sent to matching
    let effectiveLedger = ledger;
    if (max_claims && max_claims > 0) {
      const opClaims = ledger.claims.filter(c => c.claim_category === "operating_metric").slice(0, max_claims);
      const otherClaims = ledger.claims.filter(c => c.claim_category !== "operating_metric");
      effectiveLedger = {
        ...ledger,
        claims: [...opClaims, ...otherClaims],
        extraction_metadata: {
          ...ledger.extraction_metadata,
          operating_metric_claims: opClaims.length,
        },
      };
    }

    let reconciliation: ReconciliationResult;
    let recoError: string | null = null;
    if (figures.length > 0) {
      try {
        reconciliation = await runReconciliation(
          pipelineCtx,
          effectiveLedger,
          figures,
          discrepancies,
          recoStartTime,
          180_000, // 3 min budget for reconciliation
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recoError = msg;
        console.warn(`[DiagReconciliation] Reconciliation threw: ${msg}`);
        reconciliation = {
          findings: [],
          reconciled_count: 0,
          unreconcilable_count: ledger.extraction_metadata.operating_metric_claims,
          scope_mismatch_count: 0,
          within_tolerance_count: 0,
          cross_version_findings: 0,
        };
      }
    } else {
      // No figures — everything is unreconcilable
      reconciliation = {
        findings: [],
        reconciled_count: 0,
        unreconcilable_count: ledger.extraction_metadata.operating_metric_claims,
        scope_mismatch_count: 0,
        within_tolerance_count: 0,
        cross_version_findings: 0,
      };
      console.warn(`[DiagReconciliation] No figures available — all claims unreconcilable`);
    }

    // --- Step 4: Format output for grading ---
    const allFindings = reconciliation.findings;
    const PAGE_SIZE = 10;
    const pageNum = page ?? 0;
    const totalPages = Math.ceil(allFindings.length / PAGE_SIZE);
    const pagedFindings = allFindings.slice(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE);

    const formattedFindings = pagedFindings.map((rf: ReconciliationFinding) => ({
      finding_kind: rf.finding_kind,
      severity: rf.severity,
      title: rf.title,
      detail: rf.detail,
      full_analysis: rf.full_analysis,
      claim_metric: rf.claim?.metric ?? null,
      claim_scope: rf.claim?.scope_qualifier ?? null,
      claim_period: rf.claim?.period ?? null,
      claim_value: rf.claim ? `${rf.claim.value}${rf.claim.unit}` : null,
      claim_source_doc: rf.claim?.source_doc ?? null,
      model_label: rf.model_figure?.name ?? null,
      model_period: rf.model_figure?.period ?? null,
      model_value_m: rf.model_figure ? `£${(rf.model_figure.value / 1_000_000).toFixed(2)}m` : null,
      delta_abs_m: rf.delta_abs != null ? `£${(rf.delta_abs / 1_000_000).toFixed(2)}m` : null,
      delta_pct: rf.delta_pct != null ? `${(rf.delta_pct * 100).toFixed(1)}%` : null,
      source_docs: rf.source_docs,
    }));

    const summary = {
      total_findings: allFindings.length,
      data_divergence: allFindings.filter(f => f.finding_kind === "data_divergence").length,
      unreconcilable: allFindings.filter(f => f.finding_kind === "unreconcilable").length,
      scope_mismatch: allFindings.filter(f => f.finding_kind === "scope_mismatch").length,
      cross_version: allFindings.filter(f => f.finding_kind === "cross_version").length,
      within_tolerance: reconciliation.within_tolerance_count,
      reconciled: reconciliation.reconciled_count,
      extraction_total_claims: effectiveLedger.claims.length,
      extraction_operating_metrics: effectiveLedger.extraction_metadata.operating_metric_claims,
      figures_available: figures.length,
      discrepancies_available: discrepancies.length,
    };

    const pagination = {
      page: pageNum,
      total_pages: totalPages,
      findings_on_page: pagedFindings.length,
    };

    console.log(
      `[DiagReconciliation] Complete: ${summary.total_findings} findings ` +
      `(${summary.data_divergence} divergence, ${summary.unreconcilable} unreconcilable, ` +
      `${summary.scope_mismatch} scope_mismatch, ${summary.cross_version} cross_version). ` +
      `Elapsed: ${Math.round((Date.now() - startTime) / 1000)}s`
    );

    return { summary, pagination, reco_error: recoError ?? reconciliation.matching_error ?? null, findings: formattedFindings };
  },
});
