/**
 * Admin utility — marks all module runs as 'failed' for a deal (or specific module),
 * effectively resetting the dashboard to a "never run" state.
 * 
 * NOTE: This uses UPDATE (not DELETE) because the DB role has restricted DELETE
 * privileges on module_runs and related tables, but UPDATE works fine.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "PurgeDealHistory",
  description: "Marks all runs as failed and clears outputs for a deal/module, resetting the dashboard",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    moduleId: z.string().nullable().optional(),
  }),

  output: z.object({
    runsMarkedFailed: z.number(),
    outputsCleared: z.number(),
  }),

  async run(ctx, { dealId, moduleId }) {
    // 1. Mark all non-failed runs as 'failed' so they don't appear as "completed"
    //    in LoadModuleResults (which uses DISTINCT ON module_id ORDER BY has-output, triggered_at DESC)
    const updateSql = moduleId
      ? `UPDATE module_runs
         SET status = 'failed'::module_status, completed_at = now()
         WHERE deal_id = $1 AND module_id = $2 AND status != 'failed'`
      : `UPDATE module_runs
         SET status = 'failed'::module_status, completed_at = now()
         WHERE deal_id = $1 AND status != 'failed'`;
    const params = moduleId ? [dealId, moduleId] : [dealId];

    const updateResult = await ctx.integrations.db.execute(
      updateSql,
      params,
      { label: "Mark runs as failed" }
    );

    // 2. Null out module_outputs content so no findings/reports remain visible
    //    (LoadModuleResults joins module_outputs — if output exists, card shows results)
    const clearOutputsSql = moduleId
      ? `UPDATE module_outputs
         SET findings = '[]'::jsonb, full_report_markdown = NULL, executive_header = NULL
         WHERE module_run_id IN (SELECT id FROM module_runs WHERE deal_id = $1 AND module_id = $2)`
      : `UPDATE module_outputs
         SET findings = '[]'::jsonb, full_report_markdown = NULL, executive_header = NULL
         WHERE module_run_id IN (SELECT id FROM module_runs WHERE deal_id = $1)`;

    const outputsResult = await ctx.integrations.db.execute(
      clearOutputsSql,
      params,
      { label: "Clear module outputs" }
    );

    return {
      runsMarkedFailed: updateResult.rowCount ?? 0,
      outputsCleared: outputsResult.rowCount ?? 0,
    };
  },
});
