import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const RunRowSchema = z.object({
  id: z.string(),
  module_id: z.string(),
  status: z.string(),
  triggered_at: z.string(),
  completed_at: z.string().nullable(),
  documents_included: z.any(),
});

const CountSchema = z.object({ cnt: z.coerce.number() });

const ExtractionCountSchema = z.object({
  total: z.coerce.number(),
});

const ErrorCheckpointSchema = z.object({
  error_text: z.string().nullable(),
});

export default api({
  name: "GetRunProgress",
  description: "Returns per-module run progress with extraction/merge counts and checkpoint errors",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    extractionCount: z.number(),
    runs: z.array(
      z.object({
        runId: z.string(),
        moduleId: z.string(),
        status: z.string(),
        triggeredAt: z.string(),
        completedAt: z.string().nullable(),
        documentsIncluded: z.array(z.string()),
        analysisCheckpointCount: z.number(),
        mergeCheckpointCount: z.number(),
        // Errors surfaced from checkpoint JSONB (if any)
        checkpointErrors: z.array(z.string()),
      })
    ),
  }),

  async run(ctx, { dealId }) {
    // Count universal extractions for this deal
    const extRows = await ctx.integrations.db.query(
      `SELECT COUNT(*) AS total FROM universal_extractions WHERE deal_id = $1`,
      ExtractionCountSchema,
      [dealId],
      { label: "Count extractions" }
    );
    const extractionCount = extRows[0]?.total ?? 0;

    // Get in-progress / recent runs (only existing enum values)
    const runs = await ctx.integrations.db.query(
      `SELECT id, module_id, status, triggered_at, completed_at, documents_included
       FROM module_runs
       WHERE deal_id = $1
         AND status IN ('running', 'pending', 'failed')
       ORDER BY triggered_at DESC
       LIMIT 50`,
      RunRowSchema,
      [dealId],
      { label: "Get active/recent runs" }
    );

    // For each run, count analysis + merge checkpoints + surface errors from JSONB
    const result = [];
    for (const run of runs) {
      // Count analysis checkpoints for this run
      const analysisRows = await ctx.integrations.db.query(
        `SELECT COUNT(*) AS cnt FROM pipeline_analysis WHERE run_id = $1`,
        CountSchema,
        [run.id],
        { label: `Count analysis checkpoints for ${run.module_id}` }
      );

      const ckptRows = await ctx.integrations.db.query(
        `SELECT COUNT(*) AS cnt FROM merge_checkpoints WHERE module_run_id = $1`,
        CountSchema,
        [run.id],
        { label: `Count merge checkpoints for ${run.module_id}` }
      );

      // Surface errors from merge checkpoint JSONB
      const errorRows = await ctx.integrations.db.query(
        `SELECT merged_json->>'error' AS error_text
         FROM merge_checkpoints
         WHERE module_run_id = $1
           AND merged_json ? 'error'
         LIMIT 10`,
        ErrorCheckpointSchema,
        [run.id],
        { label: `Get checkpoint errors for ${run.module_id}` }
      );

      const docsIncluded = Array.isArray(run.documents_included)
        ? run.documents_included.map(String)
        : [];

      result.push({
        runId: run.id,
        moduleId: run.module_id,
        status: run.status,
        triggeredAt: run.triggered_at,
        completedAt: run.completed_at,
        documentsIncluded: docsIncluded,
        analysisCheckpointCount: analysisRows[0]?.cnt ?? 0,
        mergeCheckpointCount: ckptRows[0]?.cnt ?? 0,
        checkpointErrors: errorRows
          .map((r) => r.error_text)
          .filter((e): e is string => e !== null),
      });
    }

    return { extractionCount, runs: result };
  },
});
