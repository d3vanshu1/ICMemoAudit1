/**
 * Diagnostic API — traces a specific finding back through extractions and merge rounds.
 * Searches pipeline_analysis result_json and merge_checkpoints merged_json for keyword matches.
 * NOT production code — for debugging finding provenance.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const AnalysisHitSchema = z.object({
  chunk_index: z.coerce.number(),
  result_snippet: z.string(),
  model_used: z.string().nullable(),
});

const MergeHitSchema = z.object({
  tree_level: z.coerce.number(),
  node_index: z.coerce.number(),
  merged_snippet: z.string(),
  model_used: z.string().nullable(),
});

export default api({
  name: "DiagnoseFindingTrace",
  description: "Searches extraction and merge checkpoints for keyword matches to trace finding provenance",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    searchTerm: z.string().describe("Keyword to search for in result_json / merged_json (case-insensitive ILIKE)"),
    contextChars: z.number().nullable().optional().describe("How many chars around the match to return (default 500)"),
    maxHits: z.number().nullable().optional().describe("Max results per category (default 10)"),
  }),

  output: z.object({
    analysisHits: z.array(AnalysisHitSchema),
    mergeHits: z.array(MergeHitSchema),
    analysisHitCount: z.number(),
    mergeHitCount: z.number(),
  }),

  async run(ctx, { runId, searchTerm, contextChars, maxHits }) {
    const ctxChars = contextChars ?? 500;
    const limit = maxHits ?? 10;
    const pattern = `%${searchTerm}%`;

    // Search pipeline_analysis result_json for the term
    const analysisRows = await ctx.integrations.db.query(
      `SELECT chunk_index,
              SUBSTRING(result_json::text FROM GREATEST(1, POSITION(LOWER($2) IN LOWER(result_json::text)) - ${Math.floor(ctxChars / 2)}) FOR ${ctxChars}) AS result_snippet,
              model_used
       FROM pipeline_analysis
       WHERE run_id = $1 AND result_json::text ILIKE $3
       ORDER BY chunk_index
       LIMIT ${limit}`,
      AnalysisHitSchema,
      [runId, searchTerm, pattern],
      { label: "Search pipeline_analysis for keyword" }
    );

    // Search merge_checkpoints merged_json for the term
    const mergeRows = await ctx.integrations.db.query(
      `SELECT tree_level, node_index,
              SUBSTRING(merged_json::text FROM GREATEST(1, POSITION(LOWER($2) IN LOWER(merged_json::text)) - ${Math.floor(ctxChars / 2)}) FOR ${ctxChars}) AS merged_snippet,
              model_used
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND merged_json::text ILIKE $3
       ORDER BY tree_level, node_index
       LIMIT ${limit}`,
      MergeHitSchema,
      [runId, searchTerm, pattern],
      { label: "Search merge_checkpoints for keyword" }
    );

    return {
      analysisHits: analysisRows,
      mergeHits: mergeRows,
      analysisHitCount: analysisRows.length,
      mergeHitCount: mergeRows.length,
    };
  },
});
