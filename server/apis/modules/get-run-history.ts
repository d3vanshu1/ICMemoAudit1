import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const RunHistoryRowSchema = z.object({
  id: z.string(),
  module_id: z.string(),
  status: z.string(),
  is_cancelled: z.boolean(),
  triggered_at: z.string(),
  completed_at: z.string().nullable(),
  finding_count: z.coerce.number(),
  critical_count: z.coerce.number(),
});

export default api({
  name: "GetRunHistory",
  description: "Fetches the run history for all modules of a deal",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    runs: z.array(RunHistoryRowSchema),
  }),

  async run(ctx, { dealId }) {
    // Try with is_cancelled column (post-migration-009)
    try {
      const runs = await ctx.integrations.db.query(
        `SELECT
          mr.id, mr.module_id, mr.status,
          COALESCE(mr.is_cancelled, FALSE) AS is_cancelled,
          mr.triggered_at, mr.completed_at,
          COALESCE(jsonb_array_length(mo.findings), 0) AS finding_count,
          COALESCE((
            SELECT COUNT(*) FROM jsonb_array_elements(mo.findings) f
            WHERE f.value->>'severity' = 'critical'
          ), 0) AS critical_count
        FROM module_runs mr
        LEFT JOIN module_outputs mo ON mo.module_run_id = mr.id
        WHERE mr.deal_id = $1
        ORDER BY mr.triggered_at DESC
        LIMIT 100`,
        RunHistoryRowSchema,
        [dealId],
        { label: "Get module run history (with is_cancelled)" }
      );
      return { runs };
    } catch {
      // Pre-migration fallback
      const runs = await ctx.integrations.db.query(
        `SELECT
          mr.id, mr.module_id, mr.status,
          FALSE AS is_cancelled,
          mr.triggered_at, mr.completed_at,
          COALESCE(jsonb_array_length(mo.findings), 0) AS finding_count,
          COALESCE((
            SELECT COUNT(*) FROM jsonb_array_elements(mo.findings) f
            WHERE f.value->>'severity' = 'critical'
          ), 0) AS critical_count
        FROM module_runs mr
        LEFT JOIN module_outputs mo ON mo.module_run_id = mr.id
        WHERE mr.deal_id = $1
        ORDER BY mr.triggered_at DESC
        LIMIT 100`,
        RunHistoryRowSchema,
        [dealId],
        { label: "Get module run history (pre-migration)" }
      );
      return { runs };
    }
  },
});
