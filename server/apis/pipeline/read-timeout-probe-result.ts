import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ProbeResultSchema = z.object({
  probe_id: z.string(),
  started_at: z.string(),
  last_heartbeat_at: z.string(),
  completed_at: z.string().nullable(),
  elapsed_ms: z.number().nullable(),
});

/**
 * ReadTimeoutProbeResult — reads a single DiagTimeoutProbe row.
 *
 * Interpretation:
 *   - completed_at present → survived, cap > sleepSeconds
 *   - completed_at null    → killed at ≈ last_heartbeat_at − started_at, ±15s
 */
export default api({
  name: "ReadTimeoutProbeResult",
  description: "Reads a DiagTimeoutProbe row by probe_id",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    probeId: z.string(),
  }),

  output: z.object({
    found: z.boolean(),
    row: ProbeResultSchema.nullable(),
  }),

  async run(ctx, { probeId }) {
    const rows = await ctx.integrations.db.query(
      `SELECT probe_id, started_at::text, last_heartbeat_at::text, completed_at::text, elapsed_ms
       FROM diag_timeout_probes
       WHERE probe_id = $1
       LIMIT 1`,
      ProbeResultSchema,
      [probeId],
      { label: "Read probe result" },
    );

    if (rows.length === 0) {
      return { found: false, row: null };
    }

    return { found: true, row: rows[0] };
  },
});
