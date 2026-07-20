/**
 * Shared Universal Extraction prompt and helpers.
 *
 * Used by:
 *  - server/apis/modules/universal-extract.ts (single-chunk API called from browser)
 *  - server/apis/pipeline/pipeline-core.ts (inline extraction phase for server-side runs)
 */

// ---------------------------------------------------------------------------
// Universal Extraction Prompt
//
// This single prompt consolidates the extraction needs of ALL 8 analysis
// modules. Each chunk is processed ONCE instead of 8 times. The per-module
// merge prompts then receive the relevant sections of this extraction.
// ---------------------------------------------------------------------------
export const UNIVERSAL_EXTRACTION_PROMPT = `You are a senior private equity due diligence analyst performing a comprehensive extraction on a document chunk from a deal data room. You must extract ALL information relevant to investment committee (IC) review in a single pass.

You will receive extracted text from a document chunk. Analyse the text thoroughly — pay close attention to tables, lists, and structured data that may have been flattened during PDF text extraction.

## Extraction Framework

Extract everything relevant across ALL of the following dimensions simultaneously. Be comprehensive — downstream analysis modules depend on the completeness of your extraction.

### 1. Document Classification
- Document type (CIM, IC_MEMO, CUSTOMER_DATA, CONSULTANT_REPORT, FINANCIAL_MODEL, LEGAL, OTHER)
- Source perspective (deal_team, management, third_party, unclear)

### 2. Key Claims & Assertions
For each claim found, capture:
- The claim itself (precise statement)
- Claim type: "thesis" | "risk_mitigant" | "explicit_assumption" | "implicit_assumption" | "narrative" | "data_point" | "weak_point"
- Source type: "narrative" (CIM, IC memo, management presentation) or "data" (financial model, customer data, consultant report, QoE)
- Location within the document (section, page, table name)
- Confidence in your extraction accuracy ("high" | "medium" | "low")
- Which PE diligence dimension it relates to: "commercial" | "financial" | "management" | "technology" | "legal" | "competitive" | "customer" | "operational" | "exit" | "esg" | "multiple"

### 3. Quantitative Data Points
For each metric/data point:
- Metric name
- Value (exact figure)
- Context (why this matters)
- Category: "revenue" | "margin" | "customer" | "cost" | "capital" | "financing" | "entry_exit" | "returns" | "operational" | "other"
- Whether stated explicitly or derived
- Perspective: "deal_team" | "management" | "unclear"

### 4. Flags & Risks
For each flag identified:
- Type: "risk" | "gap" | "contradiction" | "assumption" | "omission"
- Description (direct statement of the issue)
- Severity: "critical" | "moderate" | "low"

### 5. Omissions & Missing Information
- Missing data, sections, time periods, benchmarks, or risk factors that should be present
- Cross-reference against PE checklist: customer concentration, churn/retention, key man risk, revenue recognition, regulatory exposure, competitive response, management incentives, exit assumptions, QoE items, capex requirements

### 6. Competitive & Market Context
- Named competitors and positioning claims
- Market size/TAM figures and their basis
- Industry trend narratives

### 7. Management & Leadership
- Named individuals, titles, background claims
- Key person dependencies
- Retention arrangements

### 8. Customer & Revenue Details
- Named customers, concentration data
- Contract durations, churn/retention figures
- NPS, CSAT, or satisfaction scores

### 9. Reputation & Social Signals
- Social media or web presence references
- Employee/culture claims (headcount, satisfaction, Glassdoor mentions)
- Brand/marketing claims
- Any acknowledged reputation risks

### 10. Legal & Regulatory
- Compliance status, pending litigation
- Regulatory risk, licensing requirements

## Output Rules

Return ONLY a valid JSON object. No text before or after.

Be precise and dense — every word should carry information:
- Each claim should be a single clear statement — no filler, no restating context.
- "claim" states WHAT is claimed. "location" states WHERE. Do not repeat one in the other.
- "description" in flags states the gap directly — do not explain why it matters.

Required top-level keys:
- "document_name" (string)
- "document_type" (string): CIM | IC_MEMO | CUSTOMER_DATA | CONSULTANT_REPORT | FINANCIAL_MODEL | LEGAL | OTHER
- "source_perspective" (string): deal_team | management | third_party | unclear
- "key_claims" (array): each with "id" (leave as empty string — will be assigned post-extraction), "claim", "claim_type", "source_type", "location", "confidence", "dimension"
- "data_points" (array): each with "metric", "value", "context", "category", "stated_or_derived", "perspective"
- "flags" (array): each with "type", "description", "severity"
- "omissions" (array of strings): missing items relative to PE diligence standards
- "competitive_market" (array): each with "claim", "named_competitors" (string[]), "figures_cited" (string or null)
- "management_leadership" (array): each with "name", "title", "background_claims" (string or null), "retention_detail" (string or null)
- "customer_revenue" (array): each with "customer" (string or null), "revenue_share" (string or null), "contract_detail" (string or null), "metric_cited" (string or null)
- "reputation_social" (array): each with "claim", "platform_or_source" (string or null), "metric_cited" (string or null)
- "legal_regulatory" (array): each with "topic", "detail"
- "stated_risks" (array): each with "risk", "mitigant_offered" (string or null)
- "raw_summary" (string): 3-4 dense sentences covering the most material findings`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inject stable claim IDs into the extraction JSON.
 * Format: "c{chunkIndex}-{claimIndex}" (0-based).
 * This happens post-extraction so IDs are deterministic and don't depend on
 * the model remembering to output them.
 */
export function injectClaimIds(rawJson: string, chunkIndex: number): string {
  try {
    let jsonStr = rawJson.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    } else if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, "");
    }

    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed.key_claims)) {
      parsed.key_claims = parsed.key_claims.map(
        (claim: Record<string, unknown>, idx: number) => ({
          ...claim,
          id: `c${chunkIndex}-${idx}`,
        })
      );
    }
    return JSON.stringify(parsed);
  } catch {
    return rawJson;
  }
}

/**
 * Replace curly braces with fullwidth equivalents to avoid template injection.
 */
export function sanitizeBraces(text: string): string {
  if (!text) return text;
  return text.replace(/\{/g, "\uFE5B").replace(/\}/g, "\uFE5C");
}

// ---------------------------------------------------------------------------
// Spreadsheet detection (matches pipelineConfig.ts on the client)
// ---------------------------------------------------------------------------
const SPREADSHEET_FILE_PATTERN = /\.(xlsx|xls|xlsm|csv)$/i;

export function isSpreadsheetFile(fileName: string): boolean {
  return SPREADSHEET_FILE_PATTERN.test(fileName);
}

// ---------------------------------------------------------------------------
// Content hashing (same algorithm as client)
// ---------------------------------------------------------------------------
export function computeContentHash(text: string): string {
  // Simple fast hash — same as the client's computeContentHash
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return (hash >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// Extraction settings (single source of truth for server-side extraction)
// ---------------------------------------------------------------------------

/** Claude model used for universal extraction. */
export const EXTRACTION_MODEL = "claude-haiku-4-5-20251001";

/** Number of concurrent LLM extraction calls per batch. */
export const EXTRACTION_CONCURRENCY = 8; // Reduced from 12 to limit account-level rate-limit pressure

// ---------------------------------------------------------------------------
// Chunking
// ⚠️  KEEP IN SYNC with client/lib/pipelineConfig.ts CHUNK_CHARS.
//     Client and server cannot share an import across the build boundary.
//     If these diverge, chunk-index mismatches corrupt the extraction cache.
// ---------------------------------------------------------------------------
export const CHUNK_CHARS = 5_000;

export interface TextChunk {
  label: string;
  sourceFile: string;
  text: string;
  documentId: string;
  chunkIndex: number;
  contentHash: string;
}

/**
 * Split a document's parsed_text into fixed-size chunks.
 */
export function chunkDocument(
  fileName: string,
  documentId: string,
  parsedText: string
): TextChunk[] {
  const chunks: TextChunk[] = [];
  if (parsedText.length <= CHUNK_CHARS) {
    chunks.push({
      label: fileName,
      sourceFile: fileName,
      text: parsedText,
      documentId,
      chunkIndex: 0,
      contentHash: computeContentHash(parsedText),
    });
  } else {
    let start = 0;
    let idx = 0;
    while (start < parsedText.length) {
      const end = Math.min(start + CHUNK_CHARS, parsedText.length);
      const slice = parsedText.slice(start, end);
      chunks.push({
        label: `${fileName} (part ${idx + 1})`,
        sourceFile: fileName,
        text: slice,
        documentId,
        chunkIndex: idx,
        contentHash: computeContentHash(slice),
      });
      start = end;
      idx++;
    }
  }
  return chunks;
}
