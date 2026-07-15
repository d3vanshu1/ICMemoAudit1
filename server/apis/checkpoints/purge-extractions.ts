import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "PurgeExtractions",
  description: "Deletes cached universal_extractions and pipeline_analysis for a deal",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    extractionsDeleted: z.number(),
    analysisRowsDeleted: z.number(),
  }),

  async run(ctx, { dealId }) {
    // 1. Delete cached universal extractions
    const extResult = await ctx.integrations.db.query(
      `DELETE FROM universal_extractions WHERE deal_id = $1 RETURNING id`,
      z.object({ id: z.string() }),
      [dealId],
      { label: "Purge universal_extractions for deal" }
    );

    // 2. Delete pipeline_analysis rows for all runs belonging to this deal
    const analysisResult = await ctx.integrations.db.query(
      `DELETE FROM pipeline_analysis
       WHERE run_id IN (SELECT id FROM module_runs WHERE deal_id = $1)
       RETURNING run_id`,
      z.object({ run_id: z.string() }),
      [dealId],
      { label: "Purge pipeline_analysis for deal runs" }
    );

    ctx.log.info(
      `[PurgeExtractions] Deal ${dealId}: removed ${extResult.length} extractions, ${analysisResult.length} analysis rows`
    );

    return {
      extractionsDeleted: extResult.length,
      analysisRowsDeleted: analysisResult.length,
    };
  },
});
