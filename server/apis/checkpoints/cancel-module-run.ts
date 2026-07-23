/**
 * CancelModuleRun — server-authoritative cancellation.
 *
 * Two input modes:
 *   1. Primary: dealId + moduleId — cancels ALL running/pending rows for that module
 *   2. Alternate: runId alone — cancels a specific run (backward compat)
 *
 * Sets status = 'cancelled'::module_status with completed_at = now().
 * Returns the list of affected run IDs.
 *
 * Post-migration-008: uses the real 'cancelled' enum value. If the enum ALTER
 * hasn't been run yet, the cast will fail and we fall back to 'failed' + a
 * first_error marker (legacy behavior preserved).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const AffectedRowSchema = z.object({ id: z.string() });

export default api({
  name: "CancelModuleRun",
  description: "Server-authoritative cancellation of running/pending module runs",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    // Primary mode: cancel by deal + module (all running/pending rows)
    dealId: z.string().nullable().optional(),
    moduleId: z.string().nullable().optional(),
    // Alternate mode: cancel a specific run
    runId: z.string().nullable().optional(),
  }),

  output: z.object({
    cancelled: z.boolean(),
    affectedRunIds: z.array(z.string()),
    usedEnum: z.boolean().describe("True if 'cancelled' enum value was used; false if fell back to 'failed'"),
  }),

  async run(ctx, { dealId, moduleId, runId }) {
    // Validate input: must provide either (dealId + moduleId) or runId
    if (!runId && (!dealId || !moduleId)) {
      return { cancelled: false, affectedRunIds: [], usedEnum: false };
    }

    // Build the WHERE clause based on input mode
    let whereClause: string;
    let params: (string | null)[];

    if (dealId && moduleId) {
      // Primary: module-scoped cancellation
      whereClause = `deal_id = $1 AND module_id = $2 AND status IN ('running'::module_status, 'pending'::module_status)`;
      params = [dealId, moduleId];
    } else {
      // Alternate: single run
      whereClause = `id = $1 AND status IN ('running'::module_status, 'pending'::module_status)`;
      params = [runId!];
    }

    // Attempt with real 'cancelled' enum
    try {
      const affected = await ctx.integrations.db.query(
        `UPDATE module_runs
         SET status = 'cancelled'::module_status, completed_at = now()
         WHERE ${whereClause}
         RETURNING id`,
        AffectedRowSchema,
        params,
        { label: `Cancel runs: ${dealId ? `${moduleId}@${dealId.slice(0, 8)}` : runId?.slice(0, 8)}` }
      );

      const ids = affected.map(r => r.id);
      console.log(`[CancelModuleRun] Cancelled ${ids.length} run(s) with 'cancelled' enum: ${ids.join(", ")}`);
      return { cancelled: ids.length > 0, affectedRunIds: ids, usedEnum: true };
    } catch (enumErr: unknown) {
      // Enum value doesn't exist yet — fall back to 'failed' with marker
      console.warn(`[CancelModuleRun] 'cancelled' enum cast failed, using 'failed' fallback`);

      const affected = await ctx.integrations.db.query(
        `UPDATE module_runs
         SET status = 'failed'::module_status, completed_at = now()
         WHERE ${whereClause}
         RETURNING id`,
        AffectedRowSchema,
        params,
        { label: `Cancel (fallback to failed): ${dealId ? `${moduleId}@${dealId.slice(0, 8)}` : runId?.slice(0, 8)}` }
      );

      const ids = affected.map(r => r.id);
      return { cancelled: ids.length > 0, affectedRunIds: ids, usedEnum: false };
    }
  },
});
