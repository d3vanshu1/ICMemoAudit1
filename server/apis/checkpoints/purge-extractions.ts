import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CountSchema = z.object({ count: z.coerce.number() });

export default api({
  name: "PurgeExtractions",
  description: "Full reset of all pipeline data for a deal: extractions, analysis, doc_tables, outputs, merge checkpoints, and runs",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    extractionsDeleted: z.number(),
    analysisRowsDeleted: z.number(),
    docTablesDeleted: z.number(),
    outputsDeleted: z.number(),
    mergeCheckpointsDeleted: z.number(),
    runsDeleted: z.number(),
  }),

  async run(ctx, { dealId }) {
    // Count before deleting (avoids RETURNING blowing up gRPC response for large tables)
    // Order matters: delete children before parents (FK constraints)

    // 1. Universal extractions
    const [{ count: extCount }] = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS count FROM universal_extractions WHERE deal_id = $1`,
      CountSchema,
      [dealId],
      { label: "Count universal_extractions" }
    );
    await ctx.integrations.db.execute(
      `DELETE FROM universal_extractions WHERE deal_id = $1`,
      [dealId],
      { label: "Purge universal_extractions" }
    );

    // 2. Pipeline analysis (child of module_runs)
    const [{ count: analysisCount }] = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS count FROM pipeline_analysis
       WHERE run_id IN (SELECT id FROM module_runs WHERE deal_id = $1)`,
      CountSchema,
      [dealId],
      { label: "Count pipeline_analysis" }
    );
    await ctx.integrations.db.execute(
      `DELETE FROM pipeline_analysis
       WHERE run_id IN (SELECT id FROM module_runs WHERE deal_id = $1)`,
      [dealId],
      { label: "Purge pipeline_analysis" }
    );

    // 3. Doc tables
    const [{ count: docTablesCount }] = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS count FROM doc_tables
       WHERE document_id IN (SELECT id FROM documents WHERE deal_id = $1)`,
      CountSchema,
      [dealId],
      { label: "Count doc_tables" }
    );
    await ctx.integrations.db.execute(
      `DELETE FROM doc_tables
       WHERE document_id IN (SELECT id FROM documents WHERE deal_id = $1)`,
      [dealId],
      { label: "Purge doc_tables" }
    );

    // 4. Module outputs (child of module_runs)
    const [{ count: outputsCount }] = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS count FROM module_outputs
       WHERE module_run_id IN (SELECT id FROM module_runs WHERE deal_id = $1)`,
      CountSchema,
      [dealId],
      { label: "Count module_outputs" }
    );
    await ctx.integrations.db.execute(
      `DELETE FROM module_outputs
       WHERE module_run_id IN (SELECT id FROM module_runs WHERE deal_id = $1)`,
      [dealId],
      { label: "Purge module_outputs" }
    );

    // 5. Merge checkpoints (child of module_runs)
    const [{ count: mergeCount }] = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS count FROM merge_checkpoints
       WHERE module_run_id IN (SELECT id FROM module_runs WHERE deal_id = $1)`,
      CountSchema,
      [dealId],
      { label: "Count merge_checkpoints" }
    );
    await ctx.integrations.db.execute(
      `DELETE FROM merge_checkpoints
       WHERE module_run_id IN (SELECT id FROM module_runs WHERE deal_id = $1)`,
      [dealId],
      { label: "Purge merge_checkpoints" }
    );

    // 6. Module runs (parent — delete last after all children are gone)
    const [{ count: runsCount }] = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS count FROM module_runs WHERE deal_id = $1`,
      CountSchema,
      [dealId],
      { label: "Count module_runs" }
    );
    await ctx.integrations.db.execute(
      `DELETE FROM module_runs WHERE deal_id = $1`,
      [dealId],
      { label: "Purge module_runs" }
    );

    ctx.log.info(
      `[PurgeExtractions] Deal ${dealId}: removed ${extCount} extractions, ${analysisCount} analysis, ${docTablesCount} doc_tables, ${outputsCount} outputs, ${mergeCount} merge_checkpoints, ${runsCount} runs`
    );

    return {
      extractionsDeleted: extCount,
      analysisRowsDeleted: analysisCount,
      docTablesDeleted: docTablesCount,
      outputsDeleted: outputsCount,
      mergeCheckpointsDeleted: mergeCount,
      runsDeleted: runsCount,
    };
  },
});
