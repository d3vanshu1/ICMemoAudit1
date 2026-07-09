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

    // Load tables one-at-a-time to stay under gRPC 4MB response limit.
    // Skip tables whose data exceeds 2.5MB (large customer-detail sheets).
    const MAX_DATA_BYTES = 2_500_000;

    const MetaSchema = z.object({
      id: z.string(),
      document_id: z.string(),
      sheet_or_page: z.string(),
      caption: z.string().nullable(),
      data_length: z.coerce.number(),
    });

    const metas = await ctx.integrations.db.query(
      `SELECT id, document_id, sheet_or_page, caption, length(data::text) AS data_length
       FROM doc_tables
       WHERE document_id = ANY($1::uuid[])
       ORDER BY document_id, sheet_or_page`,
      MetaSchema,
      [documentIds],
      { label: "List doc_tables metadata" }
    );

    const tables: Array<{
      id: string;
      documentId: string;
      sheetOrPage: string;
      caption: string | null;
      data: any;
    }> = [];

    for (const meta of metas) {
      if (meta.data_length > MAX_DATA_BYTES) {
        // Return metadata only for oversized tables
        tables.push({
          id: meta.id,
          documentId: meta.document_id,
          sheetOrPage: meta.sheet_or_page,
          caption: meta.caption,
          data: { _oversized: true, data_length: meta.data_length, row_headers: [], col_headers: [], cells: [] },
        });
        continue;
      }

      const rows = await ctx.integrations.db.query(
        `SELECT id, document_id, sheet_or_page, caption, data
         FROM doc_tables WHERE id = $1::uuid`,
        DocTableRowSchema,
        [meta.id],
        { label: `Load table ${meta.sheet_or_page}` }
      );

      for (const r of rows) {
        tables.push({
          id: r.id,
          documentId: r.document_id,
          sheetOrPage: r.sheet_or_page,
          caption: r.caption,
          data: r.data,
        });
      }
    }

    return { tables };
  },
});
