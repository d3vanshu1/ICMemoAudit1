/**
 * Pipeline Configuration — single source of truth for extraction pipeline settings.
 *
 * Change these values to tune performance vs. quality tradeoffs.
 * All pipeline code reads from this file — no hardcoded duplicates.
 */

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Maximum characters per document chunk before splitting.
 * - Production: ~5,000 chars (fine-grained extraction)
 * - Testing: ~45,000 chars (fewer chunks, faster pipeline)
 */
export const CHUNK_CHARS = 5_000;

// ---------------------------------------------------------------------------
// Extraction concurrency
// ---------------------------------------------------------------------------

/**
 * Number of concurrent UniversalExtract API calls.
 * Higher = faster pipeline, but more API pressure.
 * - Production: 10–15
 * - Testing: 25 (max throughput)
 */
export const CHUNK_CONCURRENCY = 12;

// ---------------------------------------------------------------------------
// Extraction model
// ---------------------------------------------------------------------------

/**
 * Claude model used for universal extraction.
 * - Production: "claude-sonnet-4-6" (highest quality)
 * - Testing: "claude-haiku-4-5-20251001" (fastest/cheapest)
 */
export const EXTRACTION_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// File type filtering
// ---------------------------------------------------------------------------

/**
 * Regex for spreadsheet file extensions.
 * Files matching this pattern are EXCLUDED from LLM extraction entirely —
 * their structured data is already captured via doc_tables / NumericVerify.
 */
export const SPREADSHEET_FILE_PATTERN = /\.(xlsx|xls|xlsm|csv)$/i;

/**
 * Returns true if the filename is a spreadsheet that should skip LLM extraction.
 */
export function isSpreadsheetFile(fileName: string): boolean {
  return SPREADSHEET_FILE_PATTERN.test(fileName);
}
