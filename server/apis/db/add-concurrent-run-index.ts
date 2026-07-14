import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Migration: Add partial unique index to prevent concurrent runs
//
// CREATE UNIQUE INDEX ... ON module_runs (deal_id, module_id)
// WHERE status = 'running'
//
// This is a one-time migration. If the index already exists, the DDL is a no-op.
// ---------------------------------------------------------------------------

export default api({
  name: "AddConcurrentRunIndex",
  description: "Adds partial unique index on module_runs to prevent concurrent same-module runs",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
  }),

  async run(ctx) {
    try {
      await ctx.integrations.db.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_module_runs_one_running_per_module
         ON module_runs (deal_id, module_id)
         WHERE status = 'running'::module_status`,
        z.object({}),
        [],
        { label: "Create partial unique index for concurrent run prevention" }
      );
      return {
        success: true,
        message: "Index uq_module_runs_one_running_per_module created (or already exists).",
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Failed to create index: ${err?.message ?? String(err)}`,
      };
    }
  },
});
