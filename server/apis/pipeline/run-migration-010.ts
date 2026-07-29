/**
 * Migration 010 — Add `error_message` and `error_phase` TEXT columns to module_runs.
 *
 * These columns capture the human-readable failure reason and the pipeline phase
 * where the failure occurred. Without them, the only way to diagnose a failed run
 * is to check 10-minute-retention runtime logs — which are usually gone by the
 * time anyone notices the failure.
 *
 * After this migration:
 *   - markRunFailed() in pipeline-core.ts persists error_message + error_phase
 *   - DiagnoseRuns / GetRunProgress can surface the error directly
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration010",
  description: "Adds error_message and error_phase columns to module_runs",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    columnsExist: z.boolean(),
  }),

  async run(ctx) {
    // Step 1: Check if columns already exist
    const existing = await ctx.integrations.db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'module_runs' AND column_name IN ('error_message', 'error_phase')`,
      z.object({ column_name: z.string() }),
      [],
      { label: "Check if error columns exist" }
    );

    if (existing.length >= 2) {
      return {
        success: true,
        message: "'error_message' and 'error_phase' columns already exist — no migration needed.",
        columnsExist: true,
      };
    }

    // Step 2: Add the columns
    try {
      await ctx.integrations.db.query(
        `ALTER TABLE module_runs
         ADD COLUMN IF NOT EXISTS error_message TEXT,
         ADD COLUMN IF NOT EXISTS error_phase TEXT`,
        z.object({}),
        [],
        { label: "Add error_message + error_phase columns" }
      );

      return {
        success: true,
        message: "Successfully added 'error_message' TEXT and 'error_phase' TEXT columns to module_runs.",
        columnsExist: true,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Migration failed: ${msg}`,
        columnsExist: false,
      };
    }
  },
});
