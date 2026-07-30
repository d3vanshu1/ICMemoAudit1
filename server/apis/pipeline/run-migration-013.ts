/**
 * Migration 013 — creates pipeline_checkpoints table.
 *
 * Used by numeric-verify and claims-reconciliation to persist intermediate
 * results so resumed invocations skip already-completed work.
 *
 * Rows:
 *   - "numeric_report" — complete NumericVerifyResult (figures + discrepancies)
 *   - "claims_ledger"  — ClaimsLedger after LLM extraction
 *   - "reconciliation" — ReconciliationResult after code-verified delta computation
 *
 * Keyed by (module_run_id, checkpoint_key) with UNIQUE constraint for upsert.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration013",
  description: "Creates pipeline_checkpoints table for numeric-verify and reconciliation resume",

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
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS pipeline_checkpoints (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        module_run_id UUID NOT NULL,
        checkpoint_key TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (module_run_id, checkpoint_key)
      )`,
      [],
      { label: "Create pipeline_checkpoints table" }
    );

    // Index for fast lookups by run_id
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_pipeline_checkpoints_run
       ON pipeline_checkpoints (module_run_id)`,
      [],
      { label: "Create index on pipeline_checkpoints(module_run_id)" }
    );

    return {
      success: true,
      message: "Created pipeline_checkpoints table with indexes.",
      tableExists: true,
    };
  },
});
