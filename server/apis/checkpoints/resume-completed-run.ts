import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "ResumeCompletedRun",
  description: "Resets a completed/failed run back to running so the pipeline can retry formatting",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    reset: z.boolean(),
    previousStatus: z.string().nullable(),
  }),

  async run(ctx, { runId }) {
    // Check current status first
    const rows = await ctx.integrations.db.query(
      `SELECT status FROM module_runs WHERE id = $1 LIMIT 1`,
      z.object({ status: z.string() }),
      [runId],
      { label: "Check run status before reset" }
    );

    if (rows.length === 0) {
      return { reset: false, previousStatus: null };
    }

    const previousStatus = rows[0].status;

    // Reset to running with fresh triggered_at, null out completed_at
    await ctx.integrations.db.execute(
      `UPDATE module_runs
       SET status = 'running'::module_status,
           completed_at = NULL,
           triggered_at = now()
       WHERE id = $1`,
      [runId],
      { label: `Reset run ${runId} from ${previousStatus} to running` }
    );

    return { reset: true, previousStatus };
  },
});
