import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ExtractionStatusRowSchema = z.object({
  document_id: z.string(),
  chunk_index: z.coerce.number(),
  source_file: z.string().nullable(),
  status: z.string(),
  content_hash: z.string(),
});

/**
 * Per-chunk extraction status:
 * - "extracted": successful extraction with content
 * - "empty": extraction ran but chunk yielded no meaningful content (confirmed-empty)
 * - "failed": extraction attempted but failed (API error, timeout, etc.)
 */
export default api({
  name: "GetExtractionStatus",
  description: "Returns per-chunk extraction status for a deal (extracted/empty/failed)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    documentId: z.string().nullable().optional(),
  }),

  output: z.object({
    chunks: z.array(
      z.object({
        documentId: z.string(),
        chunkIndex: z.number(),
        sourceFile: z.string(),
        status: z.enum(["extracted", "empty", "failed"]),
        contentHash: z.string(),
      })
    ),
    summary: z.object({
      total: z.number(),
      extracted: z.number(),
      empty: z.number(),
      failed: z.number(),
    }),
  }),

  async run(ctx, { dealId, documentId }) {
    // Query extraction checkpoints and determine status from the stored JSON
    // The 'failed' flag is stored inside extraction_json; confirmed-empty is
    // when extraction ran but text output is minimal/blank.
    const filterClause = documentId
      ? `AND document_id = $2`
      : ``;
    const params = documentId ? [dealId, documentId] : [dealId];

    const rows = await ctx.integrations.db.query(
      `SELECT
         document_id,
         chunk_index,
         content_hash,
         extraction_json->>'sourceFile' as source_file,
         CASE
           WHEN (extraction_json->>'failed')::boolean = true THEN 'failed'
           WHEN length(COALESCE(extraction_json->>'extraction', '')) < 50 THEN 'empty'
           ELSE 'extracted'
         END as status
       FROM universal_extractions
       WHERE deal_id = $1 ${filterClause}
       ORDER BY document_id, chunk_index
       LIMIT 2000`,
      ExtractionStatusRowSchema,
      params,
      { label: "Load extraction status per chunk" }
    );

    const chunks = rows.map(row => ({
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      sourceFile: row.source_file ?? "",
      status: row.status as "extracted" | "empty" | "failed",
      contentHash: row.content_hash,
    }));

    const summary = {
      total: chunks.length,
      extracted: chunks.filter(c => c.status === "extracted").length,
      empty: chunks.filter(c => c.status === "empty").length,
      failed: chunks.filter(c => c.status === "failed").length,
    };

    return { chunks, summary };
  },
});
