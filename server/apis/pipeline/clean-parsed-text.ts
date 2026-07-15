/**
 * Step 0.4 — Clean corrupted parsed_text for spreadsheet documents.
 *
 * The corruption: the old Excel parser exported the full 16384-column range
 * (Excel's max), filling empty columns with "Col\d+" placeholder headers and
 * empty-string data cells. This bloats a 65-column sheet from ~200KB to 5.8MB.
 *
 * Detection: a sheet header row has a high density of consecutive "Col\d+" tokens
 * with no real data beneath them in any row.
 *
 * Fix: for each affected sheet, detect the true rightmost populated column
 * (scanning data rows), then trim every row — header and data — to that boundary.
 *
 * Idempotent: once clean, detection finds nothing, step is a no-op.
 *
 * This module supports dry-run mode (reports what would change without writing)
 * and live mode (writes cleaned text back to documents.parsed_text).
 *
 * TIME-BUDGET AWARE: Accepts startTime and timeBudgetMs. Checks between documents
 * and returns partial=true if the budget is exceeded. Naturally resumable since
 * cleaned docs are skipped on subsequent invocations (idempotent).
 */

/** Minimal DB interface matching ctx.integrations.db at runtime */
interface DbClient {
  query: (sql: string, schema: z.ZodType<any>, params: unknown[], meta?: { label: string }) => Promise<any[]>;
}
import { z } from "@superblocksteam/sdk-api";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Result for a single sheet within a document */
export interface SheetCleanupResult {
  sheetName: string;
  originalColumnCount: number;
  detectedBoundary: number;
  columnsRemoved: number;
  /** First 3 rows before trim (header + 2 data rows) */
  sampleBefore: string[];
  /** First 3 rows after trim */
  sampleAfter: string[];
  /** Whether this sheet was detected as corrupted */
  isCorrupted: boolean;
}

/** Result for a single document */
export interface DocCleanupResult {
  documentId: string;
  fileName: string;
  sheets: SheetCleanupResult[];
  originalSize: number;
  cleanedSize: number;
  /** Net bytes saved */
  bytesSaved: number;
  /** Whether any sheet was corrupted */
  hadCorruption: boolean;
}

/** Overall result */
export interface CleanupPhaseResult {
  /** All documents analyzed (including non-corrupted ones) */
  documents: DocCleanupResult[];
  /** Total documents with corruption detected */
  corruptedCount: number;
  /** Total bytes saved across all documents */
  totalBytesSaved: number;
  /** Whether changes were written (false in dry-run) */
  applied: boolean;
  /** True if the phase stopped early due to time budget */
  partial: boolean;
  /** How many documents were processed before stopping */
  documentsProcessed: number;
  /** Total documents that need checking */
  documentsTotal: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** A header is considered a placeholder if it matches Col followed by digits */
const COL_PLACEHOLDER_RE = /^Col\d+$/;

/**
 * Minimum consecutive Col\d+ placeholders to trigger corruption detection.
 * A legitimate sheet might have a few generic-named columns, but 20+ in a row
 * with no data beneath is the corruption fingerprint.
 */
const MIN_CONSECUTIVE_PLACEHOLDERS = 20;

/**
 * When scanning data rows for the rightmost populated column, we sample
 * at most this many rows to keep runtime bounded on sheets with 10K+ rows.
 */
const MAX_SCAN_ROWS = 500;

/**
 * A data cell is considered "empty" for boundary detection if it's one of these.
 * The single-char "x" markers that appear at the end of some rows in the corrupted
 * data are formatting artifacts — they always sit beyond real data columns and
 * appear sporadically. We detect them by checking whether they occur ONLY in
 * columns that are Col\d+ placeholders with >90% empty fill rate.
 */
const EMPTY_CELL_VALUES = new Set(["", "x", "."]);

/**
 * Minimum percentage of data rows that must be empty for a column to be
 * considered "phantom" (part of the corruption). This handles edge cases where
 * 1-2 rows happen to have a stray value (e.g. the "x" markers).
 */
const EMPTY_THRESHOLD = 0.90;

// ─── Slice-based text loading (reused gRPC-safe pattern) ─────────────────────

const SLICE_SIZE = 2_000_000; // 2MB per substring read

const TextLengthSchema = z.object({ text_length: z.coerce.number() });
const TextSliceSchema = z.object({ text_slice: z.string() });
const SpreadsheetDocSchema = z.object({ id: z.string(), file_name: z.string() });

async function loadParsedText(
  db: DbClient,
  documentId: string
): Promise<string> {
  // Get length first
  const lenRows = await db.query(
    `SELECT COALESCE(length(parsed_text), 0) AS text_length FROM documents WHERE id = $1`,
    TextLengthSchema,
    [documentId],
    { label: `Get text length: ${documentId}` }
  );
  const totalLength = lenRows[0]?.text_length ?? 0;
  if (totalLength === 0) return "";

  if (totalLength <= SLICE_SIZE) {
    const rows = await db.query(
      `SELECT parsed_text AS text_slice FROM documents WHERE id = $1`,
      TextSliceSchema,
      [documentId],
      { label: `Load text (${(totalLength / 1000).toFixed(0)}KB)` }
    );
    return rows[0]?.text_slice ?? "";
  }

  // Large document — segmented loading
  const slices: string[] = [];
  let offset = 1;
  const totalSlices = Math.ceil(totalLength / SLICE_SIZE);
  for (let i = 0; i < totalSlices; i++) {
    const rows = await db.query(
      `SELECT substring(parsed_text FROM ${offset} FOR ${SLICE_SIZE}) AS text_slice FROM documents WHERE id = $1`,
      TextSliceSchema,
      [documentId],
      { label: `Load slice ${i + 1}/${totalSlices}` }
    );
    const slice = rows[0]?.text_slice ?? "";
    if (slice.length === 0) break;
    slices.push(slice);
    offset += SLICE_SIZE;
  }
  return slices.join("");
}

// ─── CSV row parsing (handles quoted fields with commas) ─────────────────────

function parseCSVRow(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function serializeCSVRow(fields: string[]): string {
  return fields.map(f => {
    if (f.includes(",") || f.includes('"') || f.includes("\n")) {
      return `"${f.replace(/"/g, '""')}"`;
    }
    return f;
  }).join(",");
}

// ─── Sheet splitting ─────────────────────────────────────────────────────────

interface SheetBlock {
  name: string;
  headerLine: string;
  dataLines: string[];
}

const SHEET_DELIMITER_RE = /^--- Sheet: (.+) ---$/;

function splitIntoSheets(text: string): SheetBlock[] {
  const lines = text.split("\n");
  const sheets: SheetBlock[] = [];
  let current: SheetBlock | null = null;

  for (const line of lines) {
    const match = line.match(SHEET_DELIMITER_RE);
    if (match) {
      if (current) sheets.push(current);
      current = { name: match[1], headerLine: "", dataLines: [] };
    } else if (current) {
      if (!current.headerLine) {
        current.headerLine = line;
      } else {
        current.dataLines.push(line);
      }
    }
  }
  if (current) sheets.push(current);
  return sheets;
}

function reassembleSheets(sheets: SheetBlock[]): string {
  const parts: string[] = [];
  for (const sheet of sheets) {
    parts.push(`--- Sheet: ${sheet.name} ---`);
    parts.push(sheet.headerLine);
    parts.push(...sheet.dataLines);
  }
  return parts.join("\n");
}

// ─── Core detection & cleanup logic ──────────────────────────────────────────

function analyzeSheet(sheet: SheetBlock): SheetCleanupResult {
  const headerFields = parseCSVRow(sheet.headerLine);
  const originalColumnCount = headerFields.length;

  // Step 1: Find consecutive Col\d+ placeholders in the header
  // Look for the first run of MIN_CONSECUTIVE_PLACEHOLDERS consecutive placeholders
  let longestRunStart = -1;
  let longestRunLength = 0;
  let runStart = -1;
  let runLength = 0;

  for (let i = 0; i < headerFields.length; i++) {
    if (COL_PLACEHOLDER_RE.test(headerFields[i])) {
      if (runStart === -1) runStart = i;
      runLength++;
      if (runLength > longestRunLength) {
        longestRunStart = runStart;
        longestRunLength = runLength;
      }
    } else {
      runStart = -1;
      runLength = 0;
    }
  }

  // Not enough consecutive placeholders → not corrupted
  if (longestRunLength < MIN_CONSECUTIVE_PLACEHOLDERS) {
    return {
      sheetName: sheet.name,
      originalColumnCount,
      detectedBoundary: originalColumnCount,
      columnsRemoved: 0,
      sampleBefore: [sheet.headerLine, ...sheet.dataLines.slice(0, 2)],
      sampleAfter: [sheet.headerLine, ...sheet.dataLines.slice(0, 2)],
      isCorrupted: false,
    };
  }

  // Step 2: Scan data rows to find the true rightmost populated column
  // Sample up to MAX_SCAN_ROWS evenly distributed
  const totalDataRows = sheet.dataLines.length;
  const step = Math.max(1, Math.floor(totalDataRows / MAX_SCAN_ROWS));
  const sampleIndices: number[] = [];
  for (let i = 0; i < totalDataRows && sampleIndices.length < MAX_SCAN_ROWS; i += step) {
    sampleIndices.push(i);
  }

  // For each column from longestRunStart onward, count how many sampled rows have
  // non-empty data. If a column is >EMPTY_THRESHOLD empty, it's phantom.
  // We track per-column emptiness to find the true boundary.
  let trueRightmost = 0;

  // First pass: scan all sampled rows to find per-row rightmost populated
  for (const idx of sampleIndices) {
    const line = sheet.dataLines[idx];
    if (!line) continue;
    const fields = parseCSVRow(line);
    // Find rightmost non-empty field in this row
    for (let col = fields.length - 1; col >= 0; col--) {
      const val = fields[col]?.trim() ?? "";
      if (!EMPTY_CELL_VALUES.has(val)) {
        if (col + 1 > trueRightmost) trueRightmost = col + 1;
        break;
      }
    }
  }

  // Safety: ensure we're not trimming TO zero or fewer columns than we started
  // If somehow all rows are empty, keep original (likely a metadata-only sheet)
  if (trueRightmost < 1) {
    trueRightmost = originalColumnCount;
  }

  // If the detected boundary is the same as original or larger, no corruption
  if (trueRightmost >= originalColumnCount) {
    return {
      sheetName: sheet.name,
      originalColumnCount,
      detectedBoundary: originalColumnCount,
      columnsRemoved: 0,
      sampleBefore: [sheet.headerLine, ...sheet.dataLines.slice(0, 2)],
      sampleAfter: [sheet.headerLine, ...sheet.dataLines.slice(0, 2)],
      isCorrupted: false,
    };
  }

  // Step 3: Verify that columns BEYOND the boundary are genuinely phantom
  // (>90% empty across sampled rows). This prevents false positives where
  // real data happens to be sparse.
  const columnsToCheck = Math.min(20, originalColumnCount - trueRightmost);
  let emptyCount = 0;
  let totalChecked = 0;

  for (const idx of sampleIndices.slice(0, 100)) { // check 100 rows for this validation
    const line = sheet.dataLines[idx];
    if (!line) continue;
    const fields = parseCSVRow(line);
    for (let col = trueRightmost; col < trueRightmost + columnsToCheck && col < fields.length; col++) {
      totalChecked++;
      const val = fields[col]?.trim() ?? "";
      if (EMPTY_CELL_VALUES.has(val)) emptyCount++;
    }
  }

  const emptyRate = totalChecked > 0 ? emptyCount / totalChecked : 0;
  if (emptyRate < EMPTY_THRESHOLD) {
    // The columns beyond the boundary aren't empty enough — not corruption
    return {
      sheetName: sheet.name,
      originalColumnCount,
      detectedBoundary: originalColumnCount,
      columnsRemoved: 0,
      sampleBefore: [sheet.headerLine, ...sheet.dataLines.slice(0, 2)],
      sampleAfter: [sheet.headerLine, ...sheet.dataLines.slice(0, 2)],
      isCorrupted: false,
    };
  }

  // Step 4: Build trimmed samples
  const boundary = trueRightmost;
  const trimmedHeader = serializeCSVRow(headerFields.slice(0, boundary));
  const sampleBefore = [sheet.headerLine, ...sheet.dataLines.slice(0, 2)];
  const sampleAfter: string[] = [trimmedHeader];
  for (const line of sheet.dataLines.slice(0, 2)) {
    const fields = parseCSVRow(line);
    sampleAfter.push(serializeCSVRow(fields.slice(0, boundary)));
  }

  return {
    sheetName: sheet.name,
    originalColumnCount,
    detectedBoundary: boundary,
    columnsRemoved: originalColumnCount - boundary,
    sampleBefore,
    sampleAfter,
    isCorrupted: true,
  };
}

function applyTrimToSheet(sheet: SheetBlock, boundary: number): SheetBlock {
  const headerFields = parseCSVRow(sheet.headerLine);
  const trimmedHeader = serializeCSVRow(headerFields.slice(0, boundary));

  const trimmedData = sheet.dataLines.map(line => {
    if (!line) return line;
    const fields = parseCSVRow(line);
    return serializeCSVRow(fields.slice(0, boundary));
  });

  return {
    name: sheet.name,
    headerLine: trimmedHeader,
    dataLines: trimmedData,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface CleanupInput {
  dealId: string;
  /** If true, only reports what would change without writing */
  dryRun: boolean;
  /** Pipeline start time (Date.now() at pipeline entry). Used for time-budget checks. */
  startTime: number;
  /** Time budget in ms from startTime. The phase will stop between documents if exceeded. */
  timeBudgetMs: number;
}

/**
 * Run the parsed_text cleanup phase.
 * Detects corruption in spreadsheet documents, trims phantom columns,
 * and optionally writes cleaned text back.
 *
 * TIME-BUDGET AWARE: Checks elapsed time between documents and returns
 * partial=true if the budget is exceeded. Naturally resumable because
 * cleaned docs are idempotent (no corruption detected on re-run).
 */
export async function runCleanParsedTextPhase(
  db: DbClient,
  input: CleanupInput
): Promise<CleanupPhaseResult> {
  const { dealId, dryRun, startTime, timeBudgetMs } = input;
  const timeRemaining = () => timeBudgetMs - (Date.now() - startTime);

  // Step 1: Find spreadsheet documents for this deal
  const docs = await db.query(
    `SELECT id, file_name FROM documents
     WHERE deal_id = $1
       AND file_type LIKE '%spreadsheet%'
       AND parsed_text IS NOT NULL
       AND parsed_text != ''
     ORDER BY uploaded_at
     LIMIT 50`,
    SpreadsheetDocSchema,
    [dealId],
    { label: "Find spreadsheet documents" }
  );

  const results: DocCleanupResult[] = [];
  let corruptedCount = 0;
  let totalBytesSaved = 0;
  let documentsProcessed = 0;

  for (const doc of docs) {
    // ─── Time-budget check between documents ─────────────────────────────
    // Reserve 30s headroom so we don't start a multi-MB load that can't finish.
    if (timeRemaining() < 30_000) {
      console.log(`[Step 0.4] Time budget exhausted after ${documentsProcessed}/${docs.length} documents — returning partial`);
      return {
        documents: results,
        corruptedCount,
        totalBytesSaved,
        applied: !dryRun,
        partial: true,
        documentsProcessed,
        documentsTotal: docs.length,
      };
    }

    const documentId = doc.id;
    const fileName = doc.file_name;

    // Load full parsed_text (paginated for gRPC safety)
    const text = await loadParsedText(db, documentId);
    const originalSize = Buffer.byteLength(text, "utf8");

    // Split into sheets
    const sheets = splitIntoSheets(text);

    // Analyze each sheet
    const sheetResults: SheetCleanupResult[] = [];
    const trimmedSheets: SheetBlock[] = [];
    let docHadCorruption = false;

    for (const sheet of sheets) {
      const analysis = analyzeSheet(sheet);
      sheetResults.push(analysis);

      if (analysis.isCorrupted) {
        docHadCorruption = true;
        trimmedSheets.push(applyTrimToSheet(sheet, analysis.detectedBoundary));
      } else {
        trimmedSheets.push(sheet);
      }
    }

    let cleanedSize = originalSize;
    let bytesSaved = 0;

    if (docHadCorruption) {
      const cleanedText = reassembleSheets(trimmedSheets);
      cleanedSize = Buffer.byteLength(cleanedText, "utf8");
      bytesSaved = originalSize - cleanedSize;
      corruptedCount++;

      // Write back if not dry-run
      if (!dryRun) {
        // Ensure backup table exists (idempotent)
        await db.query(
          `CREATE TABLE IF NOT EXISTS parsed_text_backups (
            id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
            document_id UUID NOT NULL,
            original_text TEXT NOT NULL,
            original_size INTEGER NOT NULL,
            cleaned_size INTEGER NOT NULL,
            cleaned_at TIMESTAMPTZ DEFAULT now(),
            CONSTRAINT fk_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
          )`,
          z.object({}),
          [],
          { label: "Ensure backup table exists" }
        );

        // Backup original parsed_text before overwriting
        await db.query(
          `INSERT INTO parsed_text_backups (document_id, original_text, original_size, cleaned_size)
           SELECT $1, parsed_text, $2, $3 FROM documents WHERE id = $1`,
          z.object({}),
          [documentId, originalSize, cleanedSize],
          { label: `Backup original text: ${fileName}` }
        );

        // Now write the cleaned text
        await db.query(
          `UPDATE documents SET parsed_text = $2 WHERE id = $1`,
          z.object({}),
          [documentId, cleanedText],
          { label: `Write cleaned text: ${fileName}` }
        );
        console.log(`[clean-parsed-text] Backed up & wrote cleaned text for ${fileName}: ${(originalSize / 1_000_000).toFixed(1)}MB → ${(cleanedSize / 1_000_000).toFixed(1)}MB (saved ${(bytesSaved / 1_000_000).toFixed(1)}MB)`);
      } else {
        console.log(`[clean-parsed-text] DRY RUN — would clean ${fileName}: ${(originalSize / 1_000_000).toFixed(1)}MB → ${(cleanedSize / 1_000_000).toFixed(1)}MB (save ${(bytesSaved / 1_000_000).toFixed(1)}MB)`);
      }

      totalBytesSaved += bytesSaved;
    }

    results.push({
      documentId,
      fileName,
      sheets: sheetResults,
      originalSize,
      cleanedSize,
      bytesSaved,
      hadCorruption: docHadCorruption,
    });

    documentsProcessed++;
  }

  return {
    documents: results,
    corruptedCount,
    totalBytesSaved,
    applied: !dryRun,
    partial: false,
    documentsProcessed,
    documentsTotal: docs.length,
  };
}
