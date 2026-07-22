import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ExtractionInputSchema = z.object({
  documentId: z.string(),
  chunkIndex: z.number(),
  contentHash: z.string(),
  extraction: z.object({
    label: z.string(),
    extraction: z.string(),
    chunkIndex: z.number(),
    sourceFile: z.string(),
    documentTag: z.string(),
    failed: z.boolean().nullable().optional(),
  }),
});

export default api({
  name: "SaveExtractions",
  description: "Bulk-upserts universal extraction results for a deal",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    extractions: z.array(ExtractionInputSchema),
  }),

  output: z.object({
    saved: z.number(),
  }),

  async run(ctx, { dealId, extractions }) {
    let saved = 0;

    for (const ext of extractions) {
      await ctx.integrations.db.execute(
        `INSERT INTO universal_extractions (deal_id, document_id, chunk_index, content_hash, extraction_json)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (deal_id, document_id, chunk_index)
         DO UPDATE SET content_hash = EXCLUDED.content_hash,
                       extraction_json = EXCLUDED.extraction_json,
                       created_at = now()`,
        [dealId, ext.documentId, ext.chunkIndex, ext.contentHash, JSON.stringify(ext.extraction)],
        { label: `Upsert extraction chunk ${ext.chunkIndex}` }
      );
      saved++;
    }

    return { saved };
  },
});
