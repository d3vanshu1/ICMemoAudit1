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
 *
 * ⚠️  KEEP IN SYNC with server/apis/pipeline/extraction-prompt.ts CHUNK_CHARS.
 *     Client and server cannot share an import across the build boundary.
 *     If these diverge, chunk-index mismatches corrupt the extraction cache.
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
 * - Quality-critical modules (omission_audit, blind_spot_scanner, diligence_completeness)
 *   override to Sonnet at the sub-agent/merge layer.
 * - Extraction (chunking) uses Haiku — cost-effective; quality-sensitive work
 *   happens in the analysis + merge phases.
 */
export const EXTRACTION_MODEL = "claude-haiku-4-5-20251001";

/**
 * Per-module model overrides for sub-agent analysis and merge.
 * Modules listed here use Sonnet; all others use Haiku.
 */
export const SONNET_OVERRIDE_MODULES = new Set([
  "omission_audit",
  "blind_spot_scanner",
  "diligence_completeness",
]);

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
