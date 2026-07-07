import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const DocTableRowSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  sheet_or_page: z.string(),
  caption: z.string().nullable(),
  data: z.any(),
});

export default api({
  name: "GetDocTables",
  description: "Loads structured cell grids for documents in a deal",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    documentIds: z.array(z.string()),
  }),

  output: z.object({
    tables: z.array(z.object({
      id: z.string(),
      documentId: z.string(),
      sheetOrPage: z.string(),
      caption: z.string().nullable(),
      data: z.any(),
    })),
  }),

  async run(ctx, { documentIds }) {
    if (documentIds.length === 0) return { tables: [] };

    const rows = await ctx.integrations.db.query(
      `SELECT id, document_id, sheet_or_page, caption, data
       FROM doc_tables
       WHERE document_id = ANY($1::uuid[])
       ORDER BY document_id, sheet_or_page`,
      DocTableRowSchema,
      [documentIds],
      { label: "Load doc_tables for documents" }
    );

    return {
      tables: rows.map((r) => ({
        id: r.id,
        documentId: r.document_id,
        sheetOrPage: r.sheet_or_page,
        caption: r.caption,
        data: r.data,
      })),
    };
  },
});
