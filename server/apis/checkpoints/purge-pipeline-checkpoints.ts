/**
 * Purges pipeline_checkpoints rows for a deal's module_runs.
 * Must be called BEFORE PurgeExtractions (which deletes module_runs).
 * Temporary — delete after acceptance test.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CountSchema = z.object({ count: z.coerce.number() });

export default api({
  name: "PurgePipelineCheckpoints",
  description: "Deletes pipeline_checkpoints rows for a deal's runs",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    checkpointsDeleted: z.number(),
    runIdsFound: z.number(),
  }),

  async run(ctx, { dealId }) {
    // Count runs for this deal
    const [{ count: runCount }] = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS count FROM module_runs WHERE deal_id = $1`,
      CountSchema,
      [dealId],
      { label: "Count module_runs for deal" }
    );

    // Count pipeline_checkpoints for those runs
    const [{ count: cpCount }] = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS count FROM pipeline_checkpoints
       WHERE module_run_id IN (SELECT id FROM module_runs WHERE deal_id = $1)`,
      CountSchema,
      [dealId],
      { label: "Count pipeline_checkpoints for deal runs" }
    );

    // Delete
    if (cpCount > 0) {
      await ctx.integrations.db.execute(
        `DELETE FROM pipeline_checkpoints
         WHERE module_run_id IN (SELECT id FROM module_runs WHERE deal_id = $1)`,
        [dealId],
        { label: "Purge pipeline_checkpoints for deal" }
      );
    }

    ctx.log.info(
      `[PurgePipelineCheckpoints] Deal ${dealId}: ${cpCount} checkpoints deleted across ${runCount} runs`
    );

    return {
      checkpointsDeleted: cpCount,
      runIdsFound: runCount,
    };
  },
});
