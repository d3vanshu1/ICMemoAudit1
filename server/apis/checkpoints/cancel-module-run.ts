import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "CancelModuleRun",
  description: "Cancels an in-progress module run by marking it failed (cancellation tracked client-side)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    cancelled: z.boolean(),
  }),

  async run(ctx, { runId }) {
    // Mark as 'failed' in the DB — the client-side cancelledRunsRef tracks
    // the actual cancellation semantics and stops the extraction loop.
    // We use 'failed' because 'cancelled' isn't in the module_status enum
    // and the DB user lacks ALTER TYPE privileges.
    await ctx.integrations.db.execute(
      `UPDATE module_runs
       SET status = 'failed'::module_status, completed_at = now()
       WHERE id = $1 AND status IN ('running', 'pending')`,
      [runId],
      { label: `Cancel (mark failed) run ${runId}` }
    );

    return { cancelled: true };
  },
});
