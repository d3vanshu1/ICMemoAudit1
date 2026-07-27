import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "InspectColHeaders",
  description: "Diagnostic: returns col_headers for a specific doc_tables sheet",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    documentId: z.string().uuid(),
    sheetOrPage: z.string(),
  }),

  output: z.object({
    colHeaders: z.array(z.string()),
    colCount: z.number(),
    rowHeaderSample: z.array(z.string()),
    rowCount: z.number(),
    headerRowCells: z.array(z.object({
      r: z.number(),
      c: z.number(),
      value: z.any(),
      type: z.string(),
    })),
  }),

  async run(ctx, { documentId, sheetOrPage }) {
    const ColSchema = z.object({ label: z.string() });
    const colHeaders = await ctx.integrations.db.query(
      `SELECT elem::text AS label
       FROM doc_tables, jsonb_array_elements_text(data->'col_headers') AS elem
       WHERE document_id = $1::uuid AND sheet_or_page = $2
       LIMIT 200`,
      ColSchema,
      [documentId, sheetOrPage],
      { label: "Get col_headers" }
    );

    const RowSchema = z.object({ label: z.string() });
    const rowHeaders = await ctx.integrations.db.query(
      `SELECT elem::text AS label
       FROM doc_tables, jsonb_array_elements_text(data->'row_headers') AS elem
       WHERE document_id = $1::uuid AND sheet_or_page = $2
       LIMIT 20`,
      RowSchema,
      [documentId, sheetOrPage],
      { label: "Get row_headers sample" }
    );

    // Get cells in the first 6 rows (header area) to find period labels
    const CellSchema = z.object({
      r: z.coerce.number(),
      c: z.coerce.number(),
      value: z.any(),
      type: z.string(),
    });
    const headerCells = await ctx.integrations.db.query(
      `SELECT (cell->>'r')::int AS r, (cell->>'c')::int AS c,
              cell->>'value' AS value, cell->>'type' AS type
       FROM doc_tables, jsonb_array_elements(data->'cells') AS cell
       WHERE document_id = $1::uuid AND sheet_or_page = $2
         AND (cell->>'r')::int < 6
       ORDER BY (cell->>'r')::int, (cell->>'c')::int
       LIMIT 500`,
      CellSchema,
      [documentId, sheetOrPage],
      { label: "Get header row cells" }
    );

    return {
      colHeaders: colHeaders.map(c => c.label),
      colCount: colHeaders.length,
      rowHeaderSample: rowHeaders.map(r => r.label),
      rowCount: rowHeaders.length,
      headerRowCells: headerCells,
    };
  },
});
