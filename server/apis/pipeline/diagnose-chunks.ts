/**
 * Diagnostic API — counts extraction chunks and Q&A chunks per document for a deal.
 * Helps verify indexing coverage. NOT production code.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ExtractionCountSchema = z.object({
  document_id: z.string(),
  file_name: z.string(),
  extraction_chunks: z.coerce.number(),
  expected_chunks: z.coerce.number(),
  parsed_text_length: z.coerce.number(),
  qa_chunks: z.coerce.number(),
});

export default api({
  name: "DiagnoseChunks",
  description: "Counts extraction and Q&A chunks per document for a deal",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    documents: z.array(ExtractionCountSchema),
    totalExtractionChunks: z.number(),
    totalQaChunks: z.number(),
  }),

  async run(ctx, { dealId }) {
    const rows = await ctx.integrations.db.query(
      `SELECT d.id AS document_id, d.file_name,
              COUNT(DISTINCT ue.chunk_index)::int AS extraction_chunks,
              CEIL(COALESCE(LENGTH(d.parsed_text), 0)::float / 5000)::int AS expected_chunks,
              COALESCE(LENGTH(d.parsed_text), 0)::int AS parsed_text_length,
              (SELECT COUNT(*)::int FROM document_chunks dc WHERE dc.document_id = d.id) AS qa_chunks
       FROM documents d
       LEFT JOIN universal_extractions ue ON ue.document_id = d.id
       WHERE d.deal_id = $1
       GROUP BY d.id, d.file_name
       ORDER BY extraction_chunks DESC
       LIMIT 10`,
      ExtractionCountSchema,
      [dealId],
      { label: "Extraction + QA chunk counts per document" }
    );

    const totalExtractionChunks = rows.reduce((sum, r) => sum + r.extraction_chunks, 0);
    const totalQaChunks = rows.reduce((sum, r) => sum + r.qa_chunks, 0);
    return { documents: rows, totalExtractionChunks, totalQaChunks };
  },
});
