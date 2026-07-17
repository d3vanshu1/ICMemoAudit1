/**
 * Migration 005 — adds model_used TEXT column to pipeline_analysis and merge_checkpoints.
 * Enables provenance tracking: which model produced each extraction/merge.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration005",
  description: "Adds model_used column to pipeline_analysis and merge_checkpoints",

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
      `ALTER TABLE pipeline_analysis ADD COLUMN IF NOT EXISTS model_used TEXT`,
      [],
      { label: "Add model_used to pipeline_analysis" }
    );

    await ctx.integrations.db.execute(
      `ALTER TABLE merge_checkpoints ADD COLUMN IF NOT EXISTS model_used TEXT`,
      [],
      { label: "Add model_used to merge_checkpoints" }
    );

    return {
      success: true,
      message: "model_used column added to pipeline_analysis and merge_checkpoints",
    };
  },
});
