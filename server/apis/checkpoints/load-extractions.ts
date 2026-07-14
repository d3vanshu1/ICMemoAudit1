import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const StoredExtractionSchema = z.object({
  document_id: z.string(),
  chunk_index: z.coerce.number(),
  content_hash: z.string(),
  extraction_json: z.any(),
});

export default api({
  name: "LoadExtractions",
  description: "Loads cached universal extractions for a deal from the DB",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    extractions: z.array(
      z.object({
        documentId: z.string(),
        chunkIndex: z.number(),
        contentHash: z.string(),
        extraction: z.object({
          label: z.string(),
          extraction: z.string(),
          chunkIndex: z.number(),
          sourceFile: z.string(),
          documentTag: z.string(),
          failed: z.boolean().optional(),
        }),
      })
    ),
  }),

  async run(ctx, { dealId }) {
    const rows = await ctx.integrations.db.query(
      `SELECT document_id, chunk_index, content_hash, extraction_json
       FROM universal_extractions
       WHERE deal_id = $1
       ORDER BY document_id, chunk_index
       LIMIT 500`,
      StoredExtractionSchema,
      [dealId],
      { label: "Load cached extractions for deal" }
    );

    const extractions = rows.map((row) => {
      const ext = typeof row.extraction_json === "string"
        ? JSON.parse(row.extraction_json)
        : row.extraction_json;
      return {
        documentId: row.document_id,
        chunkIndex: row.chunk_index,
        contentHash: row.content_hash,
        extraction: {
          label: String(ext.label ?? ""),
          extraction: String(ext.extraction ?? ""),
          chunkIndex: Number(ext.chunkIndex ?? row.chunk_index),
          sourceFile: String(ext.sourceFile ?? ""),
          documentTag: String(ext.documentTag ?? "other"),
          ...(ext.failed ? { failed: true } : {}),
        },
      };
    });

    return { extractions };
  },
});
