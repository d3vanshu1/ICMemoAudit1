/**
 * CancelModuleRun — server-authoritative cancellation.
 *
 * Two input modes:
 *   1. Primary: dealId + moduleId — cancels ALL running/pending rows for that module
 *   2. Alternate: runId alone — cancels a specific run (backward compat)
 *
 * Sets status = 'failed' + is_cancelled = TRUE + completed_at = now().
 * Returns the list of affected run IDs.
 *
 * Boolean approach: uses `is_cancelled` column (Migration 009) to distinguish
 * user-initiated cancellation from pipeline failure. No enum dependency.
 * If the column doesn't exist yet (pre-migration), falls back to just
 * setting status = 'failed' (legacy behavior preserved, functionally safe
 * because client-side killedModulesRef prevents auto-resume regardless).
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
    usedBoolean: z.boolean().describe("True if is_cancelled column was set; false if pre-migration fallback"),
  }),

  async run(ctx, { dealId, moduleId, runId }) {
    // Validate input: must provide either (dealId + moduleId) or runId
    if (!runId && (!dealId || !moduleId)) {
      return { cancelled: false, affectedRunIds: [], usedBoolean: false };
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

    // Attempt with is_cancelled boolean (post-migration-009)
    try {
      const affected = await ctx.integrations.db.query(
        `UPDATE module_runs
         SET status = 'failed'::module_status, is_cancelled = TRUE, completed_at = now()
         WHERE ${whereClause}
         RETURNING id`,
        AffectedRowSchema,
        params,
        { label: `Cancel runs (boolean): ${dealId ? `${moduleId}@${dealId.slice(0, 8)}` : runId?.slice(0, 8)}` }
      );

      const ids = affected.map(r => r.id);
      console.log(`[CancelModuleRun] Cancelled ${ids.length} run(s) with is_cancelled=TRUE: ${ids.join(", ")}`);
      return { cancelled: ids.length > 0, affectedRunIds: ids, usedBoolean: true };
    } catch (colErr: unknown) {
      // Column doesn't exist yet (pre-migration-009) — fall back to status='failed' only
      console.warn(`[CancelModuleRun] is_cancelled column not found, using status-only fallback`);

      const affected = await ctx.integrations.db.query(
        `UPDATE module_runs
         SET status = 'failed'::module_status, completed_at = now()
         WHERE ${whereClause}
         RETURNING id`,
        AffectedRowSchema,
        params,
        { label: `Cancel (pre-migration fallback): ${dealId ? `${moduleId}@${dealId.slice(0, 8)}` : runId?.slice(0, 8)}` }
      );

      const ids = affected.map(r => r.id);
      return { cancelled: ids.length > 0, affectedRunIds: ids, usedBoolean: false };
    }
  },
});
