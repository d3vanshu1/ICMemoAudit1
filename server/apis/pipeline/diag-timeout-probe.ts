import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * DiagTimeoutProbe v2 — permanent diagnostic tooling.
 *
 * Self-reporting via DB heartbeats so we don't depend on testApi's 300s ceiling.
 * Interpretation:
 *   - completed_at present → survived, cap > sleepSeconds
 *   - completed_at null    → killed at ≈ last_heartbeat_at − started_at, ±15s
 *
 * CREATE TABLE IF NOT EXISTS runs inline — acceptable for diagnostic tooling.
 */
export default api({
  name: "DiagTimeoutProbe",
  description: "Diagnostic: sleeps N seconds with DB heartbeats to verify platform timeout cap",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    sleepSeconds: z.number().default(360),
  }),

  output: z.object({
    probeId: z.string(),
    survivedMs: z.number(),
    startedAt: z.string(),
    finishedAt: z.string(),
  }),

  async run(ctx, { sleepSeconds }) {
    // Ensure table exists
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS diag_timeout_probes (
        probe_id TEXT PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        elapsed_ms INTEGER
      )`,
      [],
      { label: "Ensure diag_timeout_probes table" },
    );

    const probeId = crypto.randomUUID();
    const start = Date.now();
    const startedAt = new Date(start).toISOString();

    // Insert the probe row
    await ctx.integrations.db.execute(
      `INSERT INTO diag_timeout_probes (probe_id, started_at, last_heartbeat_at)
       VALUES ($1, $2, $2)`,
      [probeId, startedAt],
      { label: "Insert probe row" },
    );

    // Sleep in 15s increments, heartbeat each tick
    const totalMs = sleepSeconds * 1000;
    const HEARTBEAT_INTERVAL = 15_000;
    let elapsed = 0;

    while (elapsed < totalMs) {
      const sleepMs = Math.min(HEARTBEAT_INTERVAL, totalMs - elapsed);
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
      elapsed = Date.now() - start;

      // Update heartbeat
      await ctx.integrations.db.execute(
        `UPDATE diag_timeout_probes
         SET last_heartbeat_at = NOW()
         WHERE probe_id = $1`,
        [probeId],
        { label: `Heartbeat at ${Math.round(elapsed / 1000)}s` },
      );
    }

    // Mark completion
    const finishedAt = new Date().toISOString();
    const survivedMs = Date.now() - start;

    await ctx.integrations.db.execute(
      `UPDATE diag_timeout_probes
       SET completed_at = $1, elapsed_ms = $2
       WHERE probe_id = $3`,
      [finishedAt, survivedMs, probeId],
      { label: "Mark probe completed" },
    );

    return {
      probeId,
      survivedMs,
      startedAt,
      finishedAt,
    };
  },
});
