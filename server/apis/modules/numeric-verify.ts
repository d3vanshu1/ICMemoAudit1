import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Numeric tolerance
// ---------------------------------------------------------------------------
const REL_TOL = 0.005; // 0.5% relative tolerance
const ABS_TOL = 0.01;  // absolute tolerance for near-zero values

function approxEqual(a: number, b: number): boolean {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  const base = Math.max(Math.abs(a), Math.abs(b), ABS_TOL);
  return diff / base <= REL_TOL;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface StructuredCell {
  r: number;
  c: number;
  value: number | string | null;
  type: string;
  formula?: string;
}

interface TableData {
  row_headers: string[];
  col_headers: string[];
  cells: StructuredCell[];
}

interface DocTableRow {
  id: string;
  document_id: string;
  sheet_or_page: string;
  caption: string | null;
  data: TableData;
}

interface VerifiedFigure {
  name: string;
  recomputedValue: number;
  sourceDoc: string;
  sourceCell: string;
}

interface Discrepancy {
  description: string;
  severity: "critical" | "warning" | "info";
  sources: string[];
  recomputedValue?: number;
  declaredValue?: number;
  deltaPercent?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the numeric value of a cell at (r, c) from the cell array */
function cellNum(cells: StructuredCell[], r: number, c: number): number | null {
  const cell = cells.find((cell) => cell.r === r && cell.c === c);
  if (!cell || cell.type !== "number" || cell.value === null) return null;
  return typeof cell.value === "number" ? cell.value : null;
}

/** Get all numeric cells in a given row */
function rowNums(cells: StructuredCell[], r: number): Array<{ c: number; value: number }> {
  return cells
    .filter((cell) => cell.r === r && cell.type === "number" && typeof cell.value === "number")
    .map((cell) => ({ c: cell.c, value: cell.value as number }));
}

/** Get all numeric cells in a given column */
function colNums(cells: StructuredCell[], c: number): Array<{ r: number; value: number }> {
  return cells
    .filter((cell) => cell.c === c && cell.type === "number" && typeof cell.value === "number")
    .map((cell) => ({ r: cell.r, value: cell.value as number }));
}

/** Normalize a label for fuzzy matching */
function normalizeLabel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}

/** Check if a label contains any of the given terms */
function labelContains(label: string, terms: string[]): boolean {
  const n = normalizeLabel(label);
  return terms.some((t) => n.includes(t));
}

/** Parse a numeric string (handles $, commas, parentheses for negatives) */
function parseNumericString(s: string): number | null {
  if (!s || typeof s !== "string") return null;
  const cleaned = s.replace(/[$,\s]/g, "").replace(/^\((.+)\)$/, "-$1");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Check 1: Subtotal reconciliation
// Look for rows labeled "Total" and verify they equal the sum of rows above them
// ---------------------------------------------------------------------------
function checkSubtotals(
  table: DocTableRow,
  docLabel: string
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const { row_headers, col_headers, cells } = table.data;

  const TOTAL_TERMS = ["total", "subtotal", "sum", "grand total", "net total"];
  const EXCLUDE_TERMS = ["total revenue", "total ebitda", "total assets"]; // these are fine as named figures

  for (let ri = 0; ri < row_headers.length; ri++) {
    const label = row_headers[ri] ?? "";
    const normLabel = normalizeLabel(label);

    if (!TOTAL_TERMS.some((t) => normLabel === t || normLabel.startsWith(t + " ") || normLabel.endsWith(" " + t))) {
      continue;
    }

    // Skip rows that are clearly named KPI rows (they don't represent a sum of siblings)
    if (EXCLUDE_TERMS.some((t) => normalizeLabel(label).includes(t))) continue;

    // For each numeric column in this row, check if the value equals sum of rows above
    const thisRowNums = rowNums(cells, ri);
    if (thisRowNums.length === 0) continue;

    // Find the block of numeric rows above this total row
    // We look for the last group of consecutive numeric-heavy rows above
    let blockStart = ri - 1;
    while (blockStart >= 0) {
      const aboveLabel = normalizeLabel(row_headers[blockStart] ?? "");
      // Stop if we hit another total row or a section header
      if (TOTAL_TERMS.some((t) => aboveLabel === t || aboveLabel.startsWith(t + " "))) break;
      blockStart--;
    }
    blockStart = Math.max(0, blockStart + 1);

    // Only check if there are at least 2 rows in the block
    if (ri - blockStart < 2) continue;

    // Check each numeric column
    for (const { c, value: totalValue } of thisRowNums) {
      const colLabel = col_headers[c] ?? `Col${c}`;

      // Sum rows in block for this column
      let computedSum = 0;
      let numContributors = 0;
      for (let aboveRi = blockStart; aboveRi < ri; aboveRi++) {
        const v = cellNum(cells, aboveRi, c);
        if (v !== null) {
          computedSum += v;
          numContributors++;
        }
      }

      if (numContributors < 2) continue; // not enough data to validate

      if (!approxEqual(computedSum, totalValue)) {
        const delta = totalValue - computedSum;
        const deltaPercent = Math.abs(delta) / Math.max(Math.abs(computedSum), ABS_TOL) * 100;
        const severity: Discrepancy["severity"] = deltaPercent > 5 ? "critical" : "warning";

        discrepancies.push({
          description: `Subtotal mismatch in "${table.sheet_or_page}" / row "${label}" / col "${colLabel}": ` +
            `declared=${totalValue.toLocaleString("en-US", { maximumFractionDigits: 2 })}, ` +
            `recomputed=${computedSum.toLocaleString("en-US", { maximumFractionDigits: 2 })}, ` +
            `delta=${delta > 0 ? "+" : ""}${delta.toLocaleString("en-US", { maximumFractionDigits: 2 })} (${deltaPercent.toFixed(1)}%). ` +
            `Source document: ${docLabel}.`,
          severity,
          sources: [docLabel],
          recomputedValue: computedSum,
          declaredValue: totalValue,
          deltaPercent,
        });
      }
    }
  }

  return discrepancies;
}

// ---------------------------------------------------------------------------
// Check 2: Sign consistency in cash-flow bridges
// Finds bridge tables and checks that inflows are positive, outflows negative
// ---------------------------------------------------------------------------
function checkSignConsistency(
  table: DocTableRow,
  docLabel: string
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const { row_headers, col_headers, cells } = table.data;

  // Identify bridge tables by sheet name / caption
  const bridgeTerms = ["bridge", "cash flow", "waterfall", "reconciliation", "sources and uses", "ofcf", "fcf", "free cash"];
  const tableLabel = `${table.sheet_or_page} | ${table.caption ?? ""}`;
  if (!labelContains(tableLabel, bridgeTerms)) return discrepancies;

  // Categorize each row as inflow or outflow by label
  const INFLOW_TERMS = [
    "revenue", "ebitda", "operating", "proceeds", "beginning balance",
    "opening", "equity", "debt proceeds", "net income", "cash from",
    "inflow", "sources", "income",
  ];
  const OUTFLOW_TERMS = [
    "capex", "capital expenditure", "repayment", "debt repay", "distribution",
    "dividend", "payment", "outflow", "uses", "cost", "expense",
    "interest expense", "tax", "acquisition",
  ];

  for (let ri = 0; ri < row_headers.length; ri++) {
    const label = row_headers[ri] ?? "";
    const normLabel = normalizeLabel(label);

    const isInflow = INFLOW_TERMS.some((t) => normLabel.includes(t));
    const isOutflow = OUTFLOW_TERMS.some((t) => normLabel.includes(t));

    if (!isInflow && !isOutflow) continue;

    // Check numeric values in the row
    const nums = rowNums(cells, ri);
    if (nums.length === 0) continue;

    for (const { c, value } of nums) {
      const colLabel = col_headers[c] ?? `Col${c}`;

      // Skip zero or near-zero values
      if (Math.abs(value) < ABS_TOL) continue;

      if (isOutflow && value > 0 && !isInflow) {
        // Outflow items should be negative in a bridge
        discrepancies.push({
          description: `Sign error in "${table.sheet_or_page}" / row "${label}" / col "${colLabel}": ` +
            `outflow item has positive value ${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}. ` +
            `Expected negative. Recomputed correct sign: ${(-Math.abs(value)).toLocaleString("en-US", { maximumFractionDigits: 2 })}. ` +
            `Source: ${docLabel}.`,
          severity: "critical",
          sources: [docLabel],
          recomputedValue: -Math.abs(value),
          declaredValue: value,
        });
      }

      if (isInflow && value < 0 && !isOutflow) {
        // Inflow items should be positive in a bridge
        discrepancies.push({
          description: `Sign error in "${table.sheet_or_page}" / row "${label}" / col "${colLabel}": ` +
            `inflow item has negative value ${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}. ` +
            `Expected positive. Recomputed correct sign: ${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}. ` +
            `Source: ${docLabel}.`,
          severity: "critical",
          sources: [docLabel],
          recomputedValue: Math.abs(value),
          declaredValue: value,
        });
      }
    }
  }

  return discrepancies;
}

// ---------------------------------------------------------------------------
// Check 3: Monotonicity of sensitivity tables
// Finds sensitivity/scenario tables and checks monotonic ordering
// ---------------------------------------------------------------------------
function checkMonotonicity(
  table: DocTableRow,
  docLabel: string
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const { row_headers, col_headers, cells } = table.data;

  // Identify sensitivity tables by sheet name / caption
  const sensitivityTerms = ["sensitivity", "scenario", "stress", "downside", "base case", "upside"];
  const tableLabel = `${table.sheet_or_page} | ${table.caption ?? ""}`;
  if (!labelContains(tableLabel, sensitivityTerms)) return discrepancies;

  // Parse column headers to see if they're numeric (% or multiplier)
  const numericColHeaders = col_headers.map((h) => {
    if (!h) return null;
    const n = parseNumericString(h.replace(/%/g, ""));
    return n;
  });
  const hasNumericCols = numericColHeaders.some((n) => n !== null);
  if (!hasNumericCols) return discrepancies;

  // Find consecutive numeric column pairs and their order
  const numericColPairs: Array<{ ci: number; value: number }> = numericColHeaders
    .map((v, i) => v !== null ? { ci: i, value: v } : null)
    .filter((x): x is { ci: number; value: number } => x !== null);

  if (numericColPairs.length < 2) return discrepancies;

  const colsAscending = numericColPairs[numericColPairs.length - 1].value > numericColPairs[0].value;

  // For each output row (non-header), check if values trend with column headers
  for (let ri = 0; ri < row_headers.length; ri++) {
    const label = row_headers[ri] ?? "";
    const normLabel = normalizeLabel(label);

    // Skip label-only / header rows
    if (!label) continue;

    // Gather numeric values for this row in the numeric columns
    const rowValues: Array<{ ci: number; colVal: number; rowVal: number }> = [];
    for (const { ci, value: colVal } of numericColPairs) {
      const rv = cellNum(cells, ri, ci);
      if (rv !== null) rowValues.push({ ci, colVal, rowVal: rv });
    }

    if (rowValues.length < 2) continue;

    // Determine expected direction: higher stress scenario → lower return (or vice versa)
    // We heuristically detect: if col headers go up (more stress), do row values go down?
    // First, check if there's enough variation to test
    const firstVal = rowValues[0].rowVal;
    const lastVal = rowValues[rowValues.length - 1].rowVal;
    const range = Math.abs(lastVal - firstVal);
    if (range < ABS_TOL * 10) continue; // not enough variation to test monotonicity

    // Determine expected trend
    const expectedDecreasing = (colsAscending && lastVal < firstVal) ||
      (!colsAscending && lastVal > firstVal);

    // Check monotonicity
    let violations = 0;
    let lastRowVal = rowValues[0].rowVal;
    for (let i = 1; i < rowValues.length; i++) {
      const curr = rowValues[i].rowVal;
      const prev = lastRowVal;
      if (expectedDecreasing && curr > prev + range * 0.05) violations++;
      else if (!expectedDecreasing && curr < prev - range * 0.05) violations++;
      lastRowVal = curr;
    }

    if (violations > 0) {
      discrepancies.push({
        description: `Non-monotonic sensitivity in "${table.sheet_or_page}" / row "${label}": ` +
          `values do not trend consistently as scenario changes. ` +
          `Values: ${rowValues.map((v) => `col=${v.colVal}: ${v.rowVal.toLocaleString("en-US", { maximumFractionDigits: 2 })}`).join(", ")}. ` +
          `Expected ${expectedDecreasing ? "decreasing" : "increasing"} trend. ` +
          `Source: ${docLabel}.`,
        severity: "warning",
        sources: [docLabel],
      });
    }
  }

  return discrepancies;
}

// ---------------------------------------------------------------------------
// Check 4: Cross-document figure agreement
// Extracts named financial figures and flags discrepancies between docs
// ---------------------------------------------------------------------------
const KEY_METRIC_TERMS = [
  "revenue", "net revenue", "total revenue",
  "ebitda", "adjusted ebitda", "ebitda margin",
  "ebit", "net income", "net profit",
  "gross profit", "gross margin",
  "total assets", "total liabilities",
  "equity", "enterprise value", "equity value",
  "irr", "moic", "multiple",
  "growth rate", "cagr",
];

interface NamedFigure {
  metricName: string;
  value: number;
  docLabel: string;
  location: string;
}

function extractNamedFigures(table: DocTableRow, docLabel: string): NamedFigure[] {
  const figures: NamedFigure[] = [];
  const { row_headers, col_headers, cells } = table.data;

  for (let ri = 0; ri < row_headers.length; ri++) {
    const label = row_headers[ri] ?? "";
    const normLabel = normalizeLabel(label);

    for (const metricTerm of KEY_METRIC_TERMS) {
      if (!normLabel.includes(metricTerm)) continue;

      // Find numeric cells in this row — take the last column that looks like a projected/modeled figure
      const nums = rowNums(cells, ri);
      if (nums.length === 0) continue;

      // Prefer last numeric column (often the modeled/projected period)
      const lastNum = nums[nums.length - 1];
      const colLabel = col_headers[lastNum.c] ?? `Col${lastNum.c}`;

      figures.push({
        metricName: metricTerm,
        value: lastNum.value,
        docLabel,
        location: `${table.sheet_or_page} > row "${label}" > col "${colLabel}"`,
      });
    }
  }

  return figures;
}

function checkCrossDocAgreement(
  allFigures: NamedFigure[]
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  // Group by metric name
  const byMetric: Record<string, NamedFigure[]> = {};
  for (const fig of allFigures) {
    (byMetric[fig.metricName] ??= []).push(fig);
  }

  for (const [metric, figs] of Object.entries(byMetric)) {
    if (figs.length < 2) continue;

    // Compare every pair from different documents
    for (let i = 0; i < figs.length; i++) {
      for (let j = i + 1; j < figs.length; j++) {
        const a = figs[i];
        const b = figs[j];

        // Skip if same document
        if (a.docLabel === b.docLabel) continue;

        if (!approxEqual(a.value, b.value)) {
          const delta = Math.abs(a.value - b.value);
          const deltaPercent = delta / Math.max(Math.abs(a.value), Math.abs(b.value), ABS_TOL) * 100;
          const severity: Discrepancy["severity"] = deltaPercent > 10 ? "critical" : "warning";

          discrepancies.push({
            description: `Cross-document discrepancy for "${metric}": ` +
              `${a.docLabel} shows ${a.value.toLocaleString("en-US", { maximumFractionDigits: 2 })} ` +
              `(at ${a.location}) vs ` +
              `${b.docLabel} shows ${b.value.toLocaleString("en-US", { maximumFractionDigits: 2 })} ` +
              `(at ${b.location}). ` +
              `Delta: ${deltaPercent.toFixed(1)}%.`,
            severity,
            sources: [a.docLabel, b.docLabel],
            recomputedValue: a.value,
            declaredValue: b.value,
            deltaPercent,
          });
        }
      }
    }
  }

  return discrepancies;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------
export default api({
  name: "NumericVerify",
  description: "Pure arithmetic verification of financial figures across doc_tables; stores results to numeric_reports",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    moduleRunId: z.string().uuid(),
    documentIds: z.array(z.string()),
    dealName: z.string().nullable().optional(),
  }),

  output: z.object({
    figureCount: z.number(),
    discrepancyCount: z.number(),
    criticalCount: z.number(),
    numericReportId: z.string(),
    summary: z.string(),
  }),

  async run(ctx, { moduleRunId, documentIds, dealName }) {
    if (documentIds.length === 0) {
      return {
        figureCount: 0,
        discrepancyCount: 0,
        criticalCount: 0,
        numericReportId: "",
        summary: "No documents provided.",
      };
    }

    // Load structured tables
    const DocTableRowSchema = z.object({
      id: z.string(),
      document_id: z.string(),
      sheet_or_page: z.string(),
      caption: z.string().nullable(),
      data: z.any(),
    });

    const rows = await ctx.integrations.db.query(
      `SELECT id, document_id, sheet_or_page, caption, data
       FROM doc_tables
       WHERE document_id = ANY($1::uuid[])
       ORDER BY document_id, sheet_or_page`,
      DocTableRowSchema,
      [documentIds],
      { label: "Load doc_tables for numeric verification" }
    );

    if (rows.length === 0) {
      return {
        figureCount: 0,
        discrepancyCount: 0,
        criticalCount: 0,
        numericReportId: "",
        summary: "No structured tables found. Upload Excel/CSV files and save doc tables first.",
      };
    }

    // Process each table
    const allDiscrepancies: Discrepancy[] = [];
    const allFigures: VerifiedFigure[] = [];
    const allNamedFigures: NamedFigure[] = [];

    // Build document label map (document_id → label)
    // We use document_id as label since we don't have names here
    const docLabels: Record<string, string> = {};
    for (const row of rows) {
      docLabels[row.document_id] = `doc:${(row.document_id as string).slice(0, 8)}`;
    }

    for (const rawRow of rows) {
      const row: DocTableRow = {
        id: rawRow.id as string,
        document_id: rawRow.document_id as string,
        sheet_or_page: rawRow.sheet_or_page as string,
        caption: rawRow.caption as string | null,
        data: rawRow.data as TableData,
      };

      const docLabel = docLabels[row.document_id];

      // Guard: data must have the right shape
      if (!row.data || !Array.isArray(row.data.cells)) continue;
      if (!Array.isArray(row.data.row_headers)) row.data.row_headers = [];
      if (!Array.isArray(row.data.col_headers)) row.data.col_headers = [];

      // Run all checks
      const subtotalIssues = checkSubtotals(row, docLabel);
      const signIssues = checkSignConsistency(row, docLabel);
      const monoIssues = checkMonotonicity(row, docLabel);
      allDiscrepancies.push(...subtotalIssues, ...signIssues, ...monoIssues);

      // Extract named figures for cross-doc check
      const namedFigs = extractNamedFigures(row, docLabel);
      allNamedFigures.push(...namedFigs);

      // Add to verified figures list
      for (const fig of namedFigs) {
        allFigures.push({
          name: fig.metricName,
          recomputedValue: fig.value,
          sourceDoc: fig.docLabel,
          sourceCell: fig.location,
        });
      }
    }

    // Cross-doc agreement check
    const crossDocIssues = checkCrossDocAgreement(allNamedFigures);
    allDiscrepancies.push(...crossDocIssues);

    const criticalCount = allDiscrepancies.filter((d) => d.severity === "critical").length;

    // Build summary
    const summary =
      `Verified ${rows.length} table(s) across ${Object.keys(docLabels).length} document(s). ` +
      `Found ${allFigures.length} named figure(s), ${allDiscrepancies.length} discrepanc${allDiscrepancies.length === 1 ? "y" : "ies"} ` +
      `(${criticalCount} critical). ` +
      (allDiscrepancies.length > 0
        ? `Top issue: ${allDiscrepancies[0].description.slice(0, 120)}...`
        : "No discrepancies detected.");

    // Persist to numeric_reports
    await ctx.integrations.db.execute(
      `INSERT INTO numeric_reports (module_run_id, figures, discrepancies)
       VALUES ($1, $2, $3)`,
      [moduleRunId, JSON.stringify(allFigures), JSON.stringify(allDiscrepancies)],
      { label: "Save numeric verification report" }
    );

    // Get the ID of the inserted row
    const inserted = await ctx.integrations.db.query(
      `SELECT id FROM numeric_reports WHERE module_run_id = $1 ORDER BY created_at DESC LIMIT 1`,
      z.object({ id: z.string() }),
      [moduleRunId],
      { label: "Get numeric_report ID" }
    );

    const numericReportId = inserted[0]?.id ?? "";

    return {
      figureCount: allFigures.length,
      discrepancyCount: allDiscrepancies.length,
      criticalCount,
      numericReportId,
      summary,
    };
  },
});
