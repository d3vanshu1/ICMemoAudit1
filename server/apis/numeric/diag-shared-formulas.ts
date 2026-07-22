import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * Diagnostic: Check whether SheetJS populates cell.f for shared-formula
 * member cells. Reads stored doc_tables data for a specific sheet and
 * reports formula presence for cells in a given row range.
 */
export default api({
  name: "DiagSharedFormulas",
  description: "Diagnostic: check formula population for shared-formula cells in stored doc_tables",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string().uuid(),
    sheetName: z.string().describe("Sheet name to inspect, e.g. 'FS Summary'"),
    /** Relative row indices to inspect (0-based within the non-empty grid) */
    rowRange: z.object({
      start: z.number(),
      end: z.number(),
    }).nullable().optional(),
    /** If provided, filter to cells whose rowHeaders match this substring */
    rowLabelSubstring: z.string().nullable().optional(),
  }),

  output: z.object({
    found: z.boolean(),
    sheetCaption: z.string(),
    totalCells: z.number(),
    cellsWithFormula: z.number(),
    cellsWithoutFormula: z.number(),
    /** Sample cells showing formula presence/absence */
    sampleCells: z.array(z.object({
      r: z.number(),
      c: z.number(),
      absR: z.number().nullable(),
      absC: z.number().nullable(),
      rowLabel: z.string(),
      colLabel: z.string(),
      value: z.union([z.number(), z.string(), z.null()]),
      type: z.string(),
      formula: z.string().nullable(),
    })),
    /** Summary of "total" rows and their formula status per column */
    totalRowFormulas: z.array(z.object({
      rowLabel: z.string(),
      r: z.number(),
      columns: z.array(z.object({
        c: z.number(),
        colLabel: z.string(),
        value: z.union([z.number(), z.string(), z.null()]),
        formula: z.string().nullable(),
        hasFormula: z.boolean(),
      })),
    })),
  }),

  async run(ctx, { dealId, sheetName, rowRange, rowLabelSubstring }) {
    // Find the doc_table for this sheet
    const TableRow = z.object({
      id: z.string(),
      document_id: z.string(),
      sheet_or_page: z.string(),
      caption: z.string().nullable(),
    });

    const rows = await ctx.integrations.db.query(
      `SELECT dt.id, dt.document_id, dt.sheet_or_page, dt.caption
       FROM doc_tables dt
       JOIN documents d ON d.id = dt.document_id
       WHERE d.deal_id = $1::uuid
         AND dt.sheet_or_page ILIKE $2
       LIMIT 5`,
      TableRow,
      [dealId, `%${sheetName}%`],
      { label: `Find doc_tables matching sheet "${sheetName}"` }
    );

    if (rows.length === 0) {
      return {
        found: false,
        sheetCaption: "",
        totalCells: 0,
        cellsWithFormula: 0,
        cellsWithoutFormula: 0,
        sampleCells: [],
        totalRowFormulas: [],
      };
    }

    const row = rows[0];

    // Fetch row_headers and col_headers separately (small payloads)
    const HeadersRow = z.object({
      row_headers: z.any(),
      col_headers: z.any(),
    });
    const headersResult = await ctx.integrations.db.query(
      `SELECT data->'row_headers' as row_headers, data->'col_headers' as col_headers
       FROM doc_tables WHERE id = $1::uuid`,
      HeadersRow,
      [row.id],
      { label: "Fetch row/col headers" }
    );

    const rowHeaders: string[] = headersResult[0]?.row_headers ?? [];
    const colHeaders: string[] = headersResult[0]?.col_headers ?? [];

// Fetch ONLY cells in total rows (using JSONB array extraction + filtering)
// This avoids pulling 5MB+ of full cell data
const CellRow = z.object({
  cell: z.any(),
});

// Use jsonb_array_elements to sample cells that DO have formulas and those that don't
// First: check if ANY cells in this table have formulas at all
const cellsWithFormulasResult = await ctx.integrations.db.query(
  `SELECT elem AS cell
   FROM doc_tables,
        jsonb_array_elements(data->'cells') AS elem
   WHERE doc_tables.id = $1::uuid
     AND (elem->>'type') = 'number'
     AND elem->>'formula' IS NOT NULL
     AND (elem->>'formula') != ''
   LIMIT 50`,
  CellRow,
  [row.id],
  { label: "Fetch cells WITH formulas" }
);

const cellsWithoutFormulasResult = await ctx.integrations.db.query(
  `SELECT elem AS cell
   FROM doc_tables,
        jsonb_array_elements(data->'cells') AS elem
   WHERE doc_tables.id = $1::uuid
     AND (elem->>'type') = 'number'
     AND (elem->>'formula' IS NULL OR (elem->>'formula') = '')
   LIMIT 50`,
  CellRow,
  [row.id],
  { label: "Fetch cells WITHOUT formulas" }
);

// Also get total count of numeric cells and formula cells
const CountRow = z.object({ total_numeric: z.coerce.number(), with_formula: z.coerce.number() });
const countResult = await ctx.integrations.db.query(
  `SELECT
     COUNT(*) FILTER (WHERE (elem->>'type') = 'number') AS total_numeric,
     COUNT(*) FILTER (WHERE (elem->>'type') = 'number' AND elem->>'formula' IS NOT NULL AND (elem->>'formula') != '') AS with_formula
   FROM doc_tables,
        jsonb_array_elements(data->'cells') AS elem
   WHERE doc_tables.id = $1::uuid`,
  CountRow,
  [row.id],
  { label: "Count formula presence" }
);

const totalNumeric = countResult[0]?.total_numeric ?? 0;
const formulaCount = countResult[0]?.with_formula ?? 0;

type CellData = {
  r: number; c: number; absR?: number; absC?: number;
  value: number | string | null; type: string; formula?: string;
};

const cellsWithFormulas: CellData[] = cellsWithFormulasResult.map(cr => {
  const c = typeof cr.cell === "string" ? JSON.parse(cr.cell) : cr.cell;
  return c as CellData;
});
const cellsWithoutFormulas: CellData[] = cellsWithoutFormulasResult.map(cr => {
  const c = typeof cr.cell === "string" ? JSON.parse(cr.cell) : cr.cell;
  return c as CellData;
});

// Build sample cells from both pools
const sampleCells = [
  ...cellsWithFormulas.slice(0, 15).map(c => ({
    r: c.r, c: c.c,
    absR: c.absR ?? null, absC: c.absC ?? null,
    rowLabel: rowHeaders[c.r] ?? `row${c.r}`,
    colLabel: colHeaders[c.c] ?? `col${c.c}`,
    value: c.value, type: c.type,
    formula: c.formula ?? null,
  })),
  ...cellsWithoutFormulas.slice(0, 15).map(c => ({
    r: c.r, c: c.c,
    absR: c.absR ?? null, absC: c.absC ?? null,
    rowLabel: rowHeaders[c.r] ?? `row${c.r}`,
    colLabel: colHeaders[c.c] ?? `col${c.c}`,
    value: c.value, type: c.type,
    formula: c.formula ?? null,
  })),
];

// Find total rows (even if row_headers are mostly empty, try matching)
const totalRowFormulas: Array<{
  rowLabel: string;
  r: number;
  columns: Array<{
    c: number; colLabel: string;
    value: number | string | null;
    formula: string | null; hasFormula: boolean;
  }>;
}> = [];

// Use cells with formulas to identify which rows have subtotal-like formulas
const formulaRowSet = new Set(cellsWithFormulas.map(c => c.r));
for (const ri of [...formulaRowSet].slice(0, 10)) {
  const rowCells = cellsWithFormulas.filter(c => c.r === ri);
  totalRowFormulas.push({
    rowLabel: rowHeaders[ri] ?? `row${ri}`,
    r: ri,
    columns: rowCells.slice(0, 10).map(c => ({
      c: c.c,
      colLabel: colHeaders[c.c] ?? `col${c.c}`,
      value: c.value,
      formula: c.formula ?? null,
      hasFormula: !!(c.formula && c.formula.trim() !== ""),
    })),
  });
}

return {
  found: true,
  sheetCaption: row.caption ?? row.sheet_or_page,
  totalCells: totalNumeric,
  cellsWithFormula: formulaCount,
  cellsWithoutFormula: totalNumeric - formulaCount,
  sampleCells,
  totalRowFormulas: totalRowFormulas.slice(0, 20),
};
  },
});
