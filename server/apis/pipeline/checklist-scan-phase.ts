/**
 * Checklist Scan Phase — exhaustive per-category retrieval across all deal documents.
 *
 * For each DILIGENCE_CHECKLIST category, runs multiple full-text search queries
 * against document_chunks and builds a structured coverage map:
 *  - Which categories have evidence (and where)
 *  - Which categories have NO hits across all queries and all documents
 *
 * The coverage map is injected into the merge prompt as authoritative ground truth,
 * preventing the merge layer from asserting "data room-wide absence" when the
 * information actually exists but wasn't in a particular sub-agent's chunk.
 *
 * Version-awareness: searches hit ALL chunks regardless of document version.
 * If "2nd IC Memo" and "3rd IC Memo" both mention retention, both are surfaced.
 */
import { z } from "@superblocksteam/sdk-api";
import { DILIGENCE_CHECKLIST, type ChecklistCategory } from "./diligence-checklist.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CategoryHit {
  query: string;
  fileName: string;
  chunkIndex: number;
  snippet: string; // First 300 chars of matching content
  rank: number;
}

export interface CategoryCoverage {
  categoryId: string;
  categoryLabel: string;
  status: "covered" | "not_found";
  hits: CategoryHit[];
  queriesRun: number;
  totalHits: number;
}

export interface ChecklistScanResult {
  categories: CategoryCoverage[];
  coveredCount: number;
  notFoundCount: number;
  totalQueries: number;
  scanDurationMs: number;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ChunkHitSchema = z.object({
  file_name: z.string(),
  chunk_index: z.coerce.number(),
  content: z.string(),
  rank: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Max hits to retrieve per query (enough to confirm coverage without bloating) */
const HITS_PER_QUERY = 5;

/** Max snippet length for evidence */
const SNIPPET_LENGTH = 300;

/** Concurrency for category scans (each category = 2-3 DB queries) */
const SCAN_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface ScanContext {
  integrations: {
    db: {
      query: (sql: string, schema: any, params: any[], meta?: { label: string }) => Promise<any[]>;
    };
  };
}

/**
 * Runs the full checklist scan for a deal. Executes all category queries
 * against document_chunks and returns the structured coverage map.
 *
 * Evidence pool = ALL documents for the deal EXCEPT the run’s selected subject ID(s).
 * Prior IC memos ARE included — they are valid evidence (tagged `independent: false`
 * downstream so the report distinguishes team-authored vs external evidence).
 */
export async function runChecklistScan(
  ctx: ScanContext,
  dealId: string,
  subjectDocumentIds: string[] = []
): Promise<ChecklistScanResult> {
  const startTime = Date.now();
  let totalQueries = 0;

  // Process categories in parallel batches
  const results: CategoryCoverage[] = [];

  for (let i = 0; i < DILIGENCE_CHECKLIST.length; i += SCAN_CONCURRENCY) {
    const batch = DILIGENCE_CHECKLIST.slice(i, i + SCAN_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(category => scanCategory(ctx, dealId, category, subjectDocumentIds))
    );
    for (const r of batchResults) {
      totalQueries += r.queriesRun;
      results.push(r);
    }
  }

  const coveredCount = results.filter(r => r.status === "covered").length;
  const notFoundCount = results.filter(r => r.status === "not_found").length;

  return {
    categories: results,
    coveredCount,
    notFoundCount,
    totalQueries,
    scanDurationMs: Date.now() - startTime,
  };
}

/**
 * Scans a single category — runs all its queries and aggregates hits.
 * Only the selected subject document ID(s) are excluded from evidence.
 */
async function scanCategory(
  ctx: ScanContext,
  dealId: string,
  category: ChecklistCategory,
  subjectDocumentIds: string[]
): Promise<CategoryCoverage> {
  const allHits: CategoryHit[] = [];

  for (const query of category.queries) {
    try {
      const rows = await ctx.integrations.db.query(
        `SELECT
           dc.file_name,
           dc.chunk_index,
           dc.content,
           ts_rank_cd(dc.tsv, q) AS rank
         FROM document_chunks dc,
              websearch_to_tsquery('english', $2) q
         WHERE dc.deal_id = $1
           AND dc.tsv @@ q
           AND dc.document_id != ALL($4::uuid[])
         ORDER BY rank DESC
         LIMIT $3`,
        ChunkHitSchema,
        [dealId, query, HITS_PER_QUERY, subjectDocumentIds.length > 0 ? subjectDocumentIds : ['00000000-0000-0000-0000-000000000000']],
        { label: `Checklist scan: ${category.id} — "${query.slice(0, 50)}"` }
      );

      for (const row of rows) {
        allHits.push({
          query,
          fileName: row.file_name,
          chunkIndex: row.chunk_index,
          snippet: row.content.slice(0, SNIPPET_LENGTH),
          rank: row.rank,
        });
      }
    } catch (err) {
      // Log but don't fail the whole scan for one bad query
      console.warn(`[checklist-scan] Query failed for ${category.id}: "${query}"`, err);
    }
  }

  // Deduplicate hits by (fileName, chunkIndex) — same chunk may match multiple queries
  const seen = new Set<string>();
  const deduped: CategoryHit[] = [];
  for (const hit of allHits) {
    const key = `${hit.fileName}:${hit.chunkIndex}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(hit);
    }
  }

  // Sort by rank descending — best evidence first
  deduped.sort((a, b) => b.rank - a.rank);

  return {
    categoryId: category.id,
    categoryLabel: category.label,
    status: deduped.length > 0 ? "covered" : "not_found",
    hits: deduped.slice(0, 10), // Keep top 10 unique chunks per category
    queriesRun: category.queries.length,
    totalHits: deduped.length,
  };
}

/**
 * Formats the scan result into a structured text block for injection into merge prompts.
 * This is the authoritative "COVERAGE MAP" the merge layer receives.
 */
export function formatCoverageMapForPrompt(scan: ChecklistScanResult): string {
  const lines: string[] = [
    "## DEAL ROOM COVERAGE MAP — AUTHORITATIVE GROUND TRUTH",
    "",
    "The following coverage scan was run against ALL document chunks in the deal room",
    "using multiple search queries per category. This is FACTUAL — do NOT contradict it.",
    "",
    `Scan: ${scan.totalQueries} queries across ${scan.categories.length} categories.`,
    `Result: ${scan.coveredCount} categories COVERED, ${scan.notFoundCount} categories NOT FOUND.`,
    "",
  ];

  // First: categories with evidence (prevents false "missing" claims)
  // Fix 1: Include verbatim source snippets so the merge layer can anchor findings
  const covered = scan.categories.filter(c => c.status === "covered");
  if (covered.length > 0) {
    lines.push("### CONFIRMED PRESENT in the deal room (DO NOT flag as missing):");
    lines.push("");
    for (const cat of covered) {
      const docs = [...new Set(cat.hits.map(h => h.fileName))];
      lines.push(`- **${cat.categoryLabel}** — found in: ${docs.join(", ")} (${cat.totalHits} matching chunks)`);
      // Include top 3 verbatim snippets as anchoring evidence
      const topHits = cat.hits.slice(0, 3);
      for (const hit of topHits) {
        if (hit.snippet) {
          lines.push(`  > [${hit.fileName}, chunk ${hit.chunkIndex}]: "${hit.snippet}"`);
        }
      }
    }
    lines.push("");
  }

  // Second: categories with no hits (legitimate gaps to investigate)
  const notFound = scan.categories.filter(c => c.status === "not_found");
  if (notFound.length > 0) {
    lines.push("### NOT FOUND in ANY deal room document (legitimate gap candidates):");
    lines.push("");
    for (const cat of notFound) {
      lines.push(`- **${cat.categoryLabel}** — 0 hits across ${cat.queriesRun} queries. Queries tried: ${cat.hits.length === 0 ? category_queries(cat.categoryId) : "N/A"}`);
    }
    lines.push("");
    lines.push("IMPORTANT: Only categories listed here as NOT FOUND may be reported as deal-room-wide omissions.");
    lines.push("Categories listed as CONFIRMED PRESENT must NOT be flagged as missing — they exist in the documents listed above.");
  }

  return lines.join("\n");
}

/** Helper to retrieve query strings for a category */
function category_queries(categoryId: string): string {
  const cat = DILIGENCE_CHECKLIST.find(c => c.id === categoryId);
  if (!cat) return "unknown";
  return cat.queries.map(q => `"${q}"`).join(", ");
}
