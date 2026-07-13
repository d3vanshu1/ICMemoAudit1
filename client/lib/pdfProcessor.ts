import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { isSpreadsheetFile } from "@/lib/pipelineConfig";

// Use local worker file (required for pdfjs-dist v5 with Vite)
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single rendered page: text + JPEG image */
export interface ProcessedPage {
  pageNumber: number;
  text: string;
  /** base64-encoded JPEG (no data-url prefix) */
  imageBase64: string;
  mediaType: "image/jpeg";
}

/** A chunk of pages grouped for one sub-agent API call */
export interface DocumentChunk {
  /** Human-readable label, e.g. "CIM.pdf pages 1–10" */
  label: string;
  /** Source filename */
  sourceFile: string;
  /** Extracted text for the whole chunk */
  text: string;
  /** Page images */
  pageImages: ProcessedPage[];
}

// ---------------------------------------------------------------------------
// Structured table types — for deterministic numeric verification
// ---------------------------------------------------------------------------

/** A single cell in a structured table grid */
export interface StructuredCell {
  /** Row index (0-based) */
  r: number;
  /** Column index (0-based) */
  c: number;
  /** Resolved numeric or string value */
  value: number | string | null;
  /** Cell data type: number, string, date, boolean, empty */
  type: "number" | "string" | "date" | "boolean" | "empty";
  /** Original formula if present (without leading =) */
  formula?: string;
}

/** A structured table extracted from a sheet or CSV */
export interface StructuredTable {
  /** Sheet name or "CSV" for CSV files */
  sheetOrPage: string;
  /** Caption — first title row or sheet name */
  caption: string;
  /** Row header labels (first column values) */
  rowHeaders: string[];
  /** Column header labels (header row values) */
  colHeaders: string[];
  /** Flat array of cells */
  cells: StructuredCell[];
}

/** Reason a file was excluded from processing */
export type ExclusionReason = "unsupported_type" | "parse_failure" | "superseded" | "spreadsheet" | "too_large";

/** A file that was excluded from processing */
export interface ExcludedFile {
  fileName: string;
  reason: ExclusionReason;
  detail?: string;
}

/** Per-file processing metadata for the coverage manifest */
export interface ProcessedFileInfo {
  fileName: string;
  chunkCount: number;
  pageCount: number;
}

/** Result from processing all files */
export interface ProcessingResult {
  chunks: DocumentChunk[];
  /** Total pages processed */
  totalPages: number;
  /** Per-file breakdown of chunks and pages processed */
  filesProcessed: ProcessedFileInfo[];
  /** Files that were excluded, with reasons */
  filesExcluded: ExcludedFile[];
}

// ---------------------------------------------------------------------------
// Sanitization — prevent Superblocks orchestrator binding-parse errors
// ---------------------------------------------------------------------------

/**
 * Replace { and } with visually similar Unicode small curly brackets
 * (U+FE5B / U+FE5C). The Superblocks orchestrator scans the serialized
 * API input for {{ / }} template bindings before the server run() executes.
 * Real PDF text often contains curly braces which trigger a parse error.
 * These Unicode substitutes are readable by Claude but invisible to the
 * binding parser.
 */
function sanitizeBraces(text: string): string {
  if (!text) return text;
  return text.replace(/\{/g, "\uFE5B").replace(/\}/g, "\uFE5C");
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
/** Reduced from 20 → 10 to keep per-chunk payload within Anthropic limits */
const PAGES_PER_CHUNK = 10;
/** Lowered DPI — 120 is sufficient for Claude vision and cuts image size ~36% vs 150 */
const TARGET_DPI = 120;
/** PDF default is 72 DPI, so scale = targetDPI / 72 */
const RENDER_SCALE = TARGET_DPI / 72;
/** Increased compression — 0.45 JPEG quality is still legible to Claude */
const JPEG_QUALITY = 0.45;
// No chunk cap — all documents are fully processed.
// Checkpointing handles interruptions for large data rooms.

// ---------------------------------------------------------------------------
// Text-only extraction (for Q&A RAG indexing — no images, fast)
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a single file — used for Q&A indexing.
 * No image rendering, much faster than processAllFiles.
 */
export async function extractTextFromFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

  if (ext === "pdf") {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pageTexts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const text = await extractPageText(page);
      pageTexts.push(text);
    }
    return pageTexts.join("\n\n");
  }

  if (ext === "xlsx" || ext === "xls") {
    return parseExcel(buffer);
  }

  if (ext === "csv") {
    const text = new TextDecoder().decode(buffer);
    return parseCsv(text);
  }

  // Plain text fallback
  return new TextDecoder().decode(buffer);
}
/** Max characters for a single Excel formula before truncating */
const MAX_FORMULA_LENGTH = 150;

// ---------------------------------------------------------------------------
// Helpers — PDF
// ---------------------------------------------------------------------------

/** Render a single PDF page to a JPEG base64 string using an offscreen canvas */
async function renderPageToImage(
  page: pdfjsLib.PDFPageProxy
): Promise<string> {
  const viewport = page.getViewport({ scale: RENDER_SCALE });

  // Cap canvas dimensions to prevent memory issues on very large pages
  const MAX_DIMENSION = 2000;
  let scale = RENDER_SCALE;
  if (viewport.width > MAX_DIMENSION || viewport.height > MAX_DIMENSION) {
    const downscale = MAX_DIMENSION / Math.max(viewport.width, viewport.height);
    scale = RENDER_SCALE * downscale;
  }
  const finalViewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = finalViewport.width;
  canvas.height = finalViewport.height;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  await page.render({ canvas, canvasContext: ctx, viewport: finalViewport } as never).promise;

  // Convert to JPEG base64 — strip the data:image/jpeg;base64, prefix
  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  return dataUrl.split(",")[1];
}

/** Extract text content from a PDF page */
async function extractPageText(
  page: pdfjsLib.PDFPageProxy
): Promise<string> {
  const textContent = await page.getTextContent();
  const raw = textContent.items
    .map((item) => ("str" in item ? item.str : ""))
    .join(" ");
  return sanitizeBraces(raw);
}

// ---------------------------------------------------------------------------
// Helpers — Excel
// ---------------------------------------------------------------------------

/**
 * Extract the display value for a single Excel cell.
 *
 * Priority order:
 *  1. Formatted display value (cell.w) — dates, currency, percentages
 *  2. Raw value (cell.v) — fallback if no format string exists
 *  3. Formula text (cell.f) — shown as [=FORMULA] when no cached value exists
 *  4. Empty string — truly empty cell
 */
function getCellText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";

  // 1. Formatted display value
  if (cell.w != null && String(cell.w).trim() !== "") {
    return String(cell.w).trim();
  }

  // 2. Raw value (handles 0, false, etc.)
  if (cell.v != null && String(cell.v).trim() !== "") {
    return String(cell.v).trim();
  }

  // 3. Formula without cached value — include the formula text so the AI
  //    can see what the cell is supposed to compute
  if (cell.f) {
    const formula =
      cell.f.length > MAX_FORMULA_LENGTH
        ? cell.f.substring(0, MAX_FORMULA_LENGTH) + "..."
        : cell.f;
    return `[=${formula}]`;
  }

  return "";
}

/**
 * Escape a value for CSV output — wraps in quotes if it contains
 * commas, quotes, or newlines.
 */
function csvEscape(value: string): string {
  if (!value) return "";
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

/**
 * Parse an Excel buffer into compact CSV text.
 * Processes every sheet and concatenates the output.
 *
 * Output format is standard CSV — the most token-efficient tabular format
 * and the one LLMs parse most naturally. A 500-row financial model that
 * previously produced 15 chunks of `Row N: Header=Value | ...` now fits
 * in 2–3 chunks of clean CSV.
 *
 * Key design decisions:
 *  - Reads cells directly instead of using sheet_to_json, so that formula
 *    cells without cached values are still visible as [=FORMULA] text
 *  - Entirely blank rows are skipped
 *  - Header-row detection scans the first 5 rows to skip title/blank rows
 */
function parseExcel(buffer: ArrayBuffer): string {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sections: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet || !sheet["!ref"]) continue;

    const range = XLSX.utils.decode_range(sheet["!ref"]);

    // Build a 2D array of cell display values by reading cells directly.
    const allRows: string[][] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row: string[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[addr] as XLSX.CellObject | undefined;
        row.push(getCellText(cell));
      }
      allRows.push(row);
    }

    if (allRows.length === 0) continue;

    // Find the first row that looks like a real header (>=2 non-empty cells),
    // skipping title / blank rows at the top (search up to the first 5 rows).
    const HEADER_SCAN_LIMIT = 5;
    let headerRowIdx = 0;
    for (let i = 0; i < Math.min(HEADER_SCAN_LIMIT, allRows.length); i++) {
      const nonEmpty = allRows[i].filter((c) => c !== "").length;
      if (nonEmpty >= 2) {
        headerRowIdx = i;
        break;
      }
    }

    // Include any title rows above the header as context
    const titleRows = allRows.slice(0, headerRowIdx)
      .filter((row) => row.some((c) => c !== ""))
      .map((row) => row.filter((c) => c !== "").join(" "));

    const headers = allRows[headerRowIdx].map((h, i) => h || `Col${i + 1}`);
    const dataRows = allRows.slice(headerRowIdx + 1);

    // Filter out entirely blank rows, format as CSV
    const nonEmptyRows = dataRows.filter((row) => row.some((c) => c !== ""));

    const csvLines: string[] = [];

    // Add title context if present
    if (titleRows.length > 0) {
      csvLines.push(`# ${titleRows.join(" | ")}`);
    }

    // Header row
    csvLines.push(headers.map(csvEscape).join(","));

    // Data rows
    for (const row of nonEmptyRows) {
      csvLines.push(row.map(csvEscape).join(","));
    }

    const formatted = csvLines.join("\n");
    if (formatted.trim() === "") continue;

    if (workbook.SheetNames.length > 1) {
      sections.push(`--- Sheet: ${sheetName} ---\n${formatted}`);
    } else {
      sections.push(formatted);
    }
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Helpers — CSV
// ---------------------------------------------------------------------------

/**
 * Parse a CSV string — already in a compact format, just validate and
 * pass through. Filters out completely empty rows.
 */
function parseCsv(text: string): string {
  const { data, errors } = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  if (errors.length > 0 && data.length === 0) {
    throw new Error(`CSV parse failed: ${errors[0].message}`);
  }

  if (data.length === 0) return text;

  // Re-emit as clean CSV — header + rows
  const headers = Object.keys(data[0]);
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of data) {
    const values = headers.map((h) => csvEscape(row[h] ?? ""));
    lines.push(values.join(","));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Progress callback
// ---------------------------------------------------------------------------
export type ProgressCallback = (info: {
  file: string;
  currentPage: number;
  totalPages: number;
  phase: "rendering" | "complete";
}) => void;

// ---------------------------------------------------------------------------
// Core: process a single PDF file → array of chunks
// ---------------------------------------------------------------------------
async function processPdfFile(
  file: File,
  onProgress?: ProgressCallback
): Promise<DocumentChunk[]> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
    // Disable auto-fetch and streaming for local buffers
    disableAutoFetch: true,
    disableStream: true,
  }).promise;

  const totalPages = pdf.numPages;
  const baseName = file.name.replace(/\.pdf$/i, "");

  // Process all pages — render image + extract text
  const pages: ProcessedPage[] = [];
  for (let i = 1; i <= totalPages; i++) {
    try {
      const page = await pdf.getPage(i);
      const [imageBase64, text] = await Promise.all([
        renderPageToImage(page),
        extractPageText(page),
      ]);
      pages.push({ pageNumber: i, text, imageBase64, mediaType: "image/jpeg" });
    } catch (err) {
      // Fallback: if rendering fails, push text-only with empty image
      console.warn(`[pdfProcessor] Page ${i} of ${file.name} failed to render:`, err);
      try {
        const page = await pdf.getPage(i);
        const text = await extractPageText(page);
        pages.push({ pageNumber: i, text, imageBase64: "", mediaType: "image/jpeg" });
      } catch {
        // Even text extraction failed — skip this page
        console.warn(`[pdfProcessor] Page ${i} of ${file.name} completely unreadable, skipping.`);
      }
    }

    onProgress?.({
      file: file.name,
      currentPage: i,
      totalPages,
      phase: i === totalPages ? "complete" : "rendering",
    });
  }

  // Group pages into chunks
  const chunks: DocumentChunk[] = [];
  for (let start = 0; start < pages.length; start += PAGES_PER_CHUNK) {
    const chunkPages = pages.slice(start, start + PAGES_PER_CHUNK);
    const startPage = chunkPages[0]?.pageNumber ?? start + 1;
    const endPage = chunkPages[chunkPages.length - 1]?.pageNumber ?? start + PAGES_PER_CHUNK;

    const label =
      totalPages <= PAGES_PER_CHUNK
        ? file.name
        : `${baseName} [pages ${startPage}–${endPage}].pdf`;

    chunks.push({
      label: sanitizeBraces(label),
      sourceFile: sanitizeBraces(file.name),
      text: chunkPages.map((p) => p.text).join("\n\n"),
      pageImages: chunkPages,
    });
  }

  pdf.destroy();
  return chunks;
}

// ---------------------------------------------------------------------------
// Process an Excel file → one or more text chunks
// ---------------------------------------------------------------------------
async function processExcelFile(file: File): Promise<DocumentChunk[]> {
  const arrayBuffer = await file.arrayBuffer();
  const parsedText = parseExcel(arrayBuffer);

  if (!parsedText.trim()) {
    console.warn(`[pdfProcessor] ${file.name} produced no readable content.`);
    return [];
  }

  const sanitized = sanitizeBraces(parsedText);

  // Spreadsheets are text-only (no images), so we can use much larger chunks.
  // 40K chars ≈ ~10K tokens — well within Sonnet's context window.
  const EXCEL_CHUNK_CHARS = 40_000;
  const lines = sanitized.split("\n");
  const chunks: DocumentChunk[] = [];
  let currentLines: string[] = [];
  let currentLen = 0;
  let chunkIdx = 0;

  for (const line of lines) {
    if (currentLen + line.length > EXCEL_CHUNK_CHARS && currentLines.length > 0) {
      chunkIdx++;
      chunks.push({
        label: sanitizeBraces(
          chunks.length === 0 && lines.length - currentLines.length <= EXCEL_CHUNK_CHARS
            ? file.name
            : `${file.name} [part ${chunkIdx}]`
        ),
        sourceFile: sanitizeBraces(file.name),
        text: currentLines.join("\n"),
        pageImages: [],
      });
      currentLines = [];
      currentLen = 0;
    }
    currentLines.push(line);
    currentLen += line.length + 1;
  }

  // Flush remaining
  if (currentLines.length > 0) {
    chunkIdx++;
    const label =
      chunks.length === 0
        ? file.name
        : `${file.name} [part ${chunkIdx}]`;
    chunks.push({
      label: sanitizeBraces(label),
      sourceFile: sanitizeBraces(file.name),
      text: currentLines.join("\n"),
      pageImages: [],
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Process a CSV file → text chunk
// ---------------------------------------------------------------------------
async function processCsvFile(file: File): Promise<DocumentChunk> {
  const rawText = await file.text();
  const parsedText = parseCsv(rawText);
  return {
    label: sanitizeBraces(file.name),
    sourceFile: sanitizeBraces(file.name),
    text: sanitizeBraces(parsedText),
    pageImages: [],
  };
}

// ---------------------------------------------------------------------------
// Process a plain-text / unknown file → single text chunk
// ---------------------------------------------------------------------------
async function processTextFile(file: File): Promise<DocumentChunk> {
  const rawText = await file.text();
  return {
    label: sanitizeBraces(file.name),
    sourceFile: sanitizeBraces(file.name),
    text: sanitizeBraces(rawText),
    pageImages: [],
  };
}

// ---------------------------------------------------------------------------
// File type detection
// ---------------------------------------------------------------------------
function getFileCategory(file: File): "pdf" | "excel" | "csv" | "text" {
  const name = file.name.toLowerCase();
  const type = file.type;

  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";

  if (
    type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    type === "application/vnd.ms-excel" ||
    name.endsWith(".xlsx") ||
    name.endsWith(".xls")
  ) return "excel";

  if (type === "text/csv" || name.endsWith(".csv")) return "csv";

  return "text";
}

// ---------------------------------------------------------------------------
// Public API: process all uploaded files
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Structured table extraction — Excel/CSV → StructuredTable[]
// ---------------------------------------------------------------------------

/**
 * Parse an Excel buffer into structured cell grids.
 * Each sheet produces one StructuredTable with row/column headers
 * and typed cells including preserved formulas.
 */
export function parseExcelToTables(buffer: ArrayBuffer, fileName: string): StructuredTable[] {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const tables: StructuredTable[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet || !sheet["!ref"]) continue;

    const range = XLSX.utils.decode_range(sheet["!ref"]);

    // Build raw grid
    const allRows: Array<{ raw: (XLSX.CellObject | undefined)[]; display: string[] }> = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const rawRow: (XLSX.CellObject | undefined)[] = [];
      const displayRow: string[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[addr] as XLSX.CellObject | undefined;
        rawRow.push(cell);
        displayRow.push(getCellText(cell));
      }
      allRows.push({ raw: rawRow, display: displayRow });
    }

    if (allRows.length === 0) continue;

    // Find header row (same logic as parseExcel)
    const HEADER_SCAN_LIMIT = 5;
    let headerRowIdx = 0;
    for (let i = 0; i < Math.min(HEADER_SCAN_LIMIT, allRows.length); i++) {
      const nonEmpty = allRows[i].display.filter((c) => c !== "").length;
      if (nonEmpty >= 2) {
        headerRowIdx = i;
        break;
      }
    }

    // Caption from title rows above header
    const titleRows = allRows.slice(0, headerRowIdx)
      .filter((row) => row.display.some((c) => c !== ""))
      .map((row) => row.display.filter((c) => c !== "").join(" "));
    const caption = titleRows.length > 0 ? titleRows.join(" | ") : sheetName;

    // Column headers
    const colHeaders = allRows[headerRowIdx].display.map((h, i) => h || `Col${i + 1}`);

    // Data rows (after header)
    const dataRows = allRows.slice(headerRowIdx + 1);
    const nonEmptyRows = dataRows.filter((row) => row.display.some((c) => c !== ""));

    // Row headers (first column of each data row)
    const rowHeaders = nonEmptyRows.map((row) => row.display[0] || "");

    // Build structured cells
    const cells: StructuredCell[] = [];
    for (let ri = 0; ri < nonEmptyRows.length; ri++) {
      const row = nonEmptyRows[ri];
      for (let ci = 0; ci < row.raw.length; ci++) {
        const rawCell = row.raw[ci];
        if (!rawCell && !row.display[ci]) continue; // skip truly empty

        let value: number | string | null = null;
        let type: StructuredCell["type"] = "empty";
        let formula: string | undefined;

        if (rawCell) {
          // Determine type
          if (rawCell.t === "n") {
            type = "number";
            value = typeof rawCell.v === "number" ? rawCell.v : null;
          } else if (rawCell.t === "s" || rawCell.t === "z") {
            type = rawCell.t === "z" ? "empty" : "string";
            value = rawCell.v != null ? String(rawCell.v) : null;
          } else if (rawCell.t === "b") {
            type = "boolean";
            value = rawCell.v ? 1 : 0;
          } else if (rawCell.t === "d") {
            type = "date";
            value = rawCell.v instanceof Date
              ? rawCell.v.toISOString()
              : rawCell.v != null ? String(rawCell.v) : null;
          }

          // Preserve formula
          if (rawCell.f) {
            formula = rawCell.f;
          }
        } else {
          // display text but no raw cell object
          const text = row.display[ci];
          if (text) {
            const num = Number(text.replace(/[,$%()]/g, (m) => m === "(" ? "-" : m === ")" ? "" : ""));
            if (!isNaN(num) && text.trim() !== "") {
              type = "number";
              value = num;
            } else {
              type = "string";
              value = text;
            }
          }
        }

        cells.push({ r: ri, c: ci, value, type, formula });
      }
    }

    tables.push({ sheetOrPage: sheetName, caption, rowHeaders, colHeaders, cells });
  }

  return tables;
}

/**
 * Parse a CSV string into a StructuredTable.
 */
export function parseCsvToTable(text: string, fileName: string): StructuredTable | null {
  const { data, errors } = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  if (errors.length > 0 && data.length === 0) return null;
  if (data.length === 0) return null;

  const colHeaders = Object.keys(data[0]);
  const rowHeaders: string[] = [];
  const cells: StructuredCell[] = [];

  for (let ri = 0; ri < data.length; ri++) {
    const row = data[ri];
    rowHeaders.push(row[colHeaders[0]] ?? "");

    for (let ci = 0; ci < colHeaders.length; ci++) {
      const raw = row[colHeaders[ci]] ?? "";
      if (!raw) continue;

      const cleaned = raw.replace(/[,$%()]/g, (m) => m === "(" ? "-" : m === ")" ? "" : "");
      const num = Number(cleaned);
      if (!isNaN(num) && raw.trim() !== "") {
        cells.push({ r: ri, c: ci, value: num, type: "number" });
      } else {
        cells.push({ r: ri, c: ci, value: raw, type: "string" });
      }
    }
  }

  return {
    sheetOrPage: "CSV",
    caption: fileName,
    rowHeaders,
    colHeaders,
    cells,
  };
}

export async function processAllFiles(
  files: File[],
  onProgress?: ProgressCallback
): Promise<ProcessingResult> {
  const allChunks: DocumentChunk[] = [];
  let totalPages = 0;
  const filesProcessed: ProcessedFileInfo[] = [];
  const filesExcluded: ExcludedFile[] = [];

  for (const file of files) {
    const category = getFileCategory(file);

    // Skip spreadsheet files from LLM extraction — routed to doc_tables/NumericVerify instead
    if (isSpreadsheetFile(file.name)) {
      filesExcluded.push({ fileName: file.name, reason: "spreadsheet", detail: "Routed to doc_tables/NumericVerify (no LLM extraction needed)" });
      continue;
    }

    if (category === "pdf") {
      try {
        const chunks = await processPdfFile(file, onProgress);
        let filePages = 0;
        for (const chunk of chunks) {
          allChunks.push(chunk);
          filePages += chunk.pageImages.length;
        }
        totalPages += filePages;
        filesProcessed.push({ fileName: file.name, chunkCount: chunks.length, pageCount: filePages });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(`[pdfProcessor] Failed to process ${file.name}:`, err);
        // Attempt text-only fallback
        try {
          const fallback = await processTextFile(file);
          allChunks.push(fallback);
          filesProcessed.push({ fileName: file.name, chunkCount: 1, pageCount: 0 });
        } catch {
          console.warn(`[pdfProcessor] ${file.name} is completely unreadable, excluding.`);
          filesExcluded.push({ fileName: file.name, reason: "parse_failure", detail });
        }
      }
    } else if (category === "excel") {
      try {
        const chunks = await processExcelFile(file);
        if (chunks.length === 0) {
          console.warn(`[pdfProcessor] ${file.name} produced no content, excluding.`);
          filesExcluded.push({ fileName: file.name, reason: "parse_failure", detail: "Empty content after parsing" });
        } else {
          for (const chunk of chunks) {
            allChunks.push(chunk);
          }
          filesProcessed.push({ fileName: file.name, chunkCount: chunks.length, pageCount: 0 });
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(`[pdfProcessor] Failed to parse Excel ${file.name}:`, err);
        filesExcluded.push({ fileName: file.name, reason: "parse_failure", detail });
      }
    } else if (category === "csv") {
      try {
        const chunk = await processCsvFile(file);
        allChunks.push(chunk);
        filesProcessed.push({ fileName: file.name, chunkCount: 1, pageCount: 0 });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(`[pdfProcessor] Failed to parse CSV ${file.name}:`, err);
        filesExcluded.push({ fileName: file.name, reason: "parse_failure", detail });
      }
    } else {
      try {
        const chunk = await processTextFile(file);
        allChunks.push(chunk);
        filesProcessed.push({ fileName: file.name, chunkCount: 1, pageCount: 0 });
      } catch {
        console.warn(`[pdfProcessor] ${file.name} could not be read, excluding.`);
        filesExcluded.push({ fileName: file.name, reason: "parse_failure", detail: "Unreadable file" });
      }
    }
  }

  return { chunks: allChunks, totalPages, filesProcessed, filesExcluded };
}
