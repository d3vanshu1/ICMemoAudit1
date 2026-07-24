import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const StatusSchema = z.object({ status: z.string(), is_cancelled: z.boolean() });

/**
 * Lightweight check for run cancellation status.
 * Post-Migration-009: checks the `is_cancelled` boolean column.
 * Falls back to status-only check if column doesn't exist yet.
 */
export default api({
  name: "CheckRunCancelled",
  description: "Checks if a module run has been cancelled (server-authoritative)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    cancelled: z.boolean(),
    status: z.string(),
  }),

  async run(ctx, { runId }) {
    // Try with is_cancelled column (post-migration-009)
    try {
      const rows = await ctx.integrations.db.query(
        `SELECT status, COALESCE(is_cancelled, FALSE) AS is_cancelled FROM module_runs WHERE id = $1 LIMIT 1`,
        StatusSchema,
        [runId],
        { label: `Check cancellation: ${runId}` }
      );

      const status = rows[0]?.status ?? "unknown";
      const isCancelled = rows[0]?.is_cancelled ?? false;
      return { cancelled: isCancelled, status };
    } catch {
      // Pre-migration fallback: column doesn't exist
      const rows = await ctx.integrations.db.query(
        `SELECT status FROM module_runs WHERE id = $1 LIMIT 1`,
        z.object({ status: z.string() }),
        [runId],
        { label: `Check cancellation (pre-migration): ${runId}` }
      );
      const status = rows[0]?.status ?? "unknown";
      // Pre-migration: cancelled runs have status='failed' — indistinguishable.
      // Client killedModulesRef is the real guard.
      return { cancelled: false, status };
    }
  },
});
