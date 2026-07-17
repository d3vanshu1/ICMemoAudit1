import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * Temporary diagnostic: Check if the merged BSS output references 3rd IC Memo / IC Update,
 * and fetch raw analysis for specific chunk indices.
 */
export default api({
  name: "DiagnoseChunkDetail",
  description: "Fetches raw analysis for specific chunks and checks report references",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    chunkIndices: z.array(z.number()),
  }),

  output: z.object({
    // Does the final report mention these docs?
    reportReferences: z.object({
      mentions3rdICMemo: z.boolean(),
      mentionsICUpdate: z.boolean(),
      mentionsScreeningMemo: z.boolean(),
      mentions2ndICMemo: z.boolean(),
      mentionsIM: z.boolean(),
      reportLength: z.number(),
    }),
    // Raw analysis for requested chunks
    chunkDetails: z.array(z.object({
      chunkIndex: z.number(),
      label: z.string().nullable(),
      truncated: z.boolean(),
      extractionSnippet: z.string(),
    })),
  }),

  async run(ctx, { runId, chunkIndices }) {
    // 1. Get the full report
    const outputs = await ctx.integrations.db.query(
      `SELECT full_report_markdown
       FROM module_outputs
       WHERE module_run_id = $1
       LIMIT 1`,
      z.object({ full_report_markdown: z.string().nullable() }),
      [runId],
      { label: "Full report for reference check" }
    );

    const report = outputs[0]?.full_report_markdown ?? "";

    const reportReferences = {
      mentions3rdICMemo: /3rd IC Memo|3rd IC|15 June|15\/06|2026-06-15/i.test(report),
      mentionsICUpdate: /IC Update|IC update|21 June|21\/06|2026-06-21/i.test(report),
      mentionsScreeningMemo: /Screening Memo/i.test(report),
      mentions2ndICMemo: /2nd IC Memo|2nd IC|18 May|18\/05|2026-05-18/i.test(report),
      mentionsIM: /IM_vF|Information Memorandum|\bIM\b/i.test(report),
      reportLength: report.length,
    };

    // 2. Get raw analysis for specific chunk indices
    const placeholders = chunkIndices.map((_, i) => `$${i + 2}`).join(", ");
    const chunkRows = await ctx.integrations.db.query(
      `SELECT chunk_index,
              result_json->>'label' AS label,
              COALESCE((result_json->>'truncated')::boolean, false) AS truncated,
              LEFT(result_json->>'extraction', 3000) AS extraction_snippet
       FROM pipeline_analysis
       WHERE run_id = $1 AND chunk_index IN (${placeholders})
       ORDER BY chunk_index`,
      z.object({
        chunk_index: z.coerce.number(),
        label: z.string().nullable(),
        truncated: z.coerce.boolean(),
        extraction_snippet: z.string().nullable(),
      }),
      [runId, ...chunkIndices],
      { label: "Raw analysis for specific chunks" }
    );

    const chunkDetails = chunkRows.map(r => ({
      chunkIndex: r.chunk_index,
      label: r.label,
      truncated: r.truncated,
      extractionSnippet: r.extraction_snippet ?? "",
    }));

    return { reportReferences, chunkDetails };
  },
});
