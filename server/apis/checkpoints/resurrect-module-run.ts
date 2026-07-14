import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "ResurrectModuleRun",
  description: "Flips a failed/cancelled run back to running so it can resume from checkpoints.",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    resurrected: z.boolean(),
    previousStatus: z.string().nullable(),
  }),

  async run(ctx, { runId }) {
    // Read current status first — only resurrect failed/cancelled runs
    const rows = await ctx.integrations.db.query(
      `SELECT status FROM module_runs WHERE id = $1 LIMIT 1`,
      z.object({ status: z.string() }),
      [runId],
      { label: `Check status of run ${runId}` }
    );

    if (rows.length === 0) {
      return { resurrected: false, previousStatus: null };
    }

    const previousStatus = rows[0].status;
    if (previousStatus !== "failed" && previousStatus !== "cancelled") {
      // Only resurrect terminated runs — don't touch running or completed
      return { resurrected: false, previousStatus };
    }

    await ctx.integrations.db.execute(
      `UPDATE module_runs
       SET status = 'running'::module_status, completed_at = NULL, triggered_at = now()
       WHERE id = $1`,
      [runId],
      { label: `Resurrect run ${runId} (was ${previousStatus})` }
    );

    return { resurrected: true, previousStatus };
  },
});
