import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * Diagnostic: For a given module run, compare:
 *  - Extraction cache (universal_extractions) for the deal
 *  - Which chunks were routed to this module (by tag relevance)
 *  - Which chunks actually have analysis checkpoints (pipeline_analysis)
 * Surfaces dropped chunks and identifies if a document was never analyzed.
 */

const MODULE_TAG_RELEVANCE: Record<string, Set<string>> = {
  omission_audit: new Set(["cim", "ic_memo", "customer_data", "consultant_report", "financial_model", "legal", "other"]),
  contradiction_check: new Set(["cim", "ic_memo", "customer_data", "consultant_report", "financial_model", "legal", "other"]),
  blind_spot_scanner: new Set(["cim", "ic_memo", "consultant_report", "financial_model", "other"]),
  external_risk_overlay: new Set(["cim", "ic_memo", "customer_data", "consultant_report", "legal", "other"]),
  social_reputation: new Set(["cim", "ic_memo", "consultant_report", "customer_data", "other"]),
  ic_challenge_mode: new Set(["cim", "ic_memo", "consultant_report", "financial_model", "other"]),
  model_assumptions_stress: new Set(["ic_memo", "financial_model", "cim", "consultant_report", "other"]),
  diligence_completeness: new Set(["cim", "ic_memo", "customer_data", "consultant_report", "financial_model", "legal", "other"]),
};

export default api({
  name: "DiagnoseChunkCoverage",
  description: "Compares extracted vs. routed vs. analyzed chunks for a module run",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    dealId: z.string(),
    moduleId: z.string().nullable().optional(),
  }),

  output: z.object({
    moduleId: z.string().nullable(),
    totalExtracted: z.number(),
    totalRoutedByTag: z.number(),
    totalAnalyzed: z.number(),
    droppedCount: z.number(),
    perDocument: z.array(z.object({
      fileName: z.string(),
      documentId: z.string(),
      extractedChunks: z.number(),
      routedChunks: z.number(),
      analyzedChunks: z.number(),
      tag: z.string(),
      droppedIndices: z.array(z.number()),
    })),
    // First 10 analysis rows — to check which docs are referenced
    analysisSample: z.array(z.object({
      chunkIndex: z.number(),
      label: z.string().nullable(),
      truncated: z.boolean(),
    })),
    // The merged output snippet — check what docs are cited
    mergedOutputSnippet: z.string().nullable(),
    // Runtime metadata
    runDurationSeconds: z.number().nullable(),
    runStatus: z.string().nullable(),
  }),

  async run(ctx, { runId, dealId, moduleId: inputModuleId }) {
    // 0. Get the run metadata (module_id, status, timing)
    const runMeta = await ctx.integrations.db.query(
      `SELECT module_id, status::text AS status,
              EXTRACT(EPOCH FROM (COALESCE(completed_at, now()) - triggered_at))::int AS duration_s
       FROM module_runs
       WHERE id = $1
       LIMIT 1`,
      z.object({
        module_id: z.string(),
        status: z.string(),
        duration_s: z.coerce.number().nullable(),
      }),
      [runId],
      { label: "Get run metadata" }
    );

    const moduleId = inputModuleId || runMeta[0]?.module_id || "unknown";
    const relevantTags = MODULE_TAG_RELEVANCE[moduleId] ?? new Set(["other"]);

    // 1. Get all extraction rows with their tags
    const extracted = await ctx.integrations.db.query(
      `SELECT ue.document_id, ue.chunk_index, d.file_name,
              ue.extraction_json->>'documentTag' AS tag,
              COALESCE((ue.extraction_json->>'failed')::boolean, false) AS failed
       FROM universal_extractions ue
       JOIN documents d ON d.id = ue.document_id
       WHERE ue.deal_id = $1
       ORDER BY ue.document_id, ue.chunk_index`,
      z.object({
        document_id: z.string(),
        chunk_index: z.coerce.number(),
        file_name: z.string(),
        tag: z.string().nullable(),
        failed: z.coerce.boolean(),
      }),
      [dealId],
      { label: "All extraction chunks with tags" }
    );

    // 2. Determine which chunks would be routed (same logic as pipeline-core)
    const routed = extracted.filter(row => {
      if (row.failed) return false;
      const tag = row.tag ?? "other";
      return relevantTags.has(tag);
    });

    // 3. Get analysis checkpoints for this run
    const analyzed = await ctx.integrations.db.query(
      `SELECT chunk_index,
              result_json->>'label' AS label,
              COALESCE((result_json->>'truncated')::boolean, false) AS truncated
       FROM pipeline_analysis
       WHERE run_id = $1
       ORDER BY chunk_index`,
      z.object({
        chunk_index: z.coerce.number(),
        label: z.string().nullable(),
        truncated: z.coerce.boolean(),
      }),
      [runId],
      { label: "Analysis checkpoints for run" }
    );

    // 4. Get the merged output
    const outputs = await ctx.integrations.db.query(
      `SELECT full_report_markdown
       FROM module_outputs
       WHERE module_run_id = $1
       LIMIT 1`,
      z.object({ full_report_markdown: z.string().nullable() }),
      [runId],
      { label: "Module output for run" }
    );

    // 5. Build per-document coverage
    // pipeline_analysis chunk_index = position in the routed array (0-based)
    const analyzedIndices = new Set(analyzed.map(a => a.chunk_index));

    type DocInfo = { fileName: string; documentId: string; extracted: number; routedIndices: number[]; tag: string };
    const docMap = new Map<string, DocInfo>();

    for (const row of extracted) {
      if (!docMap.has(row.document_id)) {
        docMap.set(row.document_id, {
          fileName: row.file_name,
          documentId: row.document_id,
          extracted: 0,
          routedIndices: [],
          tag: row.tag ?? "other",
        });
      }
      docMap.get(row.document_id)!.extracted++;
    }

    // Mark which routed index each document's chunks got
    for (let i = 0; i < routed.length; i++) {
      const doc = docMap.get(routed[i].document_id);
      if (doc) doc.routedIndices.push(i);
    }

    const perDocument = Array.from(docMap.values()).map(doc => {
      const analyzedForDoc = doc.routedIndices.filter(idx => analyzedIndices.has(idx));
      const droppedIndices = doc.routedIndices.filter(idx => !analyzedIndices.has(idx));
      return {
        fileName: doc.fileName,
        documentId: doc.documentId,
        extractedChunks: doc.extracted,
        routedChunks: doc.routedIndices.length,
        analyzedChunks: analyzedForDoc.length,
        tag: doc.tag,
        droppedIndices,
      };
    });

    // 6. Analysis sample
    const analysisSample = analyzed.slice(0, 10).map(a => ({
      chunkIndex: a.chunk_index,
      label: a.label,
      truncated: a.truncated,
    }));

    // 7. Output snippet (first 2000 chars of merged report)
    const report = outputs[0]?.full_report_markdown ?? null;
    const mergedOutputSnippet = report ? report.slice(0, 2000) : null;

    const droppedCount = routed.length - analyzed.length;

    return {
      moduleId,
      totalExtracted: extracted.length,
      totalRoutedByTag: routed.length,
      totalAnalyzed: analyzed.length,
      droppedCount: droppedCount > 0 ? droppedCount : 0,
      perDocument,
      analysisSample,
      mergedOutputSnippet,
      runDurationSeconds: runMeta[0]?.duration_s ?? null,
      runStatus: runMeta[0]?.status ?? null,
    };
  },
});
