/**
 * Inline Numeric Verification — server-side callable function.
 *
 * REWRITTEN 2026-07-27: Replaced subtotal/sign/monotonicity heuristics
 * (which produced 84 false-positive "critical" discrepancies on the SCG model)
 * with a two-layer architecture:
 *
 *   Layer 1 — METRIC FIGURES: Read cell values at known {label, period} addresses.
 *             The label→address mapping is deal-layer config, not engine logic.
 *             Produces trustworthy values for the merge prompt to compare against narrative.
 *
 *   Layer 2 — CROSS-AGREEMENT: The ONLY discrepancy emitter. Matches {label, period}
 *             across two source sheets, flags divergence > max(£1k, 0.01%), rolls up
 *             by period. Frames findings as "confirm intentional vs stale/contradiction."
 *
 * Design constraints:
 *   - Engine core has NO column/keyword/sheet-name assumptions — those live in deal config.
 *   - Cross-agreement matching rule and source sheets are deal-specific config.
 *   - SheetJS formula population is no longer load-bearing; values only.
 *   - Within-sheet subtotal discrepancies = 0 (by design: nothing emits them).
 */
import { z } from "@superblocksteam/sdk-api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NumericVerifyResult {
  figures: Figure[];
  discrepancies: Discrepancy[];
  partial: boolean;
  documentsProcessed: number;
  documentsTotal: number;
  tablesLoaded: number;
  tablesTotal: number;
}

export interface Figure {
  name: string;
  period: string;
  value: number;
  source_doc: string;
  source_cell: string;
  source_sheet: string;
}

export interface Discrepancy {
  description: string;
  severity: "critical" | "warning" | "info";
  check_type: "cross_doc_agreement";
  sources: string[];
  period: string;
  metrics: Array<{ label: string; sourceA: number; sourceB: number; absDiff: number; relDiffPct: number }>;
}

/**
 * Deal-layer config for cross-agreement checks.
 * Identifies which sheets to compare and how to match metrics.
 */
export interface CrossAgreementConfig {
  /** Source A: sheet identifier (sheet_or_page match string) */
  sourceASheet: string;
  /** Source B: sheet identifier (sheet_or_page match string) */
  sourceBSheet: string;
  /** Source A: document_id pin. When set, only tables from this document match source A. */
  sourceADocId?: string;
  /** Source B: document_id pin. When set, only tables from this document match source B. */
  sourceBDocId?: string;
  /** Matching rule: "exact" = exact string match on row labels; future: "semantic" */
  matchingRule: "exact";
  /** Optional: restrict to these row labels. If empty/null, all shared labels are compared. */
  restrictLabels?: string[];
  /**
   * Optional: restrict cross-agreement to rows whose labels match the metric config patterns.
   * When set, only entries with labels matching these regex/exact patterns are compared.
   * Prevents detail-level line items from producing noise in FY periods that should be "clean."
   */
  metricFilter?: MetricConfig;
  /** Divergence threshold: absolute minimum difference to flag (e.g., 1000 for £1k) */
  absThreshold: number;
  /** Divergence threshold: relative (e.g., 0.0001 for 0.01%) */
  relThreshold: number;
  /**
   * Max magnitude ratio: exclude comparisons where one value is >N× the other.
   * Prevents false positives from partial-year (YTD) vs full-year column mismatches.
   * Example: maxRatio=5 excludes D&A -4.8M vs -59.9M (ratio 12.4×).
   * If not set, no ratio guard is applied.
   */
  maxRatio?: number;
}

/**
 * Deal-layer config: which metrics to read as verified figures.
 * If empty, the engine falls back to reading all rows matching METRIC_KEYWORDS
 * in the configured source sheets.
 */
export interface MetricConfig {
  /** Label patterns to match (exact or regex) */
  labelPatterns: string[];
  /** If true, patterns are case-insensitive regex; if false, exact string match */
  isRegex: boolean;
}

type Cell = {
  r: number;
  c: number;
  value: number | string | null;
  type: "number" | "string" | "date" | "boolean" | "empty";
};

interface ParsedTable {
  id: string;
  documentId: string;
  sheetOrPage: string;
  caption: string;
  rowHeaders: string[];
  colHeaders: string[];
  cells: Cell[];
  grid: Map<string, Cell>;
}

/** Minimal DB interface matching PipelineContext.integrations.db */
interface DbClient {
  query: (sql: string, schema: z.ZodType<any>, params: unknown[], meta?: { label: string }) => Promise<any[]>;
}

// ---------------------------------------------------------------------------
// Schemas (for DB queries)
// ---------------------------------------------------------------------------

const TableIndexSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  sheet_or_page: z.string(),
  caption: z.string().nullable(),
  data_length: z.number(),
});

const DocTableDataSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  sheet_or_page: z.string(),
  caption: z.string().nullable(),
  data: z.any(),
});

// ---------------------------------------------------------------------------
// Config: SCG deal-specific (hardcoded for now; future: DB-stored per deal)
// ---------------------------------------------------------------------------

/**
 * SCG cross-agreement config.
 * Compares "FS Summary" (live updated) vs "FS Summary (hardcoded)" (frozen reference).
 * Both sheets live in document a0172256 (the updated model with 22 sheets).
 * Document pinning prevents the original/pre-update model (321b6185) from being
 * selected — that model's FS Summary is identical to the hardcoded snapshot,
 * producing 0 divergences (false negative).
 */

/**
 * SCG metric config: which row labels constitute "metrics" for figure reading.
 * Covers the standard P&L/BS/CF hierarchy. If a row label matches any pattern,
 * its values across all period columns are emitted as verified figures.
 */
const SCG_METRIC_CONFIG: MetricConfig = {
  isRegex: true,
  labelPatterns: [
    "^Total\\s+(direct\\s+costs|overheads|revenue)",
    "^(Revenue|EBITDA|EBIT|Gross\\s+Profit|Net\\s+Income|Operating\\s+Profit)",
    "^(Adjusted|Adj\\.?|Normalised|Underlying|Reported)\\s+(EBITDA|EBIT|Revenue)",
    "^(ARR|MRR|Net\\s+Revenue|Recurring\\s+Revenue)",
    "^Surgery\\s+Intellect\\s+GP",
  ],
};

const SCG_CROSS_AGREEMENT: CrossAgreementConfig = {
  sourceASheet: "FS Summary",
  sourceBSheet: "FS Summary (hardcoded)",
  sourceADocId: "a0172256-4ab0-412b-a247-f70b16136b28",
  sourceBDocId: "a0172256-4ab0-412b-a247-f70b16136b28",
  matchingRule: "exact",
  absThreshold: 1_000, // £1k absolute minimum
  relThreshold: 0.0001, // 0.01% relative
  // maxRatio removed: doc-pinning + base-year matching now eliminate the YTD-vs-full-year
  // column mismatches that maxRatio was originally designed to catch. Legitimate large
  // proportional changes (e.g. Total adjustments −210k→−2.7M) should not be filtered.
};

// Period column detection: matches FY year columns and standard period labels
const PERIOD_COL_PATTERN = /\b(20\d{2}|fy\s*\d{2,4}|cy\s*\d{2,4}|q[1-4]|h[12]|ytd|ltm)\b|^(actual|forecast|budget|plan)$/i;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_DATA_BYTES = 2_500_000;
const MAX_FIGURES = 500;
const MAX_DISCREPANCIES = 50;

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function buildGrid(table: ParsedTable): void {
  for (const cell of table.cells) {
    table.grid.set(`${cell.r},${cell.c}`, cell);
  }
}

function cellRef(table: ParsedTable, rowIdx: number, colIdx: number): string {
  const row = table.rowHeaders[rowIdx] ?? `row${rowIdx}`;
  const col = table.colHeaders[colIdx] ?? `col${colIdx}`;
  return `[${table.sheetOrPage}] ${row} / ${col}`;
}

function isPeriodCol(label: string): boolean {
  return PERIOD_COL_PATTERN.test(label.trim());
}

function normalizePeriod(label: string): string {
  // Extract period identifier preserving actual/forecast qualifier for display and
  // intra-sheet dedup (so "2026 Actual" ≠ "2026 Forecast" within one sheet).
  const cleaned = label.trim().toLowerCase();
  const yearMatch = cleaned.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    const year = yearMatch[1];
    const qualifierMatch = cleaned.match(/\b(actual|forecast|budget|plan)\b/);
    if (qualifierMatch) return `${year} ${qualifierMatch[1]}`;
    return year;
  }
  return cleaned;
}

/**
 * Strip qualifier from a normalized period to get the base year for cross-sheet matching.
 * "2026 actual" → "2026", "2026 forecast" → "2026", "2026" → "2026"
 * This allows comparing live-model "actual" columns against hardcoded-model "forecast"
 * columns (same business concept, different time-based qualifiers).
 */
function periodBaseYear(period: string): string {
  const yearMatch = period.match(/^(20\d{2})/);
  return yearMatch ? yearMatch[1] : period;
}

function matchesMetricConfig(rowLabel: string, config: MetricConfig): boolean {
  if (!rowLabel || rowLabel.trim() === "" || rowLabel === "x") return false;
  for (const pattern of config.labelPatterns) {
    if (config.isRegex) {
      if (new RegExp(pattern, "i").test(rowLabel)) return true;
    } else {
      if (rowLabel.trim().toLowerCase() === pattern.toLowerCase()) return true;
    }
  }
  return false;
}

function matchesCrossSheet(sheetOrPage: string, configSheet: string): boolean {
  // For "FS Summary" vs "FS Summary (hardcoded)":
  // "FS Summary" matches "FS Summary" but NOT "FS Summary (hardcoded)"
  // Exact match on the full sheet name
  return sheetOrPage.trim().toLowerCase() === configSheet.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Layer 1: Metric Figures — read cell values at known metric labels
// ---------------------------------------------------------------------------

function extractMetricFigures(
  table: ParsedTable,
  metricConfig: MetricConfig
): Figure[] {
  const figures: Figure[] = [];
  const { rowHeaders, colHeaders } = table;

  // Identify period columns
  const periodCols: Array<{ colIdx: number; period: string }> = [];
  for (let ci = 0; ci < colHeaders.length; ci++) {
    if (isPeriodCol(colHeaders[ci])) {
      periodCols.push({ colIdx: ci, period: normalizePeriod(colHeaders[ci]) });
    }
  }
  if (periodCols.length === 0) return figures;

  // Find metric rows
  for (let ri = 0; ri < rowHeaders.length; ri++) {
    const label = rowHeaders[ri];
    if (!matchesMetricConfig(label, metricConfig)) continue;

    for (const { colIdx, period } of periodCols) {
      const cell = table.grid.get(`${ri},${colIdx}`);
      if (!cell || cell.type !== "number" || cell.value === null) continue;

      figures.push({
        name: label.trim(),
        period,
        value: cell.value as number,
        source_doc: table.documentId,
        source_cell: cellRef(table, ri, colIdx),
        source_sheet: table.sheetOrPage,
      });
    }
  }

  return figures;
}

// ---------------------------------------------------------------------------
// Layer 2: Cross-Agreement — the ONLY discrepancy emitter
// ---------------------------------------------------------------------------

interface CrossAgreementEntry {
  label: string;
  period: string;
  value: number;
  sourceRef: string;
}

function runCrossAgreement(
  tables: ParsedTable[],
  config: CrossAgreementConfig
): { discrepancies: Discrepancy[]; figures: Figure[] } {
  const discrepancies: Discrepancy[] = [];
  const figures: Figure[] = [];

  // Find tables matching source A and source B (document-pinned when configured)
  const sourceATables = tables.filter((t) =>
    matchesCrossSheet(t.sheetOrPage, config.sourceASheet) &&
    (!config.sourceADocId || t.documentId === config.sourceADocId)
  );
  const sourceBTables = tables.filter((t) =>
    matchesCrossSheet(t.sheetOrPage, config.sourceBSheet) &&
    (!config.sourceBDocId || t.documentId === config.sourceBDocId)
  );

  if (sourceATables.length === 0 || sourceBTables.length === 0) {
    console.log(`[NumericInline:CrossAgreement] Source not found: A="${config.sourceASheet}"${config.sourceADocId ? ` doc=${config.sourceADocId.slice(0,8)}` : ""} (${sourceATables.length}), B="${config.sourceBSheet}"${config.sourceBDocId ? ` doc=${config.sourceBDocId.slice(0,8)}` : ""} (${sourceBTables.length})`);
    return { discrepancies, figures };
  }

  // Fail loud if multiple tables match a source spec — never silently take [0]
  if (sourceATables.length > 1) {
    console.warn(
      `[NumericInline:CrossAgreement] AMBIGUOUS source A: ${sourceATables.length} tables match "${config.sourceASheet}"` +
      `${config.sourceADocId ? ` in doc ${config.sourceADocId.slice(0,8)}` : ""}. ` +
      `Documents: [${sourceATables.map(t => t.documentId.slice(0,8)).join(", ")}]. Skipping cross-agreement.`
    );
    return { discrepancies, figures };
  }
  if (sourceBTables.length > 1) {
    console.warn(
      `[NumericInline:CrossAgreement] AMBIGUOUS source B: ${sourceBTables.length} tables match "${config.sourceBSheet}"` +
      `${config.sourceBDocId ? ` in doc ${config.sourceBDocId.slice(0,8)}` : ""}. ` +
      `Documents: [${sourceBTables.map(t => t.documentId.slice(0,8)).join(", ")}]. Skipping cross-agreement.`
    );
    return { discrepancies, figures };
  }

  const tableA = sourceATables[0];
  const tableB = sourceBTables[0];

  // Extract all numeric entries from both sheets
  const entriesA = extractAllNumericEntries(tableA);
  const entriesB = extractAllNumericEntries(tableB);

  // Build lookup maps: key = "normalizedLabel::baseYear"
  // Cross-agreement uses BASE YEAR (no qualifier) so that live-model "actual" columns
  // match hardcoded-model "forecast" columns for the same fiscal year.
  // First-occurrence-wins per base-year avoids both:
  //   (a) downstream rows with same label shadowing structural rows
  //   (b) forecast columns shadowing actual columns within one sheet (actual comes first)
  const mapA = new Map<string, CrossAgreementEntry>();
  for (const e of entriesA) {
    const key = `${e.label.trim().toLowerCase()}::${periodBaseYear(e.period)}`;
    if (!mapA.has(key)) mapA.set(key, e);
  }

  const mapB = new Map<string, CrossAgreementEntry>();
  for (const e of entriesB) {
    const key = `${e.label.trim().toLowerCase()}::${periodBaseYear(e.period)}`;
    if (!mapB.has(key)) mapB.set(key, e);
  }

  // Compare: find keys present in both maps with divergence > threshold
  // Group divergences by period for rolled-up reporting
  const divergencesByPeriod = new Map<string, Array<{
    label: string;
    valueA: number;
    valueB: number;
    absDiff: number;
    relDiffPct: number;
    refA: string;
    refB: string;
  }>>();

  for (const [key, entryA] of mapA) {
    const entryB = mapB.get(key);
    if (!entryB) continue;

    // Restrict labels if configured
    if (config.restrictLabels && config.restrictLabels.length > 0) {
      const labelMatch = config.restrictLabels.some(
        (l) => l.toLowerCase() === entryA.label.trim().toLowerCase()
      );
      if (!labelMatch) continue;
    }

    // Metric filter: only compare labels matching the metric config patterns
    if (config.metricFilter) {
      const label = entryA.label.trim();
      const matches = config.metricFilter.labelPatterns.some((pattern) => {
        if (config.metricFilter!.isRegex) {
          return new RegExp(pattern, "i").test(label);
        }
        return label.toLowerCase() === pattern.toLowerCase();
      });
      if (!matches) continue;
    }

    const absDiff = Math.abs(entryA.value - entryB.value);
    const maxAbs = Math.max(Math.abs(entryA.value), Math.abs(entryB.value));
    const minAbs = Math.min(Math.abs(entryA.value), Math.abs(entryB.value));
    const relDiff = maxAbs > 0 ? absDiff / maxAbs : 0;

    // Magnitude ratio guard: exclude comparisons where one value is >maxRatio× the other.
    // This catches partial-year (YTD) vs full-year column mismatches where, e.g.,
    // D&A "actual" = £4.8M (1 month) vs D&A "forecast" = £59.9M (full year).
    if (config.maxRatio && minAbs > 0 && maxAbs / minAbs > config.maxRatio) {
      continue;
    }
    // Also skip when one side is 0 and the other exceeds absThreshold × maxRatio
    // (handles rows where YTD = 0 vs forecast = large number)
    if (config.maxRatio && minAbs === 0 && maxAbs > config.absThreshold * config.maxRatio) {
      continue;
    }

    // Apply threshold: divergence must exceed BOTH abs AND rel thresholds
    // (i.e., flag only when the difference is meaningful in both absolute and relative terms)
    if (absDiff > config.absThreshold && relDiff > config.relThreshold) {
      const period = periodBaseYear(entryA.period);
      if (!divergencesByPeriod.has(period)) divergencesByPeriod.set(period, []);
      divergencesByPeriod.get(period)!.push({
        label: entryA.label,
        valueA: entryA.value,
        valueB: entryB.value,
        absDiff,
        relDiffPct: relDiff * 100,
        refA: entryA.sourceRef,
        refB: entryB.sourceRef,
      });
    }

    // Emit verified figures from source A (live model = authoritative)
    figures.push({
      name: entryA.label,
      period: entryA.period,
      value: entryA.value,
      source_doc: tableA.documentId,
      source_cell: entryA.sourceRef,
      source_sheet: tableA.sheetOrPage,
    });
  }

  // Roll up: one discrepancy per period containing the metric cluster
  for (const [period, divergences] of divergencesByPeriod) {
    if (divergences.length === 0) continue;

    // Sort by absolute difference descending
    divergences.sort((a, b) => b.absDiff - a.absDiff);

    const metricSummary = divergences
      .slice(0, 20) // cap for readability
      .map((d) => `${d.label}: ${d.valueA.toLocaleString()} (${config.sourceASheet}) vs ${d.valueB.toLocaleString()} (${config.sourceBSheet}) — Δ${d.relDiffPct.toFixed(2)}%`)
      .join("\n  ");

    const severity: Discrepancy["severity"] = divergences.some((d) => d.relDiffPct > 5) ? "critical" : "warning";

    discrepancies.push({
      description: `Cross-version divergence in period "${period}" — ${divergences.length} metric(s) differ between "${config.sourceASheet}" and "${config.sourceBSheet}". Confirm whether these reflect intentional updates (live model revision) or stale/contradictory references:\n  ${metricSummary}`,
      severity,
      check_type: "cross_doc_agreement",
      sources: [
        `${tableA.documentId}::${tableA.sheetOrPage}`,
        `${tableB.documentId}::${tableB.sheetOrPage}`,
      ],
      period,
      metrics: divergences.map((d) => ({
        label: d.label,
        sourceA: d.valueA,
        sourceB: d.valueB,
        absDiff: d.absDiff,
        relDiffPct: d.relDiffPct,
      })),
    });
  }

  return { discrepancies, figures };
}

function extractAllNumericEntries(table: ParsedTable): CrossAgreementEntry[] {
  const entries: CrossAgreementEntry[] = [];
  const { rowHeaders, colHeaders } = table;

  // Identify period columns
  const periodCols: Array<{ colIdx: number; period: string }> = [];
  for (let ci = 0; ci < colHeaders.length; ci++) {
    if (isPeriodCol(colHeaders[ci])) {
      periodCols.push({ colIdx: ci, period: normalizePeriod(colHeaders[ci]) });
    }
  }

  for (let ri = 0; ri < rowHeaders.length; ri++) {
    const label = rowHeaders[ri];
    if (!label || label.trim() === "" || label === "x") continue;

    for (const { colIdx, period } of periodCols) {
      const cell = table.grid.get(`${ri},${colIdx}`);
      if (!cell || cell.type !== "number" || cell.value === null) continue;

      entries.push({
        label: label.trim(),
        period,
        value: cell.value as number,
        sourceRef: cellRef(table, ri, colIdx),
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Table parsing (raw DB rows → internal ParsedTable)
// ---------------------------------------------------------------------------

function parseTables(rows: Array<{ id: string; document_id: string; sheet_or_page: string; caption: string | null; data: any }>): ParsedTable[] {
  const parsed: ParsedTable[] = [];

  for (const row of rows) {
    let data: { row_headers: string[]; col_headers: string[]; cells: Cell[] };
    try {
      const raw = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
      if (!raw || !Array.isArray(raw.row_headers) || !Array.isArray(raw.col_headers) || !Array.isArray(raw.cells)) continue;
      data = raw;
    } catch {
      continue;
    }

    let effectiveRowHeaders = data.row_headers;
    const meaningfulCount = data.row_headers.filter(
      (h) => h !== "" && h !== "x" && h.length > 1
    ).length;
    const rowCount = data.row_headers.length;

    if (rowCount > 0 && meaningfulCount / rowCount < 0.3) {
      effectiveRowHeaders = deriveRowLabelsFromCells(data.row_headers, data.cells);
    }

    let effectiveColHeaders = data.col_headers;
    const genericColCount = data.col_headers.filter((h) => /^Col\d+$/i.test(h)).length;
    if (data.col_headers.length > 0 && genericColCount / data.col_headers.length > 0.7) {
      effectiveColHeaders = deriveColLabelsFromCells(data.col_headers, data.cells);
    }

    // Year enrichment: always merge numeric year values from row 0 into col headers.
    // This handles the common SheetJS pattern where period years live in row 0 as
    // numeric cell values (e.g., 2023, 2024, 2025, 2026) while col_headers only
    // contain generic qualifiers ("Actual"/"Forecast") or "Col%d" labels.
    effectiveColHeaders = enrichColHeadersWithYears(effectiveColHeaders, data.cells);

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

function deriveRowLabelsFromCells(originalHeaders: string[], cells: Cell[]): string[] {
  const maxRow = originalHeaders.length;
  const derived: string[] = new Array(maxRow).fill("");

  // Count string frequency per column (first 6 columns) to rank label candidates
  const colStringFreq = new Map<number, number>();
  for (const cell of cells) {
    if (cell.r < maxRow && cell.type === "string" && cell.value != null && String(cell.value).trim() !== "" && cell.c < 6) {
      colStringFreq.set(cell.c, (colStringFreq.get(cell.c) ?? 0) + 1);
    }
  }

  // Sort columns by frequency (descending) — most-populated column is primary label source.
  // This handles multi-level indent structures (e.g., col 3 = sub-items, col 2 = totals).
  const labelCols = [...colStringFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([col]) => col);

  // Build a quick lookup: row → cell value per column (first 6 cols)
  const cellsByRowCol = new Map<string, string>();
  for (const cell of cells) {
    if (cell.r < maxRow && cell.type === "string" && cell.value != null && cell.c < 6) {
      const val = String(cell.value).trim();
      if (val && val !== "x") {
        cellsByRowCol.set(`${cell.r},${cell.c}`, val);
      }
    }
  }

  // Fill derived labels: iterate columns in frequency order.
  // For each row still unlabeled, take the value from the current column.
  for (const col of labelCols) {
    for (let ri = 0; ri < maxRow; ri++) {
      if (derived[ri]) continue; // already labeled from a higher-frequency column
      const val = cellsByRowCol.get(`${ri},${col}`);
      if (val) {
        derived[ri] = val;
      }
    }
  }

  // Final fallback: original row_headers
  for (let i = 0; i < maxRow; i++) {
    if (!derived[i] && originalHeaders[i] && originalHeaders[i] !== "" && originalHeaders[i] !== "x") {
      derived[i] = originalHeaders[i];
    }
  }

  return derived;
}

function deriveColLabelsFromCells(originalHeaders: string[], cells: Cell[]): string[] {
  const derived = [...originalHeaders];
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
 * Enrich column headers with year info from row 0 numeric cells.
 *
 * SheetJS often extracts multi-row headers as: col_headers = ["Actual", "Forecast", ...]
 * with the year sitting in row 0 as a numeric value (2023, 2024, etc.). Without this
 * enrichment, all "Actual" columns normalize to the same period and first-occurrence-wins
 * collapses them into one — making cross-agreement impossible for year-specific comparisons.
 *
 * Logic:
 * - For each column, if the current header doesn't already contain a 4-digit year
 *   AND row 0 at that column has a numeric value that looks like a year (2000–2099),
 *   prepend the year: "Actual" → "2026 Actual", "Forecast" → "2026 Forecast".
 * - If the header already contains a year (e.g., "FY2025"), leave it alone.
 * - Row 0 numeric years propagate rightward to fill columns that share the same year
 *   band (spreadsheets typically have one year header spanning multiple monthly columns).
 */
function enrichColHeadersWithYears(headers: string[], cells: Cell[]): string[] {
  const enriched = [...headers];
  const maxCol = headers.length;

  // Build a map of col → numeric year from row 0
  const row0Cells = cells.filter((c) => c.r === 0 && c.c < maxCol).sort((a, b) => a.c - b.c);

  // Track the "current year" as we scan left to right (forward-fill)
  // Spreadsheets typically have a year label in the first column of a year band.
  let currentYear: string | null = null;
  const colYears: (string | null)[] = new Array(maxCol).fill(null);

  // First pass: assign explicit years from row 0 numeric cells
  for (const cell of row0Cells) {
    if (
      cell.type === "number" &&
      typeof cell.value === "number" &&
      cell.value >= 2000 &&
      cell.value <= 2099 &&
      Number.isInteger(cell.value)
    ) {
      colYears[cell.c] = String(cell.value);
    }
  }

  // Second pass: forward-fill (a year in col 10 applies to cols 10–16 until the next year)
  for (let ci = 0; ci < maxCol; ci++) {
    if (colYears[ci] !== null) {
      currentYear = colYears[ci];
    }
    colYears[ci] = currentYear;
  }

  // Third pass: enrich headers that don't already have a year
  const hasYearPattern = /\b20\d{2}\b/;
  for (let ci = 0; ci < maxCol; ci++) {
    const year = colYears[ci];
    if (!year) continue;
    const header = enriched[ci];
    if (hasYearPattern.test(header)) continue; // already has year
    // Prepend year to make period extraction work
    enriched[ci] = `${year} ${header}`;
  }

  return enriched;
}

// ---------------------------------------------------------------------------
// Main: runNumericVerifyInline
// ---------------------------------------------------------------------------
/**
 * Run numeric verification inline within the pipeline.
 *
 * @param db - Database client (from ctx.integrations.db)
 * @param dealId - Deal UUID
 * @param timeBudgetMs - Maximum time to spend. If exhausted, returns partial=true.
 *                       Pass `null` to disable time budget.
 */
export async function runNumericVerifyInline(
  db: DbClient,
  dealId: string,
  timeBudgetMs: number | null
): Promise<NumericVerifyResult> {
  const startTime = Date.now();
  const timeRemaining = () =>
    timeBudgetMs === null ? Infinity : timeBudgetMs - (Date.now() - startTime);

  const emptyResult: NumericVerifyResult = {
    figures: [],
    discrepancies: [],
    partial: false,
    documentsProcessed: 0,
    documentsTotal: 0,
    tablesLoaded: 0,
    tablesTotal: 0,
  };

  // Step 1: Find documents with doc_tables for this deal
  const DocumentIdSchema = z.object({ document_id: z.string() });
  const documentIdRows = await db.query(
    `SELECT DISTINCT document_id
     FROM doc_tables dt
     JOIN documents d ON d.id = dt.document_id
     WHERE d.deal_id = $1
     ORDER BY document_id
     LIMIT 100`,
    DocumentIdSchema,
    [dealId],
    { label: "NumericInline: find documents with doc_tables" }
  );

  if (documentIdRows.length === 0) return emptyResult;

  const documentIds = documentIdRows.map((r) => r.document_id);

  // Step 2: Build table index (metadata only)
  const tableIndex: z.infer<typeof TableIndexSchema>[] = [];
  let docsProcessed = 0;
  let timeBudgetExhaustedAtDocPhase = false;

  for (const docId of documentIds) {
    if (timeRemaining() < 30_000) {
      console.log(`[NumericInline] Time budget exhausted after ${docsProcessed}/${documentIds.length} documents`);
      timeBudgetExhaustedAtDocPhase = true;
      break;
    }
    docsProcessed++;

    const rows = await db.query(
      `SELECT id, document_id, sheet_or_page, caption,
              length(data::text) AS data_length
       FROM doc_tables
       WHERE document_id = $1::uuid
       ORDER BY sheet_or_page`,
      TableIndexSchema,
      [docId],
      { label: `NumericInline: index tables for ${docId.slice(0, 8)}` }
    );
    tableIndex.push(...rows);
  }

  // Step 3: Load table data — only sheets relevant to cross-agreement + metrics
  // For SCG: "FS Summary" and "FS Summary (hardcoded)" are the comparison targets
  const relevantSheets = new Set([
    SCG_CROSS_AGREEMENT.sourceASheet.toLowerCase(),
    SCG_CROSS_AGREEMENT.sourceBSheet.toLowerCase(),
  ]);

  const loadable = tableIndex.filter(
    (t) => t.data_length <= MAX_DATA_BYTES &&
      relevantSheets.has(t.sheet_or_page.trim().toLowerCase())
  );

  const oversizedRelevant = tableIndex.filter(
    (t) => t.data_length > MAX_DATA_BYTES &&
      relevantSheets.has(t.sheet_or_page.trim().toLowerCase())
  );

  if (oversizedRelevant.length > 0) {
    console.log(
      `[NumericInline] Relevant sheets exceed size limit: ${oversizedRelevant.map((t) => `${t.sheet_or_page} (${(t.data_length / 1_000_000).toFixed(1)}MB)`).join(", ")}`
    );
  }

  const allRawRows: Array<{ id: string; document_id: string; sheet_or_page: string; caption: string | null; data: any }> = [];
  let timeBudgetExhaustedAtTableLoad = false;

  for (const meta of loadable) {
    if (timeRemaining() < 20_000) {
      console.log(`[NumericInline] Time budget low — loaded ${allRawRows.length}/${loadable.length} tables`);
      timeBudgetExhaustedAtTableLoad = true;
      break;
    }

    const rows = await db.query(
      `SELECT id, document_id, sheet_or_page, caption, data
       FROM doc_tables
       WHERE id = $1::uuid`,
      DocTableDataSchema,
      [meta.id],
      { label: `NumericInline: load table ${meta.sheet_or_page}` }
    );
    allRawRows.push(...rows);
  }

  if (allRawRows.length === 0) {
    return {
      figures: [],
      discrepancies: [],
      partial: timeBudgetExhaustedAtDocPhase || timeBudgetExhaustedAtTableLoad,
      documentsProcessed: docsProcessed,
      documentsTotal: documentIds.length,
      tablesLoaded: 0,
      tablesTotal: tableIndex.length,
    };
  }

  // Step 4: Parse tables
  const tables = parseTables(allRawRows);
  console.log(`[NumericInline] Parsed ${tables.length} table(s) from ${allRawRows.length} raw row(s)`);

  // Step 5: Layer 1 — Extract metric figures from all loaded tables
  let allFigures: Figure[] = [];
  for (const table of tables) {
    const tableFigures = extractMetricFigures(table, SCG_METRIC_CONFIG);
    allFigures.push(...tableFigures);
  }

  // Step 6: Layer 2 — Cross-agreement (only discrepancy source)
  const crossResult = runCrossAgreement(tables, SCG_CROSS_AGREEMENT);

  // Merge figures: cross-agreement also produces figures (from source A)
  allFigures.push(...crossResult.figures);

  // Deduplicate figures by (name, period, source_sheet, document_id)
  // document_id is included to prevent the original model's figures from
  // shadowing the updated model's figures when both have the same sheet name.
  const figureKeys = new Set<string>();
  const dedupedFigures: Figure[] = [];
  for (const f of allFigures) {
    const key = `${f.name.toLowerCase()}::${f.period}::${f.source_sheet.toLowerCase()}::${f.source_doc}`;
    if (!figureKeys.has(key)) {
      figureKeys.add(key);
      dedupedFigures.push(f);
    }
  }

  const figures = dedupedFigures.slice(0, MAX_FIGURES);
  const discrepancies = crossResult.discrepancies.slice(0, MAX_DISCREPANCIES);

  const isPartial = timeBudgetExhaustedAtDocPhase || timeBudgetExhaustedAtTableLoad;

  console.log(
    `[NumericInline] ${isPartial ? "PARTIAL" : "Complete"}: ${figures.length} figures, ` +
    `${discrepancies.length} cross-agreement discrepancies (by period), ` +
    `${tables.length} tables from ${docsProcessed} documents.`
  );

  return {
    figures,
    discrepancies,
    partial: isPartial,
    documentsProcessed: docsProcessed,
    documentsTotal: documentIds.length,
    tablesLoaded: allRawRows.length,
    tablesTotal: tableIndex.length,
  };
}
