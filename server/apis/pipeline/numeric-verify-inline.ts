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
  /** Diagnostic: cross-agreement comparison stats */
  crossAgreementDebug?: {
    status: string;
    sourceATablesFound: number;
    sourceBTablesFound: number;
    allTableSheets: string[];
    mapASize: number;
    mapBSize: number;
    sharedKeys: number;
    comparedPairs: number;
    divergedPairs: number;
    identicalPairs: number;
    sampleSharedEntries: Array<{ label: string; period: string; valueA: number; valueB: number }>;
  };
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
  /** Headline finding: one plain-language summary sentence for the period */
  headline: string;
  /** Materiality floor used for tiering (stated in headline for transparency) */
  materialityFloor: { abs: number; rel: number };
  metrics: Array<{
    label: string;
    sourceA: number;
    sourceB: number;
    absDiff: number;
    relDiffPct: number;
    /** Tier: "material" = above materiality floor + aggregate label; "detail" = everything else */
    tier: "material" | "detail";
    /** True if the label is an aggregate/section-level line (Total*, EBITDA, GP, etc.) */
    isAggregate: boolean;
    /** True if the label appears more than once in the source sheet (lower-confidence match) */
    isDuplicateLabel: boolean;
  }>;
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
  /**
   * Materiality floor for tiering. Lines above BOTH thresholds AND matching aggregate patterns
   * are classified as "material" (tier 2); all others as "detail" (tier 3).
   * Headline (tier 1) is a synthesized narrative from the material tier.
   */
  materialityAbsFloor: number;
  materialityRelFloor: number;
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
 * SCG metric config: which row labels constitute "metrics" for figure reading.
 * Covers the standard P&L/BS/CF hierarchy. If a row label matches any pattern,
 * its values across all period columns are emitted as verified figures.
 */
const SCG_METRIC_CONFIG: MetricConfig = {
  isRegex: true,
  labelPatterns: [
    "^Total\\s+(direct\\s+costs|overheads|revenue|Group\\s+revenue)",
    "^(Revenue|EBITDA|EBIT|Gross\\s+Profit|Net\\s+Income|Operating\\s+Profit)",
    "^(Adjusted|Adj\\.?|Normalised|Underlying|Reported)\\s+(EBITDA|EBIT|Revenue)",
    "^(ARR|MRR|Net\\s+Revenue|Recurring\\s+Revenue)",
    "^Surgery\\s+Intellect\\s+GP",
  ],
};

/**
 * SCG cross-agreement config (template — no hardcoded document IDs).
 * Compares "FS Summary" (live updated) vs "FS Summary (hardcoded)" (frozen reference).
 * Document pinning is resolved at runtime via `resolveLiveModelDocId()` which finds
 * the document containing BOTH sheets — a structural signal that survives re-upload.
 */
const SCG_CROSS_AGREEMENT_TEMPLATE: Omit<CrossAgreementConfig, "sourceADocId" | "sourceBDocId"> = {
  sourceASheet: "FS Summary",
  sourceBSheet: "FS Summary (hardcoded)",
  matchingRule: "exact",
  absThreshold: 1_000, // £1k absolute minimum — floor for ANY divergence to be recorded
  relThreshold: 0.0001, // 0.01% relative
  // Materiality floor: determines tier 2 ("material movements") vs tier 3 ("detail")
  materialityAbsFloor: 500_000, // £500k
  materialityRelFloor: 0.05, // 5%
};

// ---------------------------------------------------------------------------
// Document resolution: resolves the live model by structural sheet presence
// ---------------------------------------------------------------------------

/** Schema for the resolution query */
const DocSheetPresenceSchema = z.object({
  document_id: z.string(),
  file_name: z.string(),
  has_source_a: z.coerce.boolean(),
  has_source_b: z.coerce.boolean(),
});

/**
 * Resolves the "live model" document ID for cross-agreement by finding the single
 * document that contains BOTH comparison sheets (e.g., "FS Summary" AND "FS Summary (hardcoded)").
 *
 * Rationale: The live/updated model contains both the formula-driven live sheet and its
 * hardcoded snapshot companion — this is a structural invariant that survives re-upload
 * (unlike a UUID literal which breaks on re-upload). The original/frozen model lacks
 * the "(hardcoded)" companion sheet entirely.
 *
 * Fail-loud: throws if 0 or >1 documents match (ambiguity = must be resolved by user).
 */
async function resolveLiveModelDocId(
  db: DbClient,
  dealId: string,
  sourceASheet: string,
  sourceBSheet: string,
): Promise<{ docId: string; fileName: string }> {
  // Query: for each financial_model document in this deal, check whether it
  // contains both required sheets (case-insensitive match on sheet_or_page).
  const candidates = await db.query(
    `SELECT
       d.id AS document_id,
       d.file_name,
       BOOL_OR(LOWER(TRIM(dt.sheet_or_page)) = LOWER($2)) AS has_source_a,
       BOOL_OR(LOWER(TRIM(dt.sheet_or_page)) = LOWER($3)) AS has_source_b
     FROM documents d
     JOIN doc_tables dt ON dt.document_id = d.id
     WHERE d.deal_id = $1
       AND d.document_tag = 'financial_model'
     GROUP BY d.id, d.file_name
     HAVING
       BOOL_OR(LOWER(TRIM(dt.sheet_or_page)) = LOWER($2)) = TRUE
       AND BOOL_OR(LOWER(TRIM(dt.sheet_or_page)) = LOWER($3)) = TRUE
     LIMIT 10`,
    DocSheetPresenceSchema,
    [dealId, sourceASheet, sourceBSheet],
    { label: "Resolve live model: find doc with both comparison sheets" }
  );

  if (candidates.length === 0) {
    throw new Error(
      `[NumericVerify:Provenance] No document contains both "${sourceASheet}" and "${sourceBSheet}" sheets. ` +
      `Cannot determine which file is the live model. Upload a model containing both sheets, or verify document tags.`
    );
  }

  if (candidates.length > 1) {
    const listing = candidates.map(c => `${c.file_name} (${c.document_id.slice(0, 8)})`).join("; ");
    throw new Error(
      `[NumericVerify:Provenance] AMBIGUOUS — ${candidates.length} documents contain both ` +
      `"${sourceASheet}" and "${sourceBSheet}": [${listing}]. ` +
      `Which file is the live model? Remove or re-tag the duplicate to resolve.`
    );
  }

  const resolved = candidates[0];
  console.log(
    `[NumericVerify:Provenance] Resolved live model: "${resolved.file_name}" (${resolved.document_id.slice(0, 8)}) — ` +
    `contains both "${sourceASheet}" and "${sourceBSheet}".`
  );
  return { docId: resolved.document_id, fileName: resolved.file_name };
}

// Period column detection: matches FY year columns and standard period labels
const PERIOD_COL_PATTERN = /\b(20\d{2}|fy\s*\d{2,4}|cy\s*\d{2,4}|q[1-4]|h[12]|ytd|ltm)\b|^(actual|forecast|budget|plan)$/i;

// ---------------------------------------------------------------------------
// Aggregate label detection — identifies section/summary-level lines
// ---------------------------------------------------------------------------

/** Patterns that indicate a row is an aggregate/section-level line rather than a detail line */
const AGGREGATE_LABEL_PATTERNS = [
  /^Total\b/i,
  /\bEBITDA\b/i,
  /\bGross\s*Profit\b/i,
  /\bGP\b/,
  /\b(direct\s+costs|overheads)\b/i,
  /\badjustments\b/i,
  /\bcontribution\b/i,
  /\bNet\s+(income|profit|loss)\b/i,
  /^(Group\s+)?Revenue\b/i,
  /^Total\s+Group\b/i,
];

function isAggregateLabel(label: string): boolean {
  return AGGREGATE_LABEL_PATTERNS.some((p) => p.test(label));
}

/**
 * Detect duplicate labels within a set of entries.
 * Returns a Set of labels that appear more than once (lower-confidence matches).
 */
function findDuplicateLabels(entries: CrossAgreementEntry[]): Set<string> {
  const labelCounts = new Map<string, number>();
  for (const e of entries) {
    const key = e.label.trim().toLowerCase();
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  const duplicates = new Set<string>();
  for (const [key, count] of labelCounts) {
    if (count > 1) duplicates.add(key);
  }
  return duplicates;
}

/**
 * Generate a headline finding for a period's material divergences.
 * Leads with EBITDA/revenue impact.
 */
function generateHeadline(
  materialMetrics: Array<{ label: string; sourceA: number; sourceB: number; absDiff: number; relDiffPct: number }>,
  period: string,
  materialityFloor: { abs: number; rel: number },
  sourceASheet: string,
  sourceBSheet: string,
): string {
  if (materialMetrics.length === 0) {
    return `No material divergences (>\u00a3${(materialityFloor.abs / 1000).toFixed(0)}k abs or >${(materialityFloor.rel * 100).toFixed(0)}% rel) found in period "${period}" between "${sourceASheet}" and "${sourceBSheet}".`;
  }

  // Find key headline metrics: EBITDA (reported or adj) and revenue
  const ebitdaLine = materialMetrics.find((m) => /EBITDA/i.test(m.label));
  const revenueLine = materialMetrics.find((m) => /revenue/i.test(m.label) && /Total.*Group/i.test(m.label))
    ?? materialMetrics.find((m) => /revenue/i.test(m.label));

  const formatDelta = (m: { sourceA: number; sourceB: number; absDiff: number }) => {
    const sign = m.sourceA > m.sourceB ? "+" : "\u2212";
    const mag = m.absDiff >= 1_000_000
      ? `\u00a3${(m.absDiff / 1_000_000).toFixed(1)}m`
      : `\u00a3${(m.absDiff / 1_000).toFixed(0)}k`;
    return `${sign}${mag}`;
  };

  const parts: string[] = [];
  parts.push(`Live model revised vs frozen snapshot in FY${period}`);
  if (ebitdaLine) parts.push(`${ebitdaLine.label} ${formatDelta(ebitdaLine)}`);
  if (revenueLine) parts.push(`revenue ${formatDelta(revenueLine)}`);
  parts.push(`(${materialMetrics.length} material movement${materialMetrics.length === 1 ? "" : "s"} above \u00a3${(materialityFloor.abs / 1000).toFixed(0)}k/\u200B${(materialityFloor.rel * 100).toFixed(0)}%)`);
  parts.push("— confirm memo cites current model.");

  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_DATA_BYTES = 2_500_000;
const MAX_FIGURES = 500;
// MAX_DISCREPANCIES removed: discrepancies are no longer truncated in the stored set.
// The tiered report shows all divergences; the merge prompt uses only the headline + material summary.

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

/**
 * Detect which period columns are annual summaries vs monthly/sub-annual.
 *
 * Heuristic: group columns by base year. For each year, the first (lowest col
 * index) is the annual summary; the rest are monthly/sub-annual detail.
 * Years with exactly one column treat that column as annual.
 *
 * Shared by extractMetricFigures (Layer 1) and extractAllNumericEntries (Layer 2)
 * to ensure consistent annual-only filtering across both layers.
 */
function detectAnnualColumns(periodCols: Array<{ colIdx: number; period: string }>): Set<number> {
  const colsByBaseYear = new Map<string, number[]>();
  for (const pc of periodCols) {
    const baseYear = periodBaseYear(pc.period);
    if (!colsByBaseYear.has(baseYear)) colsByBaseYear.set(baseYear, []);
    colsByBaseYear.get(baseYear)!.push(pc.colIdx);
  }

  const annualCols = new Set<number>();
  for (const [, cols] of colsByBaseYear) {
    cols.sort((a, b) => a - b);
    annualCols.add(cols[0]); // First (lowest index) = annual summary
  }
  return annualCols;
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

  // CRITICAL (Fix 2C): Only emit figures from ANNUAL summary columns.
  // Monthly/sub-annual columns have per-month values (e.g., £4.6m) that are
  // incomparable to annual totals (£57m). Feeding both into the Verified Figures
  // list causes the merge LLM to fabricate "formula error" contradictions.
  const annualCols = detectAnnualColumns(periodCols);

  // Find metric rows
  for (let ri = 0; ri < rowHeaders.length; ri++) {
    const label = rowHeaders[ri];
    if (!matchesMetricConfig(label, metricConfig)) continue;

    for (const { colIdx, period } of periodCols) {
      if (!annualCols.has(colIdx)) continue; // Skip sub-annual columns
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
  /** True if this entry comes from an annual summary column (not monthly/sub-annual) */
  isAnnual: boolean;
}

interface CrossAgreementDebug {
  status: "ok" | "source_not_found" | "ambiguous_source";
  sourceATablesFound: number;
  sourceBTablesFound: number;
  allTableSheets: string[];
  mapASize: number;
  mapBSize: number;
  sharedKeys: number;
  comparedPairs: number;
  divergedPairs: number;
  identicalPairs: number;
  sampleSharedEntries: Array<{ label: string; period: string; valueA: number; valueB: number }>;
}

function runCrossAgreement(
  tables: ParsedTable[],
  config: CrossAgreementConfig
): { discrepancies: Discrepancy[]; figures: Figure[]; debug: CrossAgreementDebug } {
  const discrepancies: Discrepancy[] = [];
  const figures: Figure[] = [];
  const emptyDebug: CrossAgreementDebug = { status: "source_not_found", sourceATablesFound: 0, sourceBTablesFound: 0, allTableSheets: tables.map(t => `${t.sheetOrPage} [${t.documentId.slice(0,8)}]`), mapASize: 0, mapBSize: 0, sharedKeys: 0, comparedPairs: 0, divergedPairs: 0, identicalPairs: 0, sampleSharedEntries: [] };

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
    return { discrepancies, figures, debug: { ...emptyDebug, sourceATablesFound: sourceATables.length, sourceBTablesFound: sourceBTables.length } };
  }

  // Fail loud if multiple tables match a source spec — never silently take [0]
  // EXCEPTION: if all matching tables are from the SAME document (pinned), take the
  // first one. This handles docs with duplicate sheet entries (e.g., multiple table
  // regions parsed from the same sheet). The ambiguity guard is for cross-document
  // confusion, not intra-document duplicates.
  if (sourceATables.length > 1) {
    const uniqueDocIds = new Set(sourceATables.map(t => t.documentId));
    if (uniqueDocIds.size > 1) {
      console.warn(
        `[NumericInline:CrossAgreement] AMBIGUOUS source A: ${sourceATables.length} tables match "${config.sourceASheet}"` +
        `${config.sourceADocId ? ` in doc ${config.sourceADocId.slice(0,8)}` : ""}. ` +
        `Documents: [${sourceATables.map(t => t.documentId.slice(0,8)).join(", ")}]. Skipping cross-agreement.`
      );
      return { discrepancies, figures, debug: { ...emptyDebug, status: "ambiguous_source" as const, sourceATablesFound: sourceATables.length, sourceBTablesFound: sourceBTables.length } };
    }
    console.log(`[NumericInline:CrossAgreement] Source A: ${sourceATables.length} tables match (same doc) — using first.`);
  }
  if (sourceBTables.length > 1) {
    const uniqueDocIds = new Set(sourceBTables.map(t => t.documentId));
    if (uniqueDocIds.size > 1) {
      console.warn(
        `[NumericInline:CrossAgreement] AMBIGUOUS source B: ${sourceBTables.length} tables match "${config.sourceBSheet}"` +
        `${config.sourceBDocId ? ` in doc ${config.sourceBDocId.slice(0,8)}` : ""}. ` +
        `Documents: [${sourceBTables.map(t => t.documentId.slice(0,8)).join(", ")}]. Skipping cross-agreement.`
      );
      return { discrepancies, figures, debug: { ...emptyDebug, status: "ambiguous_source" as const, sourceATablesFound: sourceATables.length, sourceBTablesFound: sourceBTables.length } };
    }
    console.log(`[NumericInline:CrossAgreement] Source B: ${sourceBTables.length} tables match (same doc) — using first.`);
  }

  const tableA = sourceATables[0];
  const tableB = sourceBTables[0];

  // Extract all numeric entries from both sheets
  const entriesA = extractAllNumericEntries(tableA);
  const entriesB = extractAllNumericEntries(tableB);

  // Detect duplicate labels in source A (lower-confidence matches when label appears >1 time)
  const duplicateLabelsA = findDuplicateLabels(entriesA);

  // Build lookup maps: key = "normalizedLabel::baseYear"
  // Cross-agreement uses BASE YEAR (no qualifier) so that live-model "actual" columns
  // match hardcoded-model "forecast" columns for the same fiscal year.
  // First-occurrence-wins per base-year avoids both:
  //   (a) downstream rows with same label shadowing structural rows
  //   (b) forecast columns shadowing actual columns within one sheet (actual comes first)
  //
  // CRITICAL: Only use annual entries for cross-agreement. Monthly/sub-annual columns
  // (detected by extractAllNumericEntries) have per-month values that are not comparable
  // to annual summaries. When a row's annual cell is blank but monthly cells exist,
  // the monthly value would be incorrectly compared against the hardcoded annual — the
  // exact false-positive pattern (D&A −4.8M monthly vs −59.9M annual).
  const mapA = new Map<string, CrossAgreementEntry>();
  for (const e of entriesA) {
    if (!e.isAnnual) continue; // Skip sub-annual entries
    const key = `${e.label.trim().toLowerCase()}::${periodBaseYear(e.period)}`;
    if (!mapA.has(key)) mapA.set(key, e);
  }

  const mapB = new Map<string, CrossAgreementEntry>();
  for (const e of entriesB) {
    if (!e.isAnnual) continue; // Skip sub-annual entries
    const key = `${e.label.trim().toLowerCase()}::${periodBaseYear(e.period)}`;
    if (!mapB.has(key)) mapB.set(key, e);
  }

  // Diagnostic: log cross-agreement map sizes and shared keys
  const sharedKeys = [...mapA.keys()].filter(k => mapB.has(k));
  console.log(
    `[NumericInline:CrossAgreement] Map sizes: A=${mapA.size}, B=${mapB.size}, shared=${sharedKeys.length}. ` +
    `Sample shared keys: ${sharedKeys.slice(0, 5).join("; ")}`
  );

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

  let comparedCount = 0;
  let divergedCount = 0;
  let identicalCount = 0;

  for (const [key, entryA] of mapA) {
    const entryB = mapB.get(key);
    if (!entryB) continue;
    comparedCount++;

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
      divergedCount++;
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
    } else if (absDiff === 0) {
      identicalCount++;
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

  console.log(
    `[NumericInline:CrossAgreement] Comparison complete: ${comparedCount} pairs compared, ` +
    `${divergedCount} diverged (above threshold), ${identicalCount} identical. ` +
    `Periods with divergences: ${divergencesByPeriod.size}`
  );

  // Roll up: one discrepancy per period containing ALL metrics, tiered
  const materialityFloor = { abs: config.materialityAbsFloor, rel: config.materialityRelFloor };

  for (const [period, divergences] of divergencesByPeriod) {
    if (divergences.length === 0) continue;

    // Sort by absolute difference descending
    divergences.sort((a, b) => b.absDiff - a.absDiff);

    // Classify each metric with tier + flags
    const taggedMetrics = divergences.map((d) => {
      const aggregate = isAggregateLabel(d.label);
      const aboveMateriality =
        d.absDiff >= materialityFloor.abs || (d.relDiffPct / 100) >= materialityFloor.rel;
      const tier: "material" | "detail" = (aggregate && aboveMateriality) ? "material" : "detail";
      return {
        label: d.label,
        sourceA: d.valueA,
        sourceB: d.valueB,
        absDiff: d.absDiff,
        relDiffPct: d.relDiffPct,
        tier,
        isAggregate: aggregate,
        isDuplicateLabel: duplicateLabelsA.has(d.label.trim().toLowerCase()),
      };
    });

    // Generate headline from material-tier metrics
    const materialMetrics = taggedMetrics.filter((m) => m.tier === "material");
    const headline = generateHeadline(materialMetrics, period, materialityFloor, config.sourceASheet, config.sourceBSheet);

    // Description: summary for backward compat / log consumption
    const metricSummary = taggedMetrics
      .filter((m) => m.tier === "material")
      .slice(0, 20)
      .map((d) => `${d.label}: ${d.sourceA.toLocaleString()} (${config.sourceASheet}) vs ${d.sourceB.toLocaleString()} (${config.sourceBSheet}) — Δ${d.relDiffPct.toFixed(2)}%`)
      .join("\n  ");

    const severity: Discrepancy["severity"] = taggedMetrics.some((d) => d.relDiffPct > 5) ? "critical" : "warning";

    discrepancies.push({
      description: `Cross-version divergence in period "${period}" — ${taggedMetrics.length} metric(s) total (${materialMetrics.length} material, ${taggedMetrics.length - materialMetrics.length} detail) between "${config.sourceASheet}" and "${config.sourceBSheet}":\n  ${metricSummary}`,
      severity,
      check_type: "cross_doc_agreement",
      sources: [
        `${tableA.documentId}::${tableA.sheetOrPage}`,
        `${tableB.documentId}::${tableB.sheetOrPage}`,
      ],
      period,
      headline,
      materialityFloor,
      metrics: taggedMetrics,
    });
  }

  // Build sample shared entries for debugging
  const sampleSharedEntries = sharedKeys.slice(0, 10).map(k => {
    const a = mapA.get(k)!;
    const b = mapB.get(k)!;
    return { label: a.label, period: a.period, valueA: a.value, valueB: b.value };
  });

  const debug: CrossAgreementDebug = {
    status: "ok",
    sourceATablesFound: 1,
    sourceBTablesFound: 1,
    allTableSheets: tables.map(t => `${t.sheetOrPage} [${t.documentId.slice(0,8)}]`),
    mapASize: mapA.size,
    mapBSize: mapB.size,
    sharedKeys: sharedKeys.length,
    comparedPairs: comparedCount,
    divergedPairs: divergedCount,
    identicalPairs: identicalCount,
    sampleSharedEntries,
  };

  return { discrepancies, figures, debug };
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

  // Use shared annual-column detection (same heuristic as extractMetricFigures)
  const annualCols = detectAnnualColumns(periodCols);

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
        isAnnual: annualCols.has(colIdx),
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

  // Step 0: Resolve provenance — which document is the "live model"?
  // Uses structural sheet presence (both comparison sheets must exist in same doc).
  const { docId: liveModelDocId, fileName: liveModelFileName } = await resolveLiveModelDocId(
    db,
    dealId,
    SCG_CROSS_AGREEMENT_TEMPLATE.sourceASheet,
    SCG_CROSS_AGREEMENT_TEMPLATE.sourceBSheet,
  );

  // Build the resolved cross-agreement config with pinned document ID
  const crossAgreementConfig: CrossAgreementConfig = {
    ...SCG_CROSS_AGREEMENT_TEMPLATE,
    sourceADocId: liveModelDocId,
    sourceBDocId: liveModelDocId,
  };

  console.log(
    `[NumericInline] Provenance resolved: live model = "${liveModelFileName}" (${liveModelDocId.slice(0, 8)}). ` +
    `Cross-agreement: "${crossAgreementConfig.sourceASheet}" vs "${crossAgreementConfig.sourceBSheet}".`
  );

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
  // Uses the resolved config (no hardcoded sheet names at this layer)
  const relevantSheets = new Set([
    crossAgreementConfig.sourceASheet.toLowerCase(),
    crossAgreementConfig.sourceBSheet.toLowerCase(),
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

  // Step 5: Layer 1 — Extract metric figures from the LIVE MODEL only.
  // Figures are the source-of-truth model values fed to the LLM — they must come
  // exclusively from the resolved live model's primary (live) sheet, not from the
  // hardcoded/frozen comparison sheet (which would inject reference/stale values
  // alongside the live ones and create ambiguity for downstream reconciliation).
  let allFigures: Figure[] = [];
  const primarySheet = crossAgreementConfig.sourceASheet.toLowerCase();
  for (const table of tables.filter(t =>
    t.documentId === liveModelDocId &&
    t.sheetOrPage.trim().toLowerCase() === primarySheet
  )) {
    const tableFigures = extractMetricFigures(table, SCG_METRIC_CONFIG);
    allFigures.push(...tableFigures);
  }

  // Step 6: Layer 2 — Cross-agreement (only discrepancy source)
  const crossResult = runCrossAgreement(tables, crossAgreementConfig);

  // NOTE: Cross-agreement also emits figures from source A for every compared row.
  // We intentionally DO NOT merge them into allFigures because:
  //   1. Layer 1 already captures all metric-config-matching figures from the primary sheet.
  //   2. Cross-agreement figures include non-metric rows (detail lines) that would pollute
  //      the reconciliation coordinate space.
  //   3. Cross-agreement compares by base year across both sheets, so its "figures" may
  //      include hardcoded-sheet periods not present in the live sheet's annual columns.
  // The cross-agreement's job is solely to detect divergences between tabs.

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
  // Do NOT truncate discrepancies — all divergences feed the tiered report.
  // The merge-prompt injection (pipeline-core.ts) already uses only the per-period
  // headline + material-tier lines from the .description field (bounded by design).
  const discrepancies = crossResult.discrepancies;

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
    crossAgreementDebug: crossResult.debug,
  };
}
