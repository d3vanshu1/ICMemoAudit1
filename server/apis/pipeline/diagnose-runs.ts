/**
 * Diagnostic API — shows recent module_runs for a deal.
 * NOT production code — used to inspect stuck/stale pipeline state.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const RunRowSchema = z.object({
  id: z.string(),
  module_id: z.string(),
  status: z.string(),
  triggered_at: z.string(),
  completed_at: z.string().nullable(),
});

export default api({
  name: "DiagnoseRuns",
  description: "Shows recent module_runs for a deal to diagnose stuck pipelines",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    runs: z.array(RunRowSchema),
    analysisCount: z.number().optional(),
  }),

  async run(ctx, { dealId }) {
    const runs = await ctx.integrations.db.query(
      `SELECT id, module_id, status,
              triggered_at::text, completed_at::text
       FROM module_runs
       WHERE deal_id = $1
       ORDER BY triggered_at DESC
       LIMIT 10`,
      RunRowSchema,
      [dealId],
      { label: "Recent module runs" }
    );

    // Check analysis checkpoint count for the most recent running run
    const runningRun = runs.find(r => r.status === "running");
    let analysisCount: number | undefined;
    if (runningRun) {
      const countRows = await ctx.integrations.db.query(
        `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis WHERE run_id = $1`,
        z.object({ cnt: z.number() }),
        [runningRun.id],
        { label: "Count analysis checkpoints" }
      );
      analysisCount = countRows[0]?.cnt ?? 0;
    }

    return { runs, analysisCount };
  },
});
