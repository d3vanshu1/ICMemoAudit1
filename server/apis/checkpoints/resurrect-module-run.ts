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
    // Read current status + deal/module context
    const rows = await ctx.integrations.db.query(
      `SELECT status, deal_id, module_id FROM module_runs WHERE id = $1 LIMIT 1`,
      z.object({ status: z.string(), deal_id: z.string(), module_id: z.string() }),
      [runId],
      { label: `Check status of run ${runId}` }
    );

    if (rows.length === 0) {
      return { resurrected: false, previousStatus: null };
    }

    const { status: previousStatus, deal_id, module_id } = rows[0];
    if (previousStatus !== "failed") {
      // Only resurrect terminated runs — don't touch running or completed
      return { resurrected: false, previousStatus };
    }

    // Guard: ensure no sibling run is already in-flight for the same deal + module
    const siblings = await ctx.integrations.db.query(
      `SELECT id FROM module_runs
       WHERE deal_id = $1 AND module_id = $2 AND status = 'running'::module_status AND id != $3
       LIMIT 1`,
      z.object({ id: z.string() }),
      [deal_id, module_id, runId],
      { label: "Check for already-running sibling" }
    );

    if (siblings.length > 0) {
      return { resurrected: false, previousStatus };
    }

    // Clear is_cancelled flag (if it exists) + reset to running
    try {
      await ctx.integrations.db.execute(
        `UPDATE module_runs
         SET status = 'running'::module_status, is_cancelled = FALSE, completed_at = NULL, triggered_at = now()
         WHERE id = $1`,
        [runId],
        { label: `Resurrect run ${runId} (was ${previousStatus}, clear is_cancelled)` }
      );
    } catch {
      // Pre-migration fallback: is_cancelled column doesn't exist yet
      await ctx.integrations.db.execute(
        `UPDATE module_runs
         SET status = 'running'::module_status, completed_at = NULL, triggered_at = now()
         WHERE id = $1`,
        [runId],
        { label: `Resurrect run ${runId} (was ${previousStatus})` }
      );
    }

    return { resurrected: true, previousStatus };
  },
});
