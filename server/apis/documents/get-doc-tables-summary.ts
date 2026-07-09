import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const SummaryRowSchema = z.object({
  document_id: z.string(),
  file_name: z.string(),
  sheet_or_page: z.string(),
  caption: z.string().nullable(),
  cell_count: z.number(),
  data_length: z.number(),
});

export default api({
  name: "GetDocTablesSummary",
  description: "Returns doc_tables row counts and metadata without full data payloads",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string().uuid(),
  }),

  output: z.object({
    totalRows: z.number(),
    sheets: z.array(
      z.object({
        documentId: z.string(),
        fileName: z.string(),
        sheetOrPage: z.string(),
        caption: z.string().nullable(),
        cellCount: z.number(),
        dataLengthBytes: z.number(),
      })
    ),
  }),

  async run(ctx, { dealId }) {
    const rows = await ctx.integrations.db.query(
      `SELECT
         dt.document_id,
         d.file_name,
         dt.sheet_or_page,
         dt.caption,
         jsonb_array_length(dt.data->'cells') AS cell_count,
         length(dt.data::text) AS data_length
       FROM doc_tables dt
       JOIN documents d ON dt.document_id = d.id
       WHERE d.deal_id = $1
       ORDER BY d.file_name, dt.sheet_or_page
       LIMIT 100`,
      SummaryRowSchema,
      [dealId],
      { label: "Summarize doc_tables for deal" }
    );

    return {
      totalRows: rows.length,
      sheets: rows.map((r) => ({
        documentId: r.document_id,
        fileName: r.file_name,
        sheetOrPage: r.sheet_or_page,
        caption: r.caption,
        cellCount: r.cell_count,
        dataLengthBytes: r.data_length,
      })),
    };
  },
});
