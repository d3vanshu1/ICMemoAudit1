/**
 * Migration 009 — Add `is_cancelled` BOOLEAN column to module_runs.
 *
 * This replaces the failed enum approach (Migration 008).
 * Strategy: ALTER TABLE ADD COLUMN with DEFAULT FALSE.
 * This is a simple DDL that works inside transactions on all PostgreSQL versions.
 *
 * After this migration:
 *   - CancelModuleRun sets is_cancelled = TRUE + status = 'failed'
 *   - ResumeCompletedRun refuses rows where is_cancelled = TRUE
 *   - ResurrectModuleRun clears is_cancelled when deliberately reviving
 *   - LoadModuleResults exposes is_cancelled for UI rendering ("Cancelled" vs "Failed")
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration009",
  description: "Adds is_cancelled boolean column to module_runs",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    columnExists: z.boolean(),
  }),

  async run(ctx) {
    // Step 1: Check if column already exists
    const existing = await ctx.integrations.db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'module_runs' AND column_name = 'is_cancelled'
       LIMIT 1`,
      z.object({ column_name: z.string() }),
      [],
      { label: "Check if is_cancelled column exists" }
    );

    if (existing.length > 0) {
      return {
        success: true,
        message: "'is_cancelled' column already exists on module_runs — no migration needed.",
        columnExists: true,
      };
    }

    // Step 2: Add the column — try query() since execute() fails on this platform
    try {
      await ctx.integrations.db.query(
        `ALTER TABLE module_runs ADD COLUMN IF NOT EXISTS is_cancelled BOOLEAN NOT NULL DEFAULT FALSE`,
        z.object({}),
        [],
        { label: "Add is_cancelled column to module_runs" }
      );

      return {
        success: true,
        message: "Successfully added 'is_cancelled' BOOLEAN column to module_runs.",
        columnExists: true,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `ALTER TABLE failed. Paste this exact error to Devanshu: ${msg}`,
        columnExists: false,
      };
    }
  },
});
