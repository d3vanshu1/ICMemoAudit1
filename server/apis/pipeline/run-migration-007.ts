/**
 * Migration 007 — adds prompt_version TEXT column to pipeline_analysis and merge_checkpoints.
 * Enables stale-checkpoint detection: on resume, compare stored stamp against current code's stamp.
 * Mismatch = do not resume, start a new run_id.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration007",
  description: "Adds prompt_version column to pipeline_analysis and merge_checkpoints",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
  }),

  async run(ctx) {
    await ctx.integrations.db.execute(
      `ALTER TABLE pipeline_analysis ADD COLUMN IF NOT EXISTS prompt_version TEXT`,
      [],
      { label: "Add prompt_version to pipeline_analysis" }
    );

    await ctx.integrations.db.execute(
      `ALTER TABLE merge_checkpoints ADD COLUMN IF NOT EXISTS prompt_version TEXT`,
      [],
      { label: "Add prompt_version to merge_checkpoints" }
    );

    return {
      success: true,
      message: "prompt_version column added to pipeline_analysis and merge_checkpoints",
    };
  },
});
