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
    // Check current status + is_cancelled flag (with pre-migration fallback)
    let status: string;
    let isCancelled: boolean;

    try {
      const rows = await ctx.integrations.db.query(
        `SELECT status, COALESCE(is_cancelled, FALSE) AS is_cancelled
         FROM module_runs WHERE id = $1 LIMIT 1`,
        z.object({ status: z.string(), is_cancelled: z.boolean() }),
        [runId],
        { label: "Check run status before reset" }
      );
      if (rows.length === 0) return { reset: false, previousStatus: null };
      status = rows[0].status;
      isCancelled = rows[0].is_cancelled;
    } catch {
      // Pre-migration: column doesn't exist
      const rows = await ctx.integrations.db.query(
        `SELECT status FROM module_runs WHERE id = $1 LIMIT 1`,
        z.object({ status: z.string() }),
        [runId],
        { label: "Check run status (pre-migration)" }
      );
      if (rows.length === 0) return { reset: false, previousStatus: null };
      status = rows[0].status;
      isCancelled = false; // Pre-migration: can't distinguish cancelled from failed
    }

    // REFUSE cancelled runs — server-authoritative cancellation is permanent.
    // Use ResurrectModuleRun for deliberate operator overrides only.
    if (isCancelled) {
      return { reset: false, previousStatus: `${status} (cancelled)` };
    }

    // Reset to running with fresh triggered_at, null out completed_at
    await ctx.integrations.db.execute(
      `UPDATE module_runs
       SET status = 'running'::module_status,
           completed_at = NULL,
           triggered_at = now()
       WHERE id = $1`,
      [runId],
      { label: `Reset run ${runId} from ${status} to running` }
    );

    return { reset: true, previousStatus: status };
  },
});
