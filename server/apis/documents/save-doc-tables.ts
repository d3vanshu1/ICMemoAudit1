import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const StructuredCellSchema = z.object({
  r: z.number(),
  c: z.number(),
  value: z.union([z.number(), z.string(), z.null()]),
  type: z.enum(["number", "string", "date", "boolean", "empty"]),
  formula: z.string().nullable().optional(),
});

const TableDataSchema = z.object({
  row_headers: z.array(z.string()),
  col_headers: z.array(z.string()),
  cells: z.array(StructuredCellSchema),
});

const TableInputSchema = z.object({
  documentId: z.string().uuid(),
  sheetOrPage: z.string(),
  caption: z.string().nullable(),
  data: TableDataSchema,
});

export default api({
  name: "SaveDocTables",
  description: "Persists structured cell grids parsed from Excel/CSV for numeric verification",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    tables: z.array(TableInputSchema),
  }),

  output: z.object({
    saved: z.number(),
  }),

  async run(ctx, { tables }) {
    if (tables.length === 0) return { saved: 0 };

    let saved = 0;

    // Batch insert — process in groups of 20 to stay well under SQL limits
    const BATCH_SIZE = 20;
    for (let i = 0; i < tables.length; i += BATCH_SIZE) {
      const batch = tables.slice(i, i + BATCH_SIZE);

      for (const table of batch) {
        await ctx.integrations.db.execute(
          `INSERT INTO doc_tables (document_id, sheet_or_page, caption, data)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (document_id, sheet_or_page)
           DO UPDATE SET caption = EXCLUDED.caption,
                         data = EXCLUDED.data,
                         created_at = now()`,
          [
            table.documentId,
            table.sheetOrPage,
            table.caption,
            JSON.stringify(table.data),
          ],
          { label: `Upsert doc_table: ${table.sheetOrPage}` }
        );
        saved++;
      }
    }

    return { saved };
  },
});
