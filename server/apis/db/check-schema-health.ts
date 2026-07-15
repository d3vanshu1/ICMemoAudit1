import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Schema Health Check
//
// Queries information_schema.columns for every column this app assumes exists.
// Returns pass/fail per column so migrations can be verified in seconds.
// ---------------------------------------------------------------------------

/**
 * All columns this application expects to exist.
 * Format: [table_name, column_name, notes]
 */
const REQUIRED_COLUMNS: [string, string, string][] = [
  // Core tables
  ["deals", "id", "PK"],
  ["deals", "name", ""],
  ["deals", "sector", ""],
  ["deals", "status", ""],
  ["deals", "updated_at", ""],
  ["documents", "id", "PK"],
  ["documents", "deal_id", "FK to deals"],
  ["documents", "file_name", ""],
  ["documents", "file_type", ""],
  ["documents", "document_tag", ""],
  ["documents", "document_source", "added in migration"],
  ["documents", "parsed_text", ""],
  ["documents", "uploaded_at", ""],
  // Module system
  ["module_runs", "id", "PK"],
  ["module_runs", "deal_id", "FK to deals"],
  ["module_runs", "module_id", ""],
  ["module_runs", "status", "enum: running/completed/failed"],
  ["module_runs", "triggered_at", "heartbeat timestamp"],
  ["module_runs", "completed_at", ""],
  ["module_runs", "numeric_report_json", "persisted numeric report for background resume — MIGRATION REQUIRED"],
  ["module_outputs", "id", "PK"],
  ["module_outputs", "module_run_id", "FK to module_runs"],
  ["module_outputs", "executive_header", ""],
  ["module_outputs", "findings", "JSONB"],
  ["module_outputs", "full_report_markdown", ""],
  // Checkpoints — extraction
  ["universal_extractions", "id", "PK"],
  ["universal_extractions", "deal_id", "FK to deals"],
  ["universal_extractions", "document_id", "FK to documents"],
  ["universal_extractions", "chunk_index", ""],
  ["universal_extractions", "content_hash", "for dedup"],
  ["universal_extractions", "extraction_json", "JSONB"],
  // Checkpoints — merge
  ["merge_checkpoints", "id", "PK"],
  ["merge_checkpoints", "module_run_id", "FK to module_runs"],
  ["merge_checkpoints", "tree_level", "merge round"],
  ["merge_checkpoints", "node_index", "group position in round"],
  ["merge_checkpoints", "merged_json", "JSONB merge result"],
  // Doc tables (numeric)
  ["doc_tables", "id", "PK"],
  ["doc_tables", "document_id", "FK to documents"],
  ["doc_tables", "sheet_or_page", ""],
  ["doc_tables", "caption", ""],
  ["doc_tables", "data", "JSONB"],
  // Numeric reports
  ["numeric_reports", "id", "PK"],
  ["numeric_reports", "module_run_id", "FK to module_runs"],
  ["numeric_reports", "figures", "JSONB"],
  ["numeric_reports", "discrepancies", "JSONB"],
  // Q&A (full-text search only — embedding/pgvector intentionally unused)
  ["document_chunks", "id", "PK"],
  ["document_chunks", "document_id", "FK to documents"],
  ["document_chunks", "chunk_index", ""],
  ["document_chunks", "content", ""],
  // NOTE: document_chunks.embedding exists in some environments but is NOT used.
  // Q&A uses tsv + websearch_to_tsquery (full-text search). No pgvector dependency.
  // Run coverage
  ["run_coverage", "id", "PK"],
  ["run_coverage", "module_run_id", "FK to module_runs"],
  ["run_coverage", "documents_included", "JSONB array"],
];

const ColumnCheckSchema = z.object({
  table_name: z.string(),
  column_name: z.string(),
});

export default api({
  name: "CheckSchemaHealth",
  description: "Verifies all expected DB columns exist via information_schema",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    healthy: z.boolean(),
    totalChecked: z.number(),
    passed: z.number(),
    failed: z.number(),
    results: z.array(z.object({
      table: z.string(),
      column: z.string(),
      notes: z.string(),
      exists: z.boolean(),
    })),
  }),

  async run(ctx) {
    // Fetch all columns in the public schema in one query
    const existingColumns = await ctx.integrations.db.query(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`,
      ColumnCheckSchema,
      [],
      { label: "Fetch all public schema columns" }
    );

    // Build a lookup set for O(1) checks
    const columnSet = new Set(
      existingColumns.map((c) => `${c.table_name}.${c.column_name}`)
    );

    // Check each required column
    const results = REQUIRED_COLUMNS.map(([table, column, notes]) => ({
      table,
      column,
      notes,
      exists: columnSet.has(`${table}.${column}`),
    }));

    const passed = results.filter((r) => r.exists).length;
    const failed = results.filter((r) => !r.exists).length;

    if (failed > 0) {
      ctx.log.warn(
        `[SchemaHealth] ${failed} missing column(s): ${results
          .filter((r) => !r.exists)
          .map((r) => `${r.table}.${r.column}`)
          .join(", ")}`
      );
    }

    return {
      healthy: failed === 0,
      totalChecked: REQUIRED_COLUMNS.length,
      passed,
      failed,
      results,
    };
  },
});
