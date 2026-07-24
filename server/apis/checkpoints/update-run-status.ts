import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const RunIdSchema = z.object({ run_id: z.string() });

export default api({
  name: "UpdateRunStatus",
  description: "Creates or transitions a module run using the existing status enum",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    // If runId is provided, update that run. Otherwise create a new one.
    runId: z.string().nullable().optional(),
    dealId: z.string(),
    moduleId: z.string(),
    status: z.enum(["pending", "running", "completed", "failed"]),
    documentsIncluded: z.array(z.string()).nullable().optional(),
    override: z.boolean().optional(),
  }),

  output: z.object({
    runId: z.string(),
  }),

  async run(ctx, { runId, dealId, moduleId, status, documentsIncluded, override }) {
    if (runId) {
      // GUARD: refuse update on cancelled runs unless override:true
      let isCancelled = false;
      try {
        const check = await ctx.integrations.db.query(
          `SELECT COALESCE(is_cancelled, FALSE) AS is_cancelled FROM module_runs WHERE id = $1 LIMIT 1`,
          z.object({ is_cancelled: z.boolean() }),
          [runId],
          { label: `Check is_cancelled before status update` }
        );
        isCancelled = check[0]?.is_cancelled ?? false;
      } catch {
        // Pre-migration: column doesn't exist, can't guard
      }

      if (isCancelled && !override) {
        console.warn(`[UpdateRunStatus] Refused: run ${runId} is cancelled. Pass override:true to force.`);
        return { runId };
      }

      // Update existing run
      const setCompleted = status === "completed" || status === "failed";

      await ctx.integrations.db.execute(
        `UPDATE module_runs
         SET status = $1::module_status,
             completed_at = ${setCompleted ? "now()" : "NULL"}
         WHERE id = $2`,
        [status, runId],
        { label: `Update run ${runId} → ${status}` }
      );

      return { runId };
    }

    // Create new run
    const rows = await ctx.integrations.db.query(
      `INSERT INTO module_runs (deal_id, module_id, status, documents_included)
       VALUES ($1, $2, $3::module_status, $4::text[])
       RETURNING id AS run_id`,
      RunIdSchema,
      [dealId, moduleId, status, documentsIncluded ?? []],
      { label: `Create run for ${moduleId}` }
    );

    return { runId: rows[0].run_id };
  },
});
