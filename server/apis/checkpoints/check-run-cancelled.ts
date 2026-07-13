import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const StatusSchema = z.object({ status: z.string() });

export default api({
  name: "CheckRunCancelled",
  description: "Lightweight poll to check if a module run has been cancelled",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    cancelled: z.boolean(),
  }),

  async run(ctx, { runId }) {
    const rows = await ctx.integrations.db.query(
      `SELECT status FROM module_runs WHERE id = $1 LIMIT 1`,
      StatusSchema,
      [runId],
      { label: `Check cancellation: ${runId}` }
    );

    const status = rows[0]?.status ?? "unknown";
    return { cancelled: status === "cancelled" };
  },
});
