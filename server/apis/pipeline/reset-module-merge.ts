/**
 * Surgical reset — clears only merge checkpoints and output for a specific module run,
 * then resets its status to 'running' so the pipeline resumes from the merge phase.
 * Extraction data (pipeline_analysis) is preserved.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "ResetModuleMerge",
  description: "Clears merge checkpoints and output for a run, resets to running for re-merge",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    override: z.boolean().optional(),
  }),

  output: z.object({
    mergeCheckpointsDeleted: z.number(),
    outputsDeleted: z.number(),
    runReset: z.boolean(),
    currentStatus: z.string().nullable(),
    analysisRowsFound: z.number(),
  }),

  async run(ctx, { runId, override }) {
    // 0. Check current run status + is_cancelled for diagnostics and guard
    let currentStatus: string | null = null;
    let isCancelled = false;
    try {
      const runRows = await ctx.integrations.db.query(
        `SELECT status::text AS status, COALESCE(is_cancelled, FALSE) AS is_cancelled FROM module_runs WHERE id = $1 LIMIT 1`,
        z.object({ status: z.string(), is_cancelled: z.boolean() }),
        [runId],
        { label: "Check run status + is_cancelled" }
      );
      currentStatus = runRows.length > 0 ? runRows[0].status : null;
      isCancelled = runRows[0]?.is_cancelled ?? false;
    } catch {
      // Pre-migration: column doesn't exist
      const runRows = await ctx.integrations.db.query(
        `SELECT status::text AS status FROM module_runs WHERE id = $1 LIMIT 1`,
        z.object({ status: z.string() }),
        [runId],
        { label: "Check run status (pre-migration)" }
      );
      currentStatus = runRows.length > 0 ? runRows[0].status : null;
    }

    // GUARD: refuse cancelled runs unless explicit override
    if (isCancelled && !override) {
      return {
        mergeCheckpointsDeleted: 0,
        outputsDeleted: 0,
        runReset: false,
        currentStatus: `${currentStatus} (cancelled — use ResurrectModuleRun to revive a cancelled run, or pass override:true to force)`,
        analysisRowsFound: 0,
      };
    }

    // 0b. Check how many analysis rows exist (to confirm re-merge is possible)
    const analysisCount = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis WHERE run_id = $1`,
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "Count analysis rows" }
    );
    const analysisRowsFound = analysisCount[0]?.cnt ?? 0;

    // 1. Delete merge checkpoints for this run
    await ctx.integrations.db.execute(
      `DELETE FROM merge_checkpoints WHERE module_run_id = $1`,
      [runId],
      { label: "Delete merge checkpoints" }
    );

    // 2. Delete module outputs for this run
    await ctx.integrations.db.execute(
      `DELETE FROM module_outputs WHERE module_run_id = $1`,
      [runId],
      { label: "Delete module outputs" }
    );

    // 3. Reset run status to 'running' and clear completed_at
    await ctx.integrations.db.execute(
      `UPDATE module_runs
       SET status = 'running'::module_status, completed_at = NULL, triggered_at = now()
       WHERE id = $1`,
      [runId],
      { label: "Reset run to running" }
    );

    // 4. Verify post-state
    const postRows = await ctx.integrations.db.query(
      `SELECT status::text AS status FROM module_runs WHERE id = $1 LIMIT 1`,
      z.object({ status: z.string() }),
      [runId],
      { label: "Verify post-reset status" }
    );
    const runReset = postRows.length > 0 && postRows[0].status === "running";

    // Count deleted checkpoints/outputs via post-query (since execute rowCount may not be reliable)
    const mcCountPost = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS cnt FROM merge_checkpoints WHERE module_run_id = $1`,
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "Verify checkpoints cleared" }
    );
    const moCountPost = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS cnt FROM module_outputs WHERE module_run_id = $1`,
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "Verify outputs cleared" }
    );

    return {
      mergeCheckpointsDeleted: mcCountPost[0]?.cnt === 0 ? -1 : 0, // -1 = confirmed cleared
      outputsDeleted: moCountPost[0]?.cnt === 0 ? -1 : 0,
      runReset,
      currentStatus,
      analysisRowsFound,
    };
  },
});
