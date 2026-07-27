/**
 * Diagnostic: Shows what row labels are derived by the numeric engine
 * for a given document/sheet, and what cells exist in the leftmost columns.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "InspectRowLabels",
  description: "Diagnostic: inspects row-label derivation for a doc_table",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    documentId: z.string(),
    sheetOrPage: z.string(),
    /** Search for rows containing this substring (case-insensitive) in any of cols 0-5 */
    searchLabel: z.string().default(""),
  }),

  output: z.object({
    tableId: z.string(),
    rowCount: z.number(),
    meaningfulHeaderCount: z.number(),
    meaningfulRatio: z.number(),
    derivationTriggered: z.boolean(),
    /** The column chosen by frequency-based heuristic */
    chosenLabelCol: z.number(),
    /** Rows matching searchLabel, showing cells in cols 0-5 */
    matchingRows: z.array(z.object({
      rowIdx: z.number(),
      originalHeader: z.string(),
      derivedLabel: z.string(),
      cells: z.array(z.object({
        col: z.number(),
        type: z.string(),
        value: z.string(),
      })),
    })),
    /** Summary: first 5 strings per column (cols 0-5) with their frequency */
    colStringFrequencies: z.array(z.object({
      col: z.number(),
      stringCount: z.number(),
      samples: z.array(z.string()),
    })),
  }),

  async run(ctx, { documentId, sheetOrPage, searchLabel }) {
    const TableSchema = z.object({
      id: z.string(),
      data: z.any(),
    });

    const rows = await ctx.integrations.db.query(
      `SELECT id, data FROM doc_tables
       WHERE document_id = $1::uuid AND sheet_or_page = $2
       LIMIT 1`,
      TableSchema,
      [documentId, sheetOrPage],
      { label: "InspectRowLabels: load table" }
    );

    if (rows.length === 0) {
      return {
        tableId: "NOT_FOUND",
        rowCount: 0,
        meaningfulHeaderCount: 0,
        meaningfulRatio: 0,
        derivationTriggered: false,
        chosenLabelCol: -1,
        matchingRows: [],
        colStringFrequencies: [],
      };
    }

    const raw = typeof rows[0].data === "string" ? JSON.parse(rows[0].data) : rows[0].data;
    const rowHeaders: string[] = raw.row_headers ?? [];
    const cells: Array<{ r: number; c: number; type: string; value: any }> = raw.cells ?? [];

    const rowCount = rowHeaders.length;
    const meaningfulCount = rowHeaders.filter(
      (h: string) => h !== "" && h !== "x" && h.length > 1
    ).length;
    const ratio = rowCount > 0 ? meaningfulCount / rowCount : 0;
    const derivationTriggered = rowCount > 0 && ratio < 0.3;

    // Reproduce the multi-column label derivation (matches engine exactly)
    const colStringFreq = new Map<number, number>();
    for (const cell of cells) {
      if (cell.r < rowCount && cell.type === "string" && cell.value != null && String(cell.value).trim() !== "" && cell.c < 6) {
        colStringFreq.set(cell.c, (colStringFreq.get(cell.c) ?? 0) + 1);
      }
    }

    // Sort columns by frequency (descending) — matches engine
    const labelCols = [...colStringFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([col]) => col);
    const chosenLabelCol = labelCols[0] ?? 0;

    // Build lookup: row,col → value
    const cellsByRowCol = new Map<string, string>();
    for (const cell of cells) {
      if (cell.r < rowCount && cell.type === "string" && cell.value != null && cell.c < 6) {
        const val = String(cell.value).trim();
        if (val && val !== "x") {
          cellsByRowCol.set(`${cell.r},${cell.c}`, val);
        }
      }
    }

    // Derive labels: iterate columns in frequency order (matches engine)
    const derived: string[] = new Array(rowCount).fill("");
    for (const col of labelCols) {
      for (let ri = 0; ri < rowCount; ri++) {
        if (derived[ri]) continue;
        const val = cellsByRowCol.get(`${ri},${col}`);
        if (val) {
          derived[ri] = val;
        }
      }
    }
    for (let i = 0; i < rowCount; i++) {
      if (!derived[i] && rowHeaders[i] && rowHeaders[i] !== "" && rowHeaders[i] !== "x") {
        derived[i] = rowHeaders[i];
      }
    }

    // col-string-frequency summary
    const colStringFrequencies: Array<{ col: number; stringCount: number; samples: string[] }> = [];
    for (let col = 0; col <= 5; col++) {
      const colCells = cells.filter((c: any) => c.c === col && c.r < rowCount && c.type === "string" && c.value != null && String(c.value).trim() !== "");
      const samples = colCells.slice(0, 5).map((c: any) => String(c.value).trim());
      colStringFrequencies.push({ col, stringCount: colCells.length, samples });
    }

    // Find matching rows
    const searchLower = searchLabel.toLowerCase();
    const matchingRows: Array<{ rowIdx: number; originalHeader: string; derivedLabel: string; cells: Array<{ col: number; type: string; value: string }> }> = [];

    for (let ri = 0; ri < rowCount && matchingRows.length < 30; ri++) {
      if (!searchLabel) {
        // If no search, show rows where derived label is non-empty AND differs from what we want
        if (derived[ri]) continue; // Skip rows that DO have labels
        // Only show blank-label rows that have numeric values (potential data rows)
        const hasNumeric = cells.some((c: any) => c.r === ri && c.type === "number" && c.c >= 4);
        if (!hasNumeric) continue;
      } else {
        // Check if any cell in cols 0-5 contains the search term
        const rowCells = cells.filter((c: any) => c.r === ri && c.c <= 5);
        const found = rowCells.some((c: any) => String(c.value ?? "").toLowerCase().includes(searchLower)) ||
                     rowHeaders[ri]?.toLowerCase().includes(searchLower) ||
                     derived[ri]?.toLowerCase().includes(searchLower);
        if (!found) continue;
      }

      const rowCellsData = cells
        .filter((c: any) => c.r === ri && c.c <= 5)
        .sort((a: any, b: any) => a.c - b.c)
        .map((c: any) => ({ col: c.c, type: c.type, value: String(c.value ?? "") }));

      matchingRows.push({
        rowIdx: ri,
        originalHeader: rowHeaders[ri] ?? "",
        derivedLabel: derived[ri] ?? "",
        cells: rowCellsData,
      });
    }

    return {
      tableId: rows[0].id,
      rowCount,
      meaningfulHeaderCount: meaningfulCount,
      meaningfulRatio: Math.round(ratio * 1000) / 1000,
      derivationTriggered,
      chosenLabelCol,
      matchingRows,
      colStringFrequencies,
    };
  },
});
