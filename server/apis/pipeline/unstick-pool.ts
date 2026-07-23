/**
 * UnstickPool — one-off diagnostic to terminate stuck Postgres backends.
 *
 * The failed RunMigration008 type-rename attempt left a backend waiting for
 * an ACCESS EXCLUSIVE lock on module_runs. This exhausted the connection pool.
 *
 * This API queries pg_stat_activity (catalog table — doesn't queue behind
 * table-level locks) and terminates our role's idle-in-transaction or
 * lock-waiting backends. pg_terminate_backend on our own role doesn't
 * require superuser.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ActivityRow = z.object({
  pid: z.coerce.number(),
  state: z.string().nullable(),
  wait_event_type: z.string().nullable(),
  wait_event: z.string().nullable(),
  query_start: z.string().nullable(),
  query: z.string().nullable(),
});

const TerminateResult = z.object({
  pid: z.coerce.number(),
  terminated: z.coerce.boolean(),
});

export default api({
  name: "UnstickPool",
  description: "Terminates stuck Postgres backends from failed migration to restore pool",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    before: z.array(ActivityRow),
    terminated: z.array(TerminateResult),
    after: z.array(ActivityRow),
    message: z.string(),
  }),

  async run(ctx) {
    // Step 1: Snapshot current backends for our role
    const before = await ctx.integrations.db.query(
      `SELECT pid, state, wait_event_type, wait_event,
              query_start::text, left(query, 200) AS query
       FROM pg_stat_activity
       WHERE usename = current_user
         AND pid != pg_backend_pid()
       ORDER BY query_start`,
      ActivityRow,
      [],
      { label: "Snapshot pg_stat_activity (before)" }
    );

    // Step 2: Identify stuck backends — idle in transaction, or waiting on locks,
    // or active for more than 60 seconds (likely the stuck migration)
    const stuckPids = before.filter((row) => {
      if (row.state === "idle in transaction") return true;
      if (row.state === "idle in transaction (aborted)") return true;
      if (row.wait_event_type === "Lock") return true;
      // Active queries running > 60s that look like our migration DDL
      if (row.query && (
        row.query.includes("module_status") ||
        row.query.includes("ALTER TYPE") ||
        row.query.includes("ALTER TABLE module_runs")
      )) return true;
      return false;
    });

    // Step 3: Terminate each stuck backend
    const terminated: Array<{ pid: number; terminated: boolean }> = [];
    for (const row of stuckPids) {
      const [result] = await ctx.integrations.db.query(
        `SELECT $1::int AS pid, pg_terminate_backend($1) AS terminated`,
        TerminateResult,
        [row.pid],
        { label: `Terminate backend ${row.pid}` }
      );
      terminated.push(result);
    }

    // Step 4: Brief pause for backends to die
    await new Promise((r) => setTimeout(r, 1000));

    // Step 5: After snapshot
    const after = await ctx.integrations.db.query(
      `SELECT pid, state, wait_event_type, wait_event,
              query_start::text, left(query, 200) AS query
       FROM pg_stat_activity
       WHERE usename = current_user
         AND pid != pg_backend_pid()
       ORDER BY query_start`,
      ActivityRow,
      [],
      { label: "Snapshot pg_stat_activity (after)" }
    );

    const msg = terminated.length === 0
      ? `No stuck backends found. ${before.length} active backends for our role.`
      : `Terminated ${terminated.filter(t => t.terminated).length}/${terminated.length} backends. Pool should be healthy.`;

    return { before, terminated, after, message: msg };
  },
});
