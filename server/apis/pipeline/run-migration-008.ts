/**
 * Migration 008 — Add 'cancelled' value to module_status enum.
 *
 * Strategy: Attempt ALTER TYPE ADD VALUE IF NOT EXISTS.
 * If it fails (common: can't run in transaction), report the exact error.
 * Devanshu runs this from the Superblocks app UI.
 *
 * IMPORTANT: Does NOT attempt type-rename workaround — that requires
 * ACCESS EXCLUSIVE on module_runs which will deadlock against running rows.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const EnumLabel = z.object({ enumlabel: z.string() });

export default api({
  name: "RunMigration008",
  description: "Adds 'cancelled' enum value to module_status type",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    existingValues: z.array(z.string()),
  }),

  async run(ctx) {
    // Step 1: Check current enum values
    const existing = await ctx.integrations.db.query(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
       WHERE t.typname = 'module_status' ORDER BY e.enumsortorder`,
      EnumLabel,
      [],
      { label: "Read current module_status enum values" }
    );
    const existingValues = existing.map((r) => r.enumlabel);

    if (existingValues.includes("cancelled")) {
      return {
        success: true,
        message: "'cancelled' already exists in module_status enum — no migration needed.",
        existingValues,
      };
    }

    // Step 2: Attempt ALTER TYPE ADD VALUE
    try {
      await ctx.integrations.db.execute(
        `ALTER TYPE module_status ADD VALUE IF NOT EXISTS 'cancelled'`,
        [],
        { label: "Add 'cancelled' to module_status enum" }
      );

      // Verify
      const verify = await ctx.integrations.db.query(
        `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
         WHERE t.typname = 'module_status' ORDER BY e.enumsortorder`,
        EnumLabel,
        [],
        { label: "Verify enum values after ALTER" }
      );

      return {
        success: true,
        message: "Successfully added 'cancelled' via ALTER TYPE ADD VALUE.",
        existingValues: verify.map((r) => r.enumlabel),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `ALTER TYPE failed: ${msg}. If this is a transaction constraint, run directly via psql: ALTER TYPE module_status ADD VALUE IF NOT EXISTS 'cancelled';`,
        existingValues,
      };
    }
  },
});
