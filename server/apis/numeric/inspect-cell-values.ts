/**
 * Diagnostic: check specific cells at given rows/columns to verify numeric data exists.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "InspectCellValues",
  description: "Diagnostic: checks cell values at specific rows and columns",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    tableId: z.string(),
    rows: z.array(z.number()).describe("Row indices to check"),
    cols: z.array(z.number()).describe("Column indices to check"),
  }),

  output: z.object({
    cells: z.array(z.object({
      r: z.number(),
      c: z.number(),
      type: z.string(),
      value: z.string(),
    })),
  }),

  async run(ctx, { tableId, rows, cols }) {
    const DataSchema = z.object({ data: z.any() });
    const tableRows = await ctx.integrations.db.query(
      `SELECT data FROM doc_tables WHERE id = $1 LIMIT 1`,
      DataSchema,
      [tableId],
      { label: "Get table data" }
    );

    if (tableRows.length === 0) return { cells: [] };

    const raw = typeof tableRows[0].data === "string" 
      ? JSON.parse(tableRows[0].data) 
      : tableRows[0].data;
    const allCells: Array<{ r: number; c: number; type: string; value: any }> = raw.cells ?? [];

    // Filter to requested rows and columns
    const result = allCells
      .filter(cell => rows.includes(cell.r) && cols.includes(cell.c))
      .sort((a, b) => a.r - b.r || a.c - b.c)
      .map(cell => ({
        r: cell.r,
        c: cell.c,
        type: cell.type ?? "unknown",
        value: String(cell.value ?? ""),
      }));

    return { cells: result };
  },
});
