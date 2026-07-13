import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const StructuredCellSchema = z.object({
  r: z.number(),
  c: z.number(),
  value: z.union([z.number(), z.string(), z.null()]),
  type: z.enum(["number", "string", "date", "boolean", "empty"]),
  formula: z.string().optional(),
});

const TableDataSchema = z.object({
  row_headers: z.array(z.string()),
  col_headers: z.array(z.string()),
  cells: z.array(StructuredCellSchema),
});

const DocTableSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  sheet_or_page: z.string(),
  caption: z.string().nullable(),
  data: z.any(), // validated below after JSON parse
});

const FigureSchema = z.object({
  name: z.string(),
  recomputed_value: z.union([z.number(), z.string()]),
  source_doc: z.string(),
  source_cell: z.string(),
  formula: z.string().optional(),
});

const DiscrepancySchema = z.object({
  description: z.string(),
  severity: z.enum(["critical", "warning", "info"]),
  check_type: z.enum(["subtotal_reconciliation", "sign_consistency", "monotonicity", "cross_doc_agreement"]),
  sources: z.array(z.string()),
  expected: z.union([z.number(), z.string()]).optional(),
  actual: z.union([z.number(), z.string()]).optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Cell = {
  r: number;
  c: number;
  value: number | string | null;
  type: "number" | "string" | "date" | "boolean" | "empty";
  formula?: string;
};

type ParsedTable = {
  id: string;
  documentId: string;
  sheetOrPage: string;
  caption: string;
  rowHeaders: string[];
  colHeaders: string[];
  cells: Cell[];
  // Derived grid: [row][col] -> Cell | undefined
  grid: Map<string, Cell>;
};

type Figure = z.infer<typeof FigureSchema>;
type Discrepancy = z.infer<typeof DiscrepancySchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOLERANCE = 1e-6; // floating-point tolerance for equality

function round(v: number, places = 4): number {
  return Math.round(v * 10 ** places) / 10 ** places;
}

function numericCellsInRow(table: ParsedTable, rowIdx: number): Cell[] {
  return table.cells.filter((c) => c.r === rowIdx && c.type === "number" && c.value !== null);
}

function numericCellsInCol(table: ParsedTable, colIdx: number): Cell[] {
  return table.cells.filter((c) => c.c === colIdx && c.type === "number" && c.value !== null);
}

function cellRef(table: ParsedTable, cell: Cell): string {
  const row = table.rowHeaders[cell.r] ?? `row${cell.r}`;
  const col = table.colHeaders[cell.c] ?? `col${cell.c}`;
  return `[${table.sheetOrPage}] ${row} / ${col}`;
}

function isSubtotalHeader(header: string): boolean {
  const h = header.toLowerCase().trim();
  if (!h) return false;

  // Use word-boundary regex to avoid false positives like "Ethernet" matching "net"
  // or "Networks" matching "net"
  if (/\b(total|subtotal|sub-total|sum|grand)\b/.test(h)) return true;
  if (/\b(aggregate)\b/.test(h)) return true;
  if (/\bgross\s*profit\b/.test(h)) return true;
  if (/\bebitda\b/.test(h)) return true;
  // "ebit" but not inside "ebitda" 
  if (/\bebit\b/.test(h) && !/\bebitda\b/.test(h)) return true;
  if (/\bnoi\b/.test(h)) return true;

  // "Net" is only a subtotal indicator when it appears with financial context:
  // "Net income", "Net revenue", "Net profit", "Net of X", or standalone "Net"
  // NOT: "Net upsell/Downsell", "Net new", "Net adds"
  if (/\bnet\s+(income|revenue|profit|result|earnings|margin|proceeds|cash|operating|position)\b/.test(h)) return true;
  if (/^net$/.test(h)) return true; // standalone "Net"

  return false;
}

function isSensitivityHeader(headers: string[]): boolean {
  // Sensitivity tables typically have numeric-like headers (% changes or absolute values)
  let numericHeaders = 0;
  for (const h of headers) {
    if (!h) continue;
    const cleaned = h.replace(/[%x\s]/gi, "");
    if (!isNaN(Number(cleaned)) && cleaned !== "") numericHeaders++;
  }
  return numericHeaders >= Math.min(3, headers.length);
}

function isCashFlowSheet(caption: string, sheetName: string): boolean {
  const text = (caption + " " + sheetName).toLowerCase();
  return (
    text.includes("cash flow") ||
    text.includes("cashflow") ||
    text.includes("ofcf") ||
    text.includes("fcf") ||
    text.includes("bridge") ||
    text.includes("waterfall") ||
    text.includes("sources and uses")
  );
}

function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function buildGrid(table: ParsedTable): void {
  for (const cell of table.cells) {
    table.grid.set(`${cell.r},${cell.c}`, cell);
  }
}

// ---------------------------------------------------------------------------
// Check 1: Subtotal reconciliation
// Scan each row that has a "total" label; sum the preceding numeric rows
// in the same column and compare.
// ---------------------------------------------------------------------------

function checkSubtotalReconciliation(
  table: ParsedTable,
  figures: Figure[],
  discrepancies: Discrepancy[]
): void {
  const { rowHeaders, colHeaders } = table;
  if (rowHeaders.length < 2) return;

  // Find total rows
  const totalRowIndices: number[] = [];
  for (let ri = 0; ri < rowHeaders.length; ri++) {
    if (isSubtotalHeader(rowHeaders[ri])) totalRowIndices.push(ri);
  }

  for (const totalRow of totalRowIndices) {
    // For each numeric column in the total row
    const totalCells = numericCellsInRow(table, totalRow);

    for (const totalCell of totalCells) {
      const reportedTotal = totalCell.value as number;
      const ci = totalCell.c;

      // Sum preceding rows until the last total row (or start)
      const prevTotalIdx = [...totalRowIndices].reverse().find((t) => t < totalRow) ?? -1;
      const startRow = prevTotalIdx + 1;

      const addends: number[] = [];
      for (let ri = startRow; ri < totalRow; ri++) {
        const cell = table.grid.get(`${ri},${ci}`);
        if (cell?.type === "number" && cell.value !== null && !isSubtotalHeader(rowHeaders[ri])) {
          addends.push(cell.value as number);
        }
      }

      if (addends.length < 2) continue; // not enough data to verify

      const recomputed = round(addends.reduce((a, b) => a + b, 0));
      const reported = round(reportedTotal);

      // Record the figure
      figures.push({
        name: `${rowHeaders[totalRow]} (${colHeaders[ci] || `col${ci}`})`,
        recomputed_value: recomputed,
        source_doc: table.documentId,
        source_cell: cellRef(table, totalCell),
        formula: totalCell.formula,
      });

      if (Math.abs(recomputed - reported) > TOLERANCE * Math.max(1, Math.abs(reported))) {
        const pctDiff = reported !== 0 ? ((recomputed - reported) / Math.abs(reported)) * 100 : Infinity;
        const severity: Discrepancy["severity"] = Math.abs(pctDiff) > 5 ? "critical" : "warning";

        discrepancies.push({
          description: `Subtotal mismatch in "${table.sheetOrPage}": row "${rowHeaders[totalRow]}", col "${colHeaders[ci] || `col${ci}`}" — reported ${reported.toLocaleString()} but sum of components = ${recomputed.toLocaleString()} (${pctDiff > 0 ? "+" : ""}${round(pctDiff, 2)}%)`,
          severity,
          check_type: "subtotal_reconciliation",
          sources: [`${table.documentId}::${table.sheetOrPage}`],
          expected: recomputed,
          actual: reported,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Check 2: Sign consistency in cash-flow bridges
// Detect bridge tables; verify that the sum of all signed components
// matches the stated ending/net value.
// ---------------------------------------------------------------------------

function checkSignConsistency(
  table: ParsedTable,
  figures: Figure[],
  discrepancies: Discrepancy[]
): void {
  if (!isCashFlowSheet(table.caption, table.sheetOrPage)) return;

  const { rowHeaders, colHeaders } = table;

  // Find columns that look like year/period columns (numeric headers or "FY20xx")
  const periodCols: number[] = [];
  for (let ci = 1; ci < colHeaders.length; ci++) {
    const h = colHeaders[ci];
    if (/\d{4}|fy|cy|q\d|year|period/i.test(h)) periodCols.push(ci);
  }
  if (periodCols.length === 0) {
    // Fall back: use all numeric-header columns
    for (let ci = 1; ci < colHeaders.length; ci++) {
      if (!isNaN(Number(colHeaders[ci].replace(/[%,]/g, "")))) periodCols.push(ci);
    }
  }
  if (periodCols.length === 0) return;

  // For each period column, try to verify a bridge:
  // Look for a "starting" row, intermediate signed rows, and an "ending" row
  const startKeywords = /beginning|opening|start|initial|prior/i;
  const endKeywords = /ending|closing|end|final|net|total|result/i;

  for (const ci of periodCols) {
    // Find start and end rows
    let startRowIdx = -1;
    let endRowIdx = -1;

    for (let ri = 0; ri < rowHeaders.length; ri++) {
      const h = rowHeaders[ri];
      if (startKeywords.test(h) && startRowIdx === -1) startRowIdx = ri;
      if (endKeywords.test(h) && isSubtotalHeader(h)) endRowIdx = ri;
    }

    if (startRowIdx === -1 || endRowIdx === -1 || endRowIdx <= startRowIdx) continue;

    const startCell = table.grid.get(`${startRowIdx},${ci}`);
    const endCell = table.grid.get(`${endRowIdx},${ci}`);

    if (!startCell || !endCell || startCell.type !== "number" || endCell.type !== "number") continue;
    if (startCell.value === null || endCell.value === null) continue;

    // Sum all intermediate rows (excluding start and end total rows)
    let bridgeSum = startCell.value as number;
    for (let ri = startRowIdx + 1; ri < endRowIdx; ri++) {
      const cell = table.grid.get(`${ri},${ci}`);
      if (cell?.type === "number" && cell.value !== null && !isSubtotalHeader(rowHeaders[ri])) {
        bridgeSum += cell.value as number;
      }
    }

    const reported = round(endCell.value as number);
    const recomputed = round(bridgeSum);

    figures.push({
      name: `${table.sheetOrPage} bridge end — ${colHeaders[ci]}`,
      recomputed_value: recomputed,
      source_doc: table.documentId,
      source_cell: cellRef(table, endCell),
      formula: endCell.formula,
    });

    if (Math.abs(recomputed - reported) > TOLERANCE * Math.max(1, Math.abs(reported))) {
      // Determine if this looks like a sign error:
      // If -reported ≈ recomputed, that's a classic sign flip
      const signFlipMatch = Math.abs(-recomputed - reported) < TOLERANCE * Math.max(1, Math.abs(reported));
      const severity: Discrepancy["severity"] = "critical"; // any bridge error is critical

      discrepancies.push({
        description: `Cash-flow bridge sign/arithmetic error in "${table.sheetOrPage}" (${colHeaders[ci]}): bridge from "${rowHeaders[startRowIdx]}" to "${rowHeaders[endRowIdx]}" — reported ${reported.toLocaleString()}, recomputed ${recomputed.toLocaleString()}${signFlipMatch ? ". This matches a SIGN FLIP (one component has wrong sign)." : ""}`,
        severity,
        check_type: "sign_consistency",
        sources: [`${table.documentId}::${table.sheetOrPage}`],
        expected: recomputed,
        actual: reported,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Check 3: Monotonicity in sensitivity tables
// Sensitivity tables should trend monotonically as the input changes.
// ---------------------------------------------------------------------------

function checkMonotonicity(
  table: ParsedTable,
  discrepancies: Discrepancy[]
): void {
  const { rowHeaders, colHeaders } = table;

  // Check if this looks like a sensitivity table
  const hasSensKeyword =
    /sensitiv|scenario|case|stress|upside|downside|base|bull|bear/i.test(
      table.caption + " " + table.sheetOrPage
    );
  const numericColHeaders = isSensitivityHeader(colHeaders.slice(1));

  if (!hasSensKeyword && !numericColHeaders) return;

  // For each row, check if numeric values across columns are monotonically
  // increasing or decreasing (allowing ±1 violation for rounded values)
  for (let ri = 0; ri < rowHeaders.length; ri++) {
    if (isSubtotalHeader(rowHeaders[ri])) continue; // skip total rows

    const rowNums = table.cells
      .filter((c) => c.r === ri && c.type === "number" && c.value !== null && c.c >= 1)
      .sort((a, b) => a.c - b.c)
      .map((c) => c.value as number);

    if (rowNums.length < 3) continue;

    // Count monotonic violations
    let increases = 0;
    let decreases = 0;
    for (let i = 1; i < rowNums.length; i++) {
      if (rowNums[i] > rowNums[i - 1] + TOLERANCE) increases++;
      if (rowNums[i] < rowNums[i - 1] - TOLERANCE) decreases++;
    }

    const isMonotonic = increases === 0 || decreases === 0;

    // Non-monotonic: has both increases and decreases
    if (!isMonotonic) {
      // Find the violation index
      const violationIdx = rowNums.findIndex((v, i) =>
        i > 0 &&
        (increases > decreases
          ? v < rowNums[i - 1] - TOLERANCE
          : v > rowNums[i - 1] + TOLERANCE)
      );

      const violationColHeader = violationIdx >= 0
        ? (colHeaders[violationIdx + 1] ?? `col${violationIdx + 1}`)
        : "unknown";

      discrepancies.push({
        description: `Non-monotonic sensitivity table in "${table.sheetOrPage}", row "${rowHeaders[ri]}": values do not trend consistently (${increases > decreases ? "generally increasing" : "generally decreasing"} but reverses at "${violationColHeader}"). Values: [${rowNums.map((v) => round(v, 2)).join(", ")}]`,
        severity: "warning",
        check_type: "monotonicity",
        sources: [`${table.documentId}::${table.sheetOrPage}`],
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Check 4: Cross-document agreement
// Compare named figures (total revenue, EBITDA, etc.) across tables from
// different documents and flag disagreements.
// ---------------------------------------------------------------------------

function checkCrossDocAgreement(
  tables: ParsedTable[],
  figures: Figure[],
  discrepancies: Discrepancy[]
): void {
  // Build a map: normalizedFigureName+colLabel -> [{ doc, value, ref }]
  type FigureOccurrence = { doc: string; value: number; ref: string; tableCaption: string };
  const figureMap = new Map<string, FigureOccurrence[]>();

  const CROSS_DOC_KEYWORDS =
    /revenue|arr|mrr|ebitda|ebit|gross profit|net income|net revenue|total revenue|operating income|cash|recurring/i;

  for (const table of tables) {
    const { rowHeaders, colHeaders } = table;
    for (let ri = 0; ri < rowHeaders.length; ri++) {
      const rowLabel = rowHeaders[ri];
      if (!CROSS_DOC_KEYWORDS.test(rowLabel)) continue;

      for (let ci = 1; ci < colHeaders.length; ci++) {
        const cell = table.grid.get(`${ri},${ci}`);
        if (!cell || cell.type !== "number" || cell.value === null) continue;

        const key = `${normalizeLabel(rowLabel)}::${normalizeLabel(colHeaders[ci])}`;
        if (!figureMap.has(key)) figureMap.set(key, []);

        figureMap.get(key)!.push({
          doc: table.documentId,
          value: cell.value as number,
          ref: cellRef(table, cell),
          tableCaption: table.caption,
        });
      }
    }
  }

  // Check for disagreements — compare occurrences from different documents
  for (const [key, occurrences] of figureMap.entries()) {
    // Only check figures that appear in at least 2 different documents
    const byDoc = new Map<string, FigureOccurrence[]>();
    for (const occ of occurrences) {
      if (!byDoc.has(occ.doc)) byDoc.set(occ.doc, []);
      byDoc.get(occ.doc)!.push(occ);
    }

    if (byDoc.size < 2) continue;

    // Get representative value per document (use the first occurrence)
    const docValues: Array<{ doc: string; value: number; ref: string; caption: string }> = [];
    for (const [doc, occs] of byDoc.entries()) {
      docValues.push({ doc, value: occs[0].value, ref: occs[0].ref, caption: occs[0].tableCaption });
    }

    // Check if any pair differs by more than 0.5% (relative) or 1.0 (absolute for small numbers)
    const [a, b] = docValues;
    const absDiff = Math.abs(a.value - b.value);
    const relDiff = Math.max(Math.abs(a.value), Math.abs(b.value)) > 1
      ? absDiff / Math.max(Math.abs(a.value), Math.abs(b.value))
      : absDiff;

    if (relDiff > 0.005) {
      const parts = key.split("::");
      const figureName = parts[0] ?? key;
      const colLabel = parts[1] ?? "";

      figures.push({
        name: `${figureName} (${colLabel}) — cross-doc mismatch`,
        recomputed_value: a.value,
        source_doc: a.doc,
        source_cell: a.ref,
      });

      const severity: Discrepancy["severity"] = relDiff > 0.05 ? "critical" : "warning";

      discrepancies.push({
        description: `Cross-document figure mismatch for "${figureName}" (${colLabel}): doc "${a.caption}" = ${round(a.value, 2).toLocaleString()} vs doc "${b.caption}" = ${round(b.value, 2).toLocaleString()} (${round(relDiff * 100, 2)}% difference). Documents do not agree on this figure.`,
        severity,
        check_type: "cross_doc_agreement",
        sources: [a.ref, b.ref],
        expected: a.value,
        actual: b.value,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Main: run all checks across all tables
// ---------------------------------------------------------------------------

function runAllChecks(tables: ParsedTable[]): { figures: Figure[]; discrepancies: Discrepancy[] } {
  const figures: Figure[] = [];
  const discrepancies: Discrepancy[] = [];

  for (const table of tables) {
    checkSubtotalReconciliation(table, figures, discrepancies);
    checkSignConsistency(table, figures, discrepancies);
    checkMonotonicity(table, discrepancies);
  }

  checkCrossDocAgreement(tables, figures, discrepancies);

  return { figures, discrepancies };
}

// ---------------------------------------------------------------------------
// Parse raw DB rows into internal ParsedTable format
// ---------------------------------------------------------------------------

function parseTables(rows: z.infer<typeof DocTableSchema>[]): ParsedTable[] {
  const parsed: ParsedTable[] = [];

  for (const row of rows) {
    let data: z.infer<typeof TableDataSchema>;
    try {
      const raw = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
      data = TableDataSchema.parse(raw);
    } catch {
      continue; // skip malformed table
    }

    // Derive effective row headers: if stored row_headers are mostly empty/placeholder,
    // scan for the first string-type cell in each row to extract meaningful labels.
    let effectiveRowHeaders = data.row_headers;
    const meaningfulCount = data.row_headers.filter(
      (h) => h !== "" && h !== "x" && h.length > 1
    ).length;
    const rowCount = data.row_headers.length;

    if (rowCount > 0 && meaningfulCount / rowCount < 0.3) {
      // Row headers are mostly empty — derive from cell data
      effectiveRowHeaders = deriveRowLabelsFromCells(data.row_headers, data.cells, data.col_headers);
    }

    // Derive effective col headers: if stored col_headers are all generic "Col1", "Col2", etc.,
    // look for meaningful headers in the first row of string cells.
    let effectiveColHeaders = data.col_headers;
    const genericColCount = data.col_headers.filter((h) => /^Col\d+$/i.test(h)).length;
    if (data.col_headers.length > 0 && genericColCount / data.col_headers.length > 0.7) {
      effectiveColHeaders = deriveColLabelsFromCells(data.col_headers, data.cells);
    }

    const table: ParsedTable = {
      id: row.id,
      documentId: row.document_id,
      sheetOrPage: row.sheet_or_page,
      caption: row.caption ?? row.sheet_or_page,
      rowHeaders: effectiveRowHeaders,
      colHeaders: effectiveColHeaders,
      cells: data.cells,
      grid: new Map(),
    };
    buildGrid(table);
    parsed.push(table);
  }

  return parsed;
}

/**
 * Derive meaningful row labels from cell data when stored row_headers are empty.
 * Strategy: for each row index, find the first string-type cell (leftmost column)
 * that contains a meaningful label.
 */
function deriveRowLabelsFromCells(
  originalHeaders: string[],
  cells: Cell[],
  colHeaders: string[]
): string[] {
  const maxRow = originalHeaders.length;
  const derived: string[] = new Array(maxRow).fill("");

  // Group string cells by row, sorted by column
  const stringCellsByRow = new Map<number, Cell[]>();
  for (const cell of cells) {
    if (cell.r < maxRow && cell.type === "string" && cell.value != null && String(cell.value).trim() !== "") {
      if (!stringCellsByRow.has(cell.r)) stringCellsByRow.set(cell.r, []);
      stringCellsByRow.get(cell.r)!.push(cell);
    }
  }

  // Determine label column: the leftmost column index that has the most string cells across rows
  // This handles cases where row labels are in column 0, 1, or 2
  const colStringFreq = new Map<number, number>();
  for (const [, rowCells] of stringCellsByRow) {
    const sorted = rowCells.sort((a, b) => a.c - b.c);
    // Only consider the first 4 columns as potential label columns
    for (const cell of sorted.filter((c) => c.c < 4)) {
      colStringFreq.set(cell.c, (colStringFreq.get(cell.c) ?? 0) + 1);
    }
  }

  // Pick the column with the highest frequency of string values as the label column
  let labelCol = 0;
  let maxFreq = 0;
  for (const [col, freq] of colStringFreq) {
    if (freq > maxFreq) {
      maxFreq = freq;
      labelCol = col;
    }
  }

  // Extract labels from the identified column
  for (const cell of cells) {
    if (cell.c === labelCol && cell.r < maxRow && cell.type === "string" && cell.value != null) {
      const label = String(cell.value).trim();
      if (label && label !== "x") {
        derived[cell.r] = label;
      }
    }
  }

  // For rows that still have no label, fall back to original header
  for (let i = 0; i < maxRow; i++) {
    if (!derived[i] && originalHeaders[i] && originalHeaders[i] !== "" && originalHeaders[i] !== "x") {
      derived[i] = originalHeaders[i];
    }
  }

  return derived;
}

/**
 * Derive meaningful column labels when stored col_headers are generic (Col1, Col2, ...).
 * Looks for the first row (row 0) string cells that could be period headers (years, quarters).
 */
function deriveColLabelsFromCells(originalHeaders: string[], cells: Cell[]): string[] {
  const derived = [...originalHeaders];

  // Look at row 0 cells for potential column headers
  const row0Cells = cells.filter((c) => c.r === 0).sort((a, b) => a.c - b.c);

  for (const cell of row0Cells) {
    if (cell.c < derived.length && cell.value != null) {
      const val = String(cell.value).trim();
      if (val && val !== "x") {
        derived[cell.c] = val;
      }
    }
  }

  return derived;
}

/**
 * Deduplicate and rank discrepancies to produce a focused output.
 * Groups by (row_label extracted from description, check_type, sheet),
 * keeps the most severe per group, then caps total.
 */
function deduplicateAndRank(
  discrepancies: Discrepancy[],
  maxPerGroup: number,
  maxTotal: number
): Discrepancy[] {
  // Extract a grouping key from description — row label is typically in quotes
  function groupKey(d: Discrepancy): string {
    // Extract row label from description like: row "Total revenue per MA"
    const rowMatch = d.description.match(/row "([^"]+)"/);
    const sheetMatch = d.description.match(/in "([^"]+)"/);
    const row = rowMatch?.[1] ?? "unknown";
    const sheet = sheetMatch?.[1] ?? d.sources[0] ?? "unknown";
    return `${d.check_type}::${sheet}::${row}`;
  }

  // Severity ranking for sorting
  function severityRank(s: string): number {
    switch (s) {
      case "critical": return 0;
      case "warning": return 1;
      case "info": return 2;
      default: return 3;
    }
  }

  // Compute the absolute deviation magnitude for ranking within a group
  function deviation(d: Discrepancy): number {
    if (d.expected != null && d.actual != null) {
      const exp = typeof d.expected === "number" ? d.expected : parseFloat(String(d.expected));
      const act = typeof d.actual === "number" ? d.actual : parseFloat(String(d.actual));
      if (!isNaN(exp) && !isNaN(act) && Math.max(Math.abs(exp), Math.abs(act)) > 0) {
        return Math.abs(exp - act) / Math.max(Math.abs(exp), Math.abs(act));
      }
    }
    return 0;
  }

  // Group
  const groups = new Map<string, Discrepancy[]>();
  for (const d of discrepancies) {
    const key = groupKey(d);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(d);
  }

  // Within each group, sort by severity then deviation (largest first), keep top N
  const kept: Discrepancy[] = [];
  for (const [, group] of groups) {
    group.sort((a, b) => {
      const sevDiff = severityRank(a.severity) - severityRank(b.severity);
      if (sevDiff !== 0) return sevDiff;
      return deviation(b) - deviation(a);
    });
    kept.push(...group.slice(0, maxPerGroup));
  }

  // Sort all kept by severity then deviation, cap
  kept.sort((a, b) => {
    const sevDiff = severityRank(a.severity) - severityRank(b.severity);
    if (sevDiff !== 0) return sevDiff;
    return deviation(b) - deviation(a);
  });

  return kept.slice(0, maxTotal);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "NumericVerify",
  description: "Runs deterministic arithmetic verification on doc_tables for a deal run",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    moduleRunId: z.string().uuid(),
    documentIds: z.array(z.string()),
  }),

  output: z.object({
    numericReportId: z.string().nullable(),
    figureCount: z.number(),
    discrepancyCount: z.number(),
    criticalCount: z.number(),
    figures: z.array(FigureSchema),
    discrepancies: z.array(DiscrepancySchema),
  }),

  async run(ctx, { moduleRunId, documentIds }) {
    if (documentIds.length === 0) {
      return {
        numericReportId: null,
        figureCount: 0,
        discrepancyCount: 0,
        criticalCount: 0,
        figures: [],
        discrepancies: [],
      };
    }

    // Load doc_tables one row at a time to stay under the gRPC 4MB response limit.
    // First get the list of table IDs + data sizes, then fetch each individually
    // (skipping tables whose data exceeds 2.5 MB — those are customer-detail
    // sheets that can't fit in a single gRPC response).
    const MAX_DATA_BYTES = 2_500_000;

    const TableIdSchema = z.object({
      id: z.string(),
      document_id: z.string(),
      sheet_or_page: z.string(),
      caption: z.string().nullable(),
      data_length: z.number(),
    });

    const tableIndex: z.infer<typeof TableIdSchema>[] = [];
    for (const docId of documentIds) {
      const rows = await ctx.integrations.db.query(
        `SELECT id, document_id, sheet_or_page, caption,
                length(data::text) AS data_length
         FROM doc_tables
         WHERE document_id = $1::uuid
         ORDER BY sheet_or_page`,
        TableIdSchema,
        [docId],
        { label: `List doc_tables for document ${docId.slice(0, 8)}` }
      );
      tableIndex.push(...rows);
    }

    const loadable = tableIndex.filter((t) => t.data_length <= MAX_DATA_BYTES);
    const oversized = tableIndex.filter((t) => t.data_length > MAX_DATA_BYTES);

    if (oversized.length > 0) {
      ctx.log.info(
        `Skipping ${oversized.length} oversized table(s) for full analysis: ${oversized.map((t) => `${t.sheet_or_page} (${(t.data_length / 1_000_000).toFixed(1)}MB)`).join(", ")}`
      );
    }

    const allRawRows: z.infer<typeof DocTableSchema>[] = [];
    for (const meta of loadable) {
      const rows = await ctx.integrations.db.query(
        `SELECT id, document_id, sheet_or_page, caption, data
         FROM doc_tables
         WHERE id = $1::uuid`,
        DocTableSchema,
        [meta.id],
        { label: `Load table ${meta.sheet_or_page}` }
      );
      allRawRows.push(...rows);
    }

    // For oversized tables (e.g., large ARR-by-customer sheets), extract
    // summary-level rows (totals, subtotals) via JSONB so we still get
    // cross-doc agreement checks on key figures without loading full data.
    const SummaryCellSchema = z.object({
      row_idx: z.coerce.number(),
      row_label: z.string(),
      col_idx: z.coerce.number(),
      col_label: z.string(),
      cell_value: z.any(),
      cell_type: z.string(),
    });

    for (const meta of oversized) {
      // Extract row headers + total-row cells via JSONB
      const summaryRows = await ctx.integrations.db.query(
        `WITH tbl AS (
           SELECT data FROM doc_tables WHERE id = $1::uuid
         ),
         headers AS (
           SELECT ordinality - 1 AS idx, elem::text AS label
           FROM tbl, jsonb_array_elements_text(data->'row_headers') WITH ORDINALITY AS t(elem, ordinality)
         ),
         total_rows AS (
           SELECT idx, label FROM headers
           WHERE lower(label) ~ '(total|subtotal|sum|net|grand|ebitda|ebit|gross profit|revenue|arr|noi)'
         ),
         col_headers AS (
           SELECT ordinality - 1 AS idx, elem::text AS label
           FROM tbl, jsonb_array_elements_text(data->'col_headers') WITH ORDINALITY AS t(elem, ordinality)
         ),
         total_cells AS (
           SELECT
             tr.idx AS row_idx,
             tr.label AS row_label,
             ch.idx AS col_idx,
             ch.label AS col_label,
             cell->>'value' AS cell_value,
             cell->>'type' AS cell_type
           FROM tbl,
                total_rows tr,
                col_headers ch,
                jsonb_array_elements(data->'cells') AS cell
           WHERE (cell->>'r')::int = tr.idx
             AND (cell->>'c')::int = ch.idx
             AND cell->>'type' = 'number'
         )
         SELECT row_idx, row_label, col_idx, col_label, cell_value, cell_type
         FROM total_cells
         ORDER BY row_idx, col_idx
         LIMIT 500`,
        SummaryCellSchema,
        [meta.id],
        { label: `Extract summary rows from oversized table ${meta.sheet_or_page}` }
      );

      if (summaryRows.length === 0) continue;

      // Reconstruct a minimal table with just the summary rows
      const colHeadersResult = await ctx.integrations.db.query(
        `SELECT elem::text AS label
         FROM doc_tables, jsonb_array_elements_text(data->'col_headers') AS elem
         WHERE id = $1::uuid`,
        z.object({ label: z.string() }),
        [meta.id],
        { label: `Get col_headers for ${meta.sheet_or_page}` }
      );

      const uniqueRowIndices = [...new Set(summaryRows.map((r) => r.row_idx))].sort((a, b) => a - b);
      const rowIndexMap = new Map(uniqueRowIndices.map((oldIdx, newIdx) => [oldIdx, newIdx]));

      const miniCells: Cell[] = summaryRows.map((r) => ({
        r: rowIndexMap.get(r.row_idx) ?? 0,
        c: r.col_idx,
        value: r.cell_value != null ? Number(r.cell_value) : null,
        type: "number" as const,
      }));

      const miniRowHeaders = uniqueRowIndices.map(
        (idx) => summaryRows.find((r) => r.row_idx === idx)?.row_label ?? `row${idx}`
      );

      allRawRows.push({
        id: meta.id,
        document_id: meta.document_id,
        sheet_or_page: meta.sheet_or_page,
        caption: meta.caption,
        data: {
          row_headers: miniRowHeaders,
          col_headers: colHeadersResult.map((c) => c.label),
          cells: miniCells,
        },
      });
    }

    if (allRawRows.length === 0) {
      return {
        numericReportId: null,
        figureCount: 0,
        discrepancyCount: 0,
        criticalCount: 0,
        figures: [],
        discrepancies: [],
      };
    }

    // Parse into internal format and run all checks
    const tables = parseTables(allRawRows);
    const raw = runAllChecks(tables);

    // Deduplicate and cap findings to avoid overwhelming the LLM with noise.
    // Strategy:
    // 1. Group discrepancies by (row_label, check_type, sheet)
    // 2. Keep at most MAX_PER_GROUP per group (the most severe / largest deviation)
    // 3. Cap total output at MAX_DISCREPANCIES
    const MAX_PER_GROUP = 3; // max findings per (row_label, check_type, sheet)
    const MAX_DISCREPANCIES = 100; // total cap for LLM consumption
    const MAX_FIGURES = 200;

    const discrepancies = deduplicateAndRank(raw.discrepancies, MAX_PER_GROUP, MAX_DISCREPANCIES);
    const figures = raw.figures.slice(0, MAX_FIGURES);

    ctx.log.info(
      `NumericVerify: ${raw.figures.length} raw figures, ${raw.discrepancies.length} raw discrepancies → ` +
      `capped to ${figures.length} figures, ${discrepancies.length} discrepancies`
    );

    // Persist to numeric_reports
    const reportRows = await ctx.integrations.db.query(
      `INSERT INTO numeric_reports (module_run_id, figures, discrepancies)
       VALUES ($1, $2, $3)
       RETURNING id`,
      z.object({ id: z.string() }),
      [
        moduleRunId,
        JSON.stringify(figures),
        JSON.stringify(discrepancies),
      ],
      { label: "Save numeric_reports" }
    );

    const numericReportId = reportRows[0]?.id ?? null;
    const criticalCount = discrepancies.filter((d) => d.severity === "critical").length;

    return {
      numericReportId,
      figureCount: figures.length,
      discrepancyCount: discrepancies.length,
      criticalCount,
      figures,
      discrepancies,
    };
  },
});
