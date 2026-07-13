import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "CreatePipelineTable",
  description: "Creates the pipeline_analysis table for server-side pipeline checkpoints",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
  }),

  async run(ctx) {
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS pipeline_analysis (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id          UUID NOT NULL,
        chunk_index     INT NOT NULL,
        result_json     JSONB NOT NULL DEFAULT '{}',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (run_id, chunk_index)
      )`,
      undefined,
      { label: "Create pipeline_analysis table" }
    );
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_pipeline_analysis_run ON pipeline_analysis(run_id)`,
      undefined,
      { label: "Create pipeline_analysis run index" }
    );

    return { success: true };
  },
});
