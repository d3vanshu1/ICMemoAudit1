import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const StatusSchema = z.object({ status: z.string() });

/**
 * KNOWN LIMITATION: This endpoint checks for status === "cancelled", but the
 * module_status enum has no 'cancelled' variant (only running/completed/failed/pending).
 * CancelModuleRun writes status = 'failed', so this check will never return true.
 *
 * The actual cancellation mechanism is client-side: cancelledRunsRef tracks cancelled
 * run IDs, and the client simply stops re-invoking the server pipeline.
 * The orphaned "running" row eventually gets purged by PurgeStaleRuns (30-min threshold).
 *
 * A proper fix requires either:
 *  - ALTER TYPE module_status ADD VALUE 'cancelled' (needs table owner privileges we lack)
 *  - Adding a cancelled_by_user boolean column to module_runs
 *
 * Until then, this endpoint is dead code (not called at runtime).
 */
export default api({
  name: "CheckRunCancelled",
  description: "Lightweight poll to check if a module run has been cancelled (see limitation note above)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    cancelled: z.boolean(),
  }),

  async run(ctx, { runId }) {
    const rows = await ctx.integrations.db.query(
      `SELECT status FROM module_runs WHERE id = $1 LIMIT 1`,
      StatusSchema,
      [runId],
      { label: `Check cancellation: ${runId}` }
    );

    const status = rows[0]?.status ?? "unknown";
    return { cancelled: status === "cancelled" };
  },
});
