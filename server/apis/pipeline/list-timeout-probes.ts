import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ProbeRowSchema = z.object({
  probe_id: z.string(),
  started_at: z.string(),
  last_heartbeat_at: z.string(),
  completed_at: z.string().nullable(),
  elapsed_ms: z.number().nullable(),
  heartbeat_elapsed_s: z.coerce.number().nullable(),
});

/**
 * ListTimeoutProbes — lists recent diag_timeout_probes rows for inspection.
 */
export default api({
  name: "ListTimeoutProbes",
  description: "Lists recent DiagTimeoutProbe rows ordered by started_at DESC",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    limit: z.number().default(10),
  }),

  output: z.object({
    rows: z.array(ProbeRowSchema),
  }),

  async run(ctx, { limit }) {
    const rows = await ctx.integrations.db.query(
      `SELECT probe_id, started_at::text, last_heartbeat_at::text, completed_at::text, elapsed_ms,
              EXTRACT(EPOCH FROM (last_heartbeat_at - started_at))::numeric AS heartbeat_elapsed_s
       FROM diag_timeout_probes
       ORDER BY started_at DESC
       LIMIT $1`,
      ProbeRowSchema,
      [limit],
      { label: "List recent probes" },
    );

    return { rows };
  },
});
