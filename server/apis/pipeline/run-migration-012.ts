/**
 * Migration 012 — Create integration-owned `pipeline_errors` table.
 *
 * Since the integration role cannot ALTER module_runs (no DDL grants from
 * the Supabase owner), we persist error_message + error_phase in a
 * separate table that we own and can write to freely.
 *
 * markRunFailed() in pipeline-core.ts will INSERT here alongside the
 * status-only UPDATE on module_runs.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration012",
  description: "Creates pipeline_errors table for failure diagnostics (integration-owned)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    tableExists: z.boolean(),
  }),

  async run(ctx) {
    // Check if table already exists
    const existing = await ctx.integrations.db.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name = 'pipeline_errors' AND table_schema = 'public'`,
      z.object({ table_name: z.string() }),
      [],
      { label: "Check if pipeline_errors exists" }
    );

    if (existing.length > 0) {
      return {
        success: true,
        message: "pipeline_errors table already exists — no migration needed.",
        tableExists: true,
      };
    }

    try {
      await ctx.integrations.db.execute(
        `CREATE TABLE pipeline_errors (
           id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           run_id        UUID NOT NULL,
           deal_id       UUID NOT NULL,
           module_id     TEXT NOT NULL,
           error_phase   TEXT NOT NULL,
           error_message TEXT NOT NULL,
           error_stack   TEXT,
           created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
        undefined,
        { label: "Create pipeline_errors table" }
      );

      await ctx.integrations.db.execute(
        `CREATE INDEX idx_pipeline_errors_run ON pipeline_errors(run_id)`,
        undefined,
        { label: "Create pipeline_errors run index" }
      );

      await ctx.integrations.db.execute(
        `CREATE INDEX idx_pipeline_errors_deal ON pipeline_errors(deal_id, created_at DESC)`,
        undefined,
        { label: "Create pipeline_errors deal index" }
      );

      return {
        success: true,
        message: "Created pipeline_errors table with indexes.",
        tableExists: true,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Migration failed: ${msg}`,
        tableExists: false,
      };
    }
  },
});
