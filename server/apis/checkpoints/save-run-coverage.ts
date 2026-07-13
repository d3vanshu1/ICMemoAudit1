import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ProcessedFileSchema = z.object({
  fileName: z.string(),
  chunkCount: z.number(),
  pageCount: z.number(),
});

const ExcludedFileSchema = z.object({
  fileName: z.string(),
  reason: z.enum(["unsupported_type", "parse_failure", "superseded", "spreadsheet", "too_large"]),
  detail: z.string().optional(),
});

export default api({
  name: "SaveRunCoverage",
  description: "Upserts a coverage manifest for a module run",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    moduleRunId: z.string(),
    documentsIncluded: z.array(ProcessedFileSchema),
    documentsExcluded: z.array(ExcludedFileSchema),
    chunkCount: z.number(),
    pagesProcessed: z.number(),
  }),

  output: z.object({ saved: z.boolean() }),

  async run(ctx, input) {
    await ctx.integrations.db.execute(
      `INSERT INTO run_coverage (module_run_id, documents_included, documents_excluded, chunk_count, pages_processed)
       VALUES ($1::uuid, $2::jsonb, $3::jsonb, $4, $5)
       ON CONFLICT (module_run_id) DO UPDATE SET
         documents_included = EXCLUDED.documents_included,
         documents_excluded = EXCLUDED.documents_excluded,
         chunk_count = EXCLUDED.chunk_count,
         pages_processed = EXCLUDED.pages_processed`,
      [
        input.moduleRunId,
        JSON.stringify(input.documentsIncluded),
        JSON.stringify(input.documentsExcluded),
        input.chunkCount,
        input.pagesProcessed,
      ],
      { label: "Upsert run coverage manifest" }
    );

    return { saved: true };
  },
});
