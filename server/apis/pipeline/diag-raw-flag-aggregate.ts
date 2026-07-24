/**
 * Diagnostic API — Raw Flag Aggregate
 *
 * Counts raw flags from universal_extractions before the merge phase reduces them.
 * Shows per-document breakdown of extraction output:
 *   - Total chunks extracted
 *   - Total flags/data_points/claims per document
 *   - Failed extractions
 *
 * This is a pre-merge view: what the sub-agent produced before tree-reduce.
 * All counting is done in SQL to avoid gRPC payload limits.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const DocAggRowSchema = z.object({
  document_id: z.string(),
  file_name: z.string(),
  total_chunks: z.coerce.number(),
  failed_chunks: z.coerce.number(),
  flag_count: z.coerce.number(),
  data_point_count: z.coerce.number(),
  claim_count: z.coerce.number(),
});

const DocAggregateSchema = z.object({
  documentId: z.string(),
  fileName: z.string(),
  totalChunks: z.number(),
  failedChunks: z.number(),
  flagCount: z.number(),
  dataPointCount: z.number(),
  claimCount: z.number(),
});

export default api({
  name: "DiagRawFlagAggregate",
  description: "Counts raw flags/data_points/claims per document from universal_extractions (pre-merge view)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    documents: z.array(DocAggregateSchema),
    totals: z.object({
      totalChunks: z.number(),
      failedChunks: z.number(),
      flagCount: z.number(),
      dataPointCount: z.number(),
      claimCount: z.number(),
    }),
  }),

  async run(ctx, { dealId }) {
    // Count flags/data_points/claims in SQL to avoid loading full JSON payloads
    const rows = await ctx.integrations.db.query(
      `SELECT
         ue.document_id,
         COALESCE(d.file_name, 'unknown') AS file_name,
         COUNT(*)::int AS total_chunks,
         COUNT(*) FILTER (WHERE (ue.extraction_json->>'failed')::boolean = true
                          OR (ue.extraction_json->>'permanently_failed')::boolean = true)::int AS failed_chunks,
         COALESCE(SUM(jsonb_array_length(COALESCE(ue.extraction_json->'flags', '[]'::jsonb)))
           FILTER (WHERE NOT ((ue.extraction_json->>'failed')::boolean = true
                              OR (ue.extraction_json->>'permanently_failed')::boolean = true)), 0)::int AS flag_count,
         COALESCE(SUM(jsonb_array_length(COALESCE(ue.extraction_json->'data_points', '[]'::jsonb)))
           FILTER (WHERE NOT ((ue.extraction_json->>'failed')::boolean = true
                              OR (ue.extraction_json->>'permanently_failed')::boolean = true)), 0)::int AS data_point_count,
         COALESCE(SUM(jsonb_array_length(COALESCE(ue.extraction_json->'key_claims', '[]'::jsonb)))
           FILTER (WHERE NOT ((ue.extraction_json->>'failed')::boolean = true
                              OR (ue.extraction_json->>'permanently_failed')::boolean = true)), 0)::int AS claim_count
       FROM universal_extractions ue
       LEFT JOIN documents d ON d.id = ue.document_id
       WHERE ue.deal_id = $1
       GROUP BY ue.document_id, d.file_name
       ORDER BY d.file_name`,
      DocAggRowSchema,
      [dealId],
      { label: "Aggregate raw flags per document (SQL-side counting)" }
    );

    const documents = rows.map(r => ({
      documentId: r.document_id,
      fileName: r.file_name,
      totalChunks: r.total_chunks,
      failedChunks: r.failed_chunks,
      flagCount: r.flag_count,
      dataPointCount: r.data_point_count,
      claimCount: r.claim_count,
    }));

    const totals = {
      totalChunks: documents.reduce((s, d) => s + d.totalChunks, 0),
      failedChunks: documents.reduce((s, d) => s + d.failedChunks, 0),
      flagCount: documents.reduce((s, d) => s + d.flagCount, 0),
      dataPointCount: documents.reduce((s, d) => s + d.dataPointCount, 0),
      claimCount: documents.reduce((s, d) => s + d.claimCount, 0),
    };

    return { documents, totals };
  },
});
