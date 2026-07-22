/**
 * Admin utility — kills a stalled pipeline run and purges extraction data
 * so the deal can be re-run cleanly from scratch.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "ResetDealRun",
  description: "Kills stalled run and purges extractions for a fresh restart",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    runId: z.string().nullable().optional(),
    forcePurge: z.boolean().nullable().optional(),
  }),

  output: z.object({
    runReset: z.boolean(),
    extractionsPurged: z.number(),
  }),

  async run(ctx, { dealId, runId, forcePurge }) {
    // If forcePurge is set, skip run-matching entirely and go straight to purge.
    if (!forcePurge) {
      if (!runId) {
        throw new Error("runId is required when forcePurge is not set");
      }

      // 1. Mark the stalled run as failed — check affected row count
      const updateResult = await ctx.integrations.db.execute(
        `UPDATE module_runs
         SET status = 'failed', completed_at = now()
         WHERE id = $1 AND status = 'running'`,
        [runId],
        { label: "Kill stalled run" }
      );

      // If the UPDATE didn't match any row, the runId is wrong/stale or already
      // completed — refuse to purge extraction data to avoid silent data loss.
      if (updateResult.rowCount === 0) {
        return {
          runReset: false,
          extractionsPurged: 0,
        };
      }
    }

    // 2. Count extractions before purge
    const countRows = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS cnt FROM universal_extractions WHERE deal_id = $1`,
      z.object({ cnt: z.number() }),
      [dealId],
      { label: "Count extractions" }
    );
    const count = countRows[0]?.cnt ?? 0;

    // 3. Purge all extraction data for this deal
    await ctx.integrations.db.execute(
      `DELETE FROM universal_extractions WHERE deal_id = $1`,
      [dealId],
      { label: "Purge extractions" }
    );

    return {
      runReset: true,
      extractionsPurged: count,
    };
  },
});
