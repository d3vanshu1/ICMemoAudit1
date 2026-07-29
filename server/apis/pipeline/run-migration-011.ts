/**
 * Migration 011 — Dedup doc_tables and add UNIQUE constraint on (document_id, sheet_or_page).
 *
 * Problem: The ingestion pipeline occasionally double-writes the same sheet,
 * creating byte-identical duplicate rows. This caused the cross-agreement
 * engine to hit its ambiguous-source guard and silently skip comparison.
 *
 * Fix:
 *   1. Delete duplicate rows (keep the one with the latest created_at per doc+sheet)
 *   2. Add a UNIQUE constraint so future inserts use ON CONFLICT DO UPDATE (upsert)
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration011",
  description: "Dedups doc_tables and adds unique constraint on (document_id, sheet_or_page)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    duplicatesRemoved: z.number(),
    constraintExists: z.boolean(),
  }),

  async run(ctx) {
    // Step 1: Check if constraint already exists
    const existing = await ctx.integrations.db.query(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_name = 'doc_tables'
         AND constraint_type = 'UNIQUE'
         AND constraint_name = 'uq_doc_tables_doc_sheet'`,
      z.object({ constraint_name: z.string() }),
      [],
      { label: "Check if unique constraint exists" }
    );

    if (existing.length > 0) {
      return {
        success: true,
        message: "Unique constraint 'uq_doc_tables_doc_sheet' already exists — no migration needed.",
        duplicatesRemoved: 0,
        constraintExists: true,
      };
    }

    // Step 2: Remove duplicates — keep the row with the latest created_at per (document_id, sheet_or_page)
    let duplicatesRemoved = 0;
    try {
      const deleteResult = await ctx.integrations.db.query(
        `WITH ranked AS (
           SELECT id,
                  ROW_NUMBER() OVER (
                    PARTITION BY document_id, sheet_or_page
                    ORDER BY created_at DESC
                  ) AS rn
           FROM doc_tables
         ),
         to_delete AS (
           SELECT id FROM ranked WHERE rn > 1
         )
         DELETE FROM doc_tables
         WHERE id IN (SELECT id FROM to_delete)
         RETURNING id`,
        z.object({ id: z.string() }),
        [],
        { label: "Delete duplicate doc_tables rows (keep latest per doc+sheet)" }
      );
      duplicatesRemoved = deleteResult.length;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Dedup failed: ${msg}`,
        duplicatesRemoved: 0,
        constraintExists: false,
      };
    }

    // Step 3: Add the unique constraint
    try {
      await ctx.integrations.db.execute(
        `ALTER TABLE doc_tables
         ADD CONSTRAINT uq_doc_tables_doc_sheet UNIQUE (document_id, sheet_or_page)`,
        undefined,
        { label: "Add UNIQUE constraint on (document_id, sheet_or_page)" }
      );

      return {
        success: true,
        message: `Migration complete: removed ${duplicatesRemoved} duplicate(s), added UNIQUE constraint.`,
        duplicatesRemoved,
        constraintExists: true,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Constraint creation failed (after removing ${duplicatesRemoved} duplicates): ${msg}`,
        duplicatesRemoved,
        constraintExists: false,
      };
    }
  },
});
