import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CoverageRowSchema = z.object({
  module_run_id: z.string(),
  documents_included: z.any(),
  documents_excluded: z.any(),
  chunk_count: z.number(),
  pages_processed: z.number(),
});

export default api({
  name: "LoadRunCoverage",
  description: "Loads the coverage manifest for a module run",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    moduleRunId: z.string(),
  }),

  output: z.object({
    coverage: z
      .object({
        documentsIncluded: z.array(z.any()),
        documentsExcluded: z.array(z.any()),
        chunkCount: z.number(),
        pagesProcessed: z.number(),
      })
      .nullable(),
  }),

  async run(ctx, input) {
    const rows = await ctx.integrations.db.query(
      `SELECT module_run_id, documents_included, documents_excluded, chunk_count, pages_processed
       FROM run_coverage
       WHERE module_run_id = $1::uuid
       LIMIT 1`,
      CoverageRowSchema,
      [input.moduleRunId],
      { label: "Load run coverage manifest" }
    );

    if (rows.length === 0) {
      return { coverage: null };
    }

    const row = rows[0];
    return {
      coverage: {
        documentsIncluded: Array.isArray(row.documents_included) ? row.documents_included : [],
        documentsExcluded: Array.isArray(row.documents_excluded) ? row.documents_excluded : [],
        chunkCount: row.chunk_count,
        pagesProcessed: row.pages_processed,
      },
    };
  },
});
