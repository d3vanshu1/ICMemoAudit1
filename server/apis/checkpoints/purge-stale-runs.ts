import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const PurgedRunSchema = z.object({
  id: z.string(),
  module_id: z.string(),
  triggered_at: z.string(),
});

/**
 * Marks "running" module_runs as "failed" if they have been stuck
 * for longer than `staleMinutes` (default 30).
 *
 * Intended to be called:
 *  1. On-demand to clean up zombie runs
 *  2. At the start of each new module run to auto-expire old zombies
 */
export default api({
  name: "PurgeStaleRuns",
  description: "Auto-expires module runs stuck in 'running' state beyond a timeout",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    staleMinutes: z.number().nullable().optional(), // default 30
    excludeModuleId: z.string().nullable().optional(), // don't purge the module currently being started
  }),

  output: z.object({
    purgedCount: z.number(),
    purgedRuns: z.array(PurgedRunSchema),
  }),

  async run(ctx, { dealId, staleMinutes, excludeModuleId }) {
    const minutes = staleMinutes ?? 30;

    // Mark all "running" runs older than the threshold as "failed"
    // Exclude the module currently being started to avoid killing its own prior run
    const purged = await ctx.integrations.db.query(
      `UPDATE module_runs
       SET status = 'failed'::module_status,
           completed_at = now()
       WHERE deal_id = $1
         AND status = 'running'
         AND triggered_at < now() - ($2 || ' minutes')::interval
         AND ($3::text IS NULL OR module_id != $3)
       RETURNING id, module_id, triggered_at::text`,
      PurgedRunSchema,
      [dealId, String(minutes), excludeModuleId ?? null],
      { label: `Purge stale runs (>${minutes}min)` }
    );

    return {
      purgedCount: purged.length,
      purgedRuns: purged,
    };
  },
});
