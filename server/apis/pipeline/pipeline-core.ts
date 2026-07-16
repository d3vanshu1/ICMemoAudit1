/**
 * Pipeline Core Logic — shared between RunModulePipeline and ResumeStalePipelines.
 *
 * This is a plain exported function (not an api() wrapper) that contains the
 * full analysis → merge → complete flow with checkpointing. Both the client-driven
 * API and the background safety-net call this same code path.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * INVARIANTS — assumptions this code depends on. Breaking any one silently breaks
 * the pipeline or causes data loss. Update this list when adding new assumptions.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 1. EXIT-WRITE GUARD: The UPDATE at completion uses
 *    `WHERE id = $1 AND status = 'running'::module_status`
 *    so a cancelled/purged run can never be resurrected by a late-finishing pipeline.
 *
 * 2. CACHE-HIT EXCLUSION OF FAILED ENTRIES: When checking if an extraction
 *    already exists (cache hit), entries with `failed: true` MUST be excluded.
 *    Otherwise the pipeline treats a previous failure as "already done" and
 *    skips the chunk permanently.
 *
 * 3. NUMERIC MODULES REQUIRE A PERSISTED REPORT BEFORE BACKGROUND RESUME:
 *    `contradiction_check` and `model_assumptions_stress` expect a numeric report
 *    passed as input. The background runner (ResumeStalePipelines) must verify
 *    `numeric_report_json IS NOT NULL` before claiming; if absent, skip without
 *    refreshing `triggered_at` (see item 3 fix — pre-claim check).
 *
 * 4. PER-CALL TIMEOUT ON LLM REQUESTS: `callAnthropic` uses a 120s per-call
 *    timeout via Promise.race. Without this, a single hanging Anthropic call
 *    blocks the entire time budget and the pipeline never returns `in_progress`.
 *
 * 5. TIME_BUDGET_MS MUST BE < PLATFORM TIMEOUT − 60s: The platform hard-kills
 *    APIs at 300s. TIME_BUDGET_MS = 200s ensures we have headroom for checkpoint
 *    writes, DB overhead, and the final status update.
 *
 * 6. MERGE CHECKPOINT DE-DUPLICATION: When resuming, existing checkpoints for a
 *    given (run_id, round, group_index) are loaded and skipped. The pipeline must
 *    never re-process a group that already has a checkpoint row.
 *
 * 7. RESPONSE PAYLOAD CAP: `mergedText` is capped at 150K chars before returning
 *    to prevent exceeding the 4MB gRPC transport limit. FormatReport uses its own
 *    context-window truncation anyway.
 *
 * 8. FAILED EXTRACTIONS ARE PERSISTED WITH failed:true: When `universalExtract`
 *    fails after retries, the extraction is saved to `universal_extractions` WITH
 *    `failed: true` in its `extraction_json`. This enables invariant #2: the cache-
 *    hit check excludes `failed: true` entries, so failed chunks are retried on the
 *    next run rather than permanently skipped.
 *
 * 9. SAVE-DOCUMENT parsedText CAP: parsedText is capped at 3.5MB in save-document.ts
 *    to prevent a single INSERT from exceeding the 4MB gRPC limit.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { z } from "@superblocksteam/sdk-api";
import { buildMergedText, type MergedFinding } from "../modules/build-merged-text.js";
import { NUMERIC_MODULES } from "../modules/constants.js";
import { SUB_AGENT_PROMPTS } from "../modules/analyze-chunk.js";
import { MERGE_PROMPTS, FINDINGS_RULE_FINAL, FINDINGS_RULE_INTERMEDIATE } from "../modules/merge-findings.js";
import { runPostCompletionAudit } from "./post-completion-audit.js";
import { runExtractionPhase } from "./extraction-phase.js";
import { runDocTablesPhase } from "./doc-tables-phase.js";
import { runNumericVerifyInline } from "./numeric-verify-inline.js";
import { runCleanParsedTextPhase } from "./clean-parsed-text.js";
import { runWebResearchPhase } from "./web-research-phase.js";
import type { NumericVerifyResult } from "./numeric-verify-inline.js";

// ---------------------------------------------------------------------------
// Models & Config
// ---------------------------------------------------------------------------
const SUB_AGENT_MODEL = "claude-sonnet-4-6";
const SUB_AGENT_MAX_TOKENS = 4096;
const SONNET_MODEL = "claude-sonnet-4-6";
const OPUS_MODEL = "claude-opus-4-7";
const MERGE_MAX_TOKENS = 8000;

const ANALYSIS_CONCURRENCY = 15;
const MERGE_CONCURRENCY = 5;
const MERGE_GROUP_SIZE = 4;
const MAX_MERGE_GROUP_FAILURES = 3; // Skip (use fallback) after this many error checkpoints across invocations
const MERGE_NODE_TEXT_CAP = 3000; // Max chars per node's text in merge input — prevents token overflow
const TIME_BUDGET_MS = 200_000; // 3m20s — gives 100s headroom under platform's 300s API timeout
// NOTE: Reduced from 250s because paginated extraction loading, checkpoint saves,
// and DB overhead were pushing total wall-clock past the 300s platform limit.

/** Modules that go through the web research phase instead of direct analysis */
const WEB_RESEARCH_MODULES = new Set(["external_risk_overlay", "social_reputation"]);

// ---------------------------------------------------------------------------
// Chunk Routing (server-side mirror of client/lib/chunkRouting.ts)
// ---------------------------------------------------------------------------
const MODULE_TAG_RELEVANCE: Record<string, Set<string>> = {
  omission_audit: new Set(["cim", "ic_memo", "customer_data", "consultant_report", "financial_model", "legal", "other"]),
  contradiction_check: new Set(["cim", "ic_memo", "customer_data", "consultant_report", "financial_model", "legal", "other"]),
  blind_spot_scanner: new Set(["cim", "ic_memo", "consultant_report", "financial_model", "other"]),
  external_risk_overlay: new Set(["cim", "ic_memo", "customer_data", "consultant_report", "legal", "other"]),
  social_reputation: new Set(["cim", "ic_memo", "consultant_report", "customer_data", "other"]),
  ic_challenge_mode: new Set(["cim", "ic_memo", "consultant_report", "financial_model", "other"]),
  model_assumptions_stress: new Set(["ic_memo", "financial_model", "cim", "consultant_report", "other"]),
  diligence_completeness: new Set(["cim", "ic_memo", "customer_data", "consultant_report", "financial_model", "legal", "other"]),
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const ExtractionRowSchema = z.object({
  document_id: z.string(),
  chunk_index: z.coerce.number(),
  extraction_json: z.any(),
});

const AnalysisCheckpointSchema = z.object({
  chunk_index: z.coerce.number(),
});

const MergeCheckpointSchema = z.object({
  tree_level: z.coerce.number(),
  node_index: z.coerce.number(),
  merged_json: z.any(),
});

const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  model: z.string(),
  stop_reason: z.string().nullable(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

const RunIdSchema = z.object({ run_id: z.string() });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Integration context required by the pipeline core */
export interface PipelineContext {
  integrations: {
    db: {
      query: (sql: string, schema: z.ZodType<any>, params: unknown[], meta?: { label: string }) => Promise<any[]>;
      execute: (sql: string, params: unknown[], meta?: { label: string }) => Promise<{ rowCount: number } | void>;
    };
    ai: {
      apiRequest: (req: { method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> }, opts: { response: z.ZodType<any> }, meta?: { label: string }) => Promise<any>;
    };
  };
}

export interface PipelineInput {
  dealId: string;
  moduleId: string;
  runId?: string | null;
  useOpus?: boolean | null;
  numericReport?: { figures: any[]; discrepancies: any[] } | null;
  numericPartial?: boolean | null;
}

export interface PipelineProgress {
  analysisTotal: number;
  analysisCompleted: number;
  mergeRound: number;
  mergeTotal: number;
  mergeGroupsDone?: number;
  mergeGroupsTotal?: number;
}

export interface PipelineResult {
  status: "completed" | "in_progress" | "failed";
  runId: string;
  phase: string;
  progress: PipelineProgress;
  result: {
    executiveHeader: string;
    findings: MergedFinding[];
    mergedText: string;
  } | null;
  failedChunks?: number;
  truncatedChunks?: number; // analysis chunks where stop_reason was "max_tokens"
  truncatedMerges?: number; // merge groups where stop_reason was "max_tokens"
  firstError?: string | null;
  extractionPassStats?: {
    attemptedThisPass: number;
    succeededThisPass: number;
    failedThisPass: number;
    skippedDueToBudget: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function callAnthropic(
  ctx: PipelineContext,
  body: Record<string, unknown>,
  label: string,
  retries = 3,
  perCallTimeoutMs = 120_000 // 2 minutes default — merge calls pass dynamic value
): Promise<z.infer<typeof MessageResponseSchema>> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await Promise.race([
        ctx.integrations.ai.apiRequest(
          { method: "POST", path: "/v1/messages", body },
          { response: MessageResponseSchema },
          { label }
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Anthropic call timed out after ${perCallTimeoutMs / 1000}s: ${label}`)), perCallTimeoutMs)
        ),
      ]);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = /503|429|rate.?limit|service.?unavailable|overloaded|timed out/i.test(msg);
      if (!isRetryable || attempt === retries) throw err;
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 15000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("Unreachable");
}

function extractTag(text: string, tag: string): string {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

/**
 * Truncate a merge node's text to MERGE_NODE_TEXT_CAP chars.
 * Strategy: parse the text as JSON (bare or fenced) and progressively trim
 * low-priority fields (data_points → key_claims) while preserving flags intact.
 * Falls back to simple char truncation only if parsing fails entirely.
 */
function truncateMergeNodeText(text: string, cap: number): string {
  if (text.length <= cap) return text;

  // Try to parse as structured JSON — real sub-agent output is bare JSON (no fence)
  let obj: Record<string, unknown> | null = null;
  let prefix = ""; // any text before the JSON (e.g. "### Extraction from: ...\n\n")
  let suffix = ""; // any text after
  let jsonStr = "";

  // 1. Try bare JSON parse (text is the JSON itself or starts with it after a header)
  const jsonStart = text.indexOf("{");
  if (jsonStart !== -1) {
    const candidate = text.slice(jsonStart);
    // Find the last closing brace
    const lastBrace = candidate.lastIndexOf("}");
    if (lastBrace !== -1) {
      jsonStr = candidate.slice(0, lastBrace + 1);
      try {
        obj = JSON.parse(jsonStr);
        prefix = text.slice(0, jsonStart);
        suffix = text.slice(jsonStart + lastBrace + 1);
      } catch {
        obj = null;
      }
    }
  }

  // 2. Fallback: try fenced ```json block (covers any format drift)
  if (!obj) {
    const jsonMatch = text.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        obj = JSON.parse(jsonMatch[1]);
        jsonStr = jsonMatch[1];
        const matchStart = text.indexOf(jsonMatch[0]);
        prefix = text.slice(0, matchStart);
        suffix = text.slice(matchStart + jsonMatch[0].length);
      } catch {
        obj = null;
      }
    }
  }

  // If we have a parsed object, do structured trimming
  if (obj) {
    const rebuild = (o: Record<string, unknown>): string =>
      prefix + JSON.stringify(o, null, 2) + suffix;

    // Priority: flags > key_claims > raw_summary > data_points
    // Remove data_points first (usually the largest field)
    if (obj.data_points && Array.isArray(obj.data_points)) {
      const dpCount = (obj.data_points as unknown[]).length;
      // Progressively trim data_points until under cap
      for (let keep = Math.floor(dpCount / 2); keep >= 0; keep -= Math.max(1, Math.floor(dpCount / 4))) {
        const trimmed = { ...obj, data_points: (obj.data_points as unknown[]).slice(0, keep) };
        const built = rebuild(trimmed);
        if (built.length <= cap) {
          const note = keep < dpCount
            ? `\n\n[NOTE: ${dpCount - keep} data_points trimmed — flags and claims preserved in full]`
            : "";
          return built + note;
        }
      }
      // data_points fully removed, still too long — try trimming key_claims
      const withoutDp = { ...obj };
      delete withoutDp.data_points;

      if (withoutDp.key_claims && Array.isArray(withoutDp.key_claims)) {
        const claimCount = (withoutDp.key_claims as unknown[]).length;
        const keepClaims = Math.ceil(claimCount / 2);
        const trimmed = { ...withoutDp, key_claims: (withoutDp.key_claims as unknown[]).slice(0, keepClaims) };
        const built = rebuild(trimmed);
        if (built.length <= cap) {
          return built + `\n\n[NOTE: Trimmed to ${keepClaims}/${claimCount} claims, removed data_points — flags preserved]`;
        }
      }

      // Still too long — keep only flags + raw_summary (the minimum for merge synthesis)
      const minimal: Record<string, unknown> = {};
      if (obj.document_name) minimal.document_name = obj.document_name;
      if (obj.document_type) minimal.document_type = obj.document_type;
      if (obj.flags) minimal.flags = obj.flags;
      if (obj.raw_summary) minimal.raw_summary = obj.raw_summary;
      const built = rebuild(minimal);
      if (built.length <= cap) {
        return built + `\n\n[NOTE: Kept only flags + raw_summary — data_points and key_claims removed]`;
      }
    }
  }

  // Hard truncation fallback — only reached if JSON parsing failed or flags alone exceed cap
  return text.slice(0, cap) + `\n\n[...TRUNCATED from ${text.length} chars to ${cap} — full text available in extraction checkpoint]`;
}

// Exported for testing
export { truncateMergeNodeText as _truncateMergeNodeText };

// ---------------------------------------------------------------------------
// Core Pipeline Function
// ---------------------------------------------------------------------------
export async function runPipelineCore(ctx: PipelineContext, input: PipelineInput): Promise<PipelineResult> {
  const startTime = Date.now();
  const timeRemaining = () => TIME_BUDGET_MS - (Date.now() - startTime);

  const { dealId, moduleId, useOpus } = input;
  // numericReport and numericPartial are mutable — they get recomputed by Step 0.7
  // (inline numeric verification) after doc_tables backfill, closing the two-run bug.
  let numericReport = input.numericReport ?? null;
  let numericPartial = input.numericPartial ?? null;

  // Look up prompts for this module
  const subAgentPrompt = SUB_AGENT_PROMPTS[moduleId];
  if (!subAgentPrompt) {
    throw new Error(`Module "${moduleId}" sub-agent prompt not configured.`);
  }

  const rawMergePrompt = MERGE_PROMPTS[moduleId];
  if (!rawMergePrompt) {
    throw new Error(`Module "${moduleId}" merge prompt not configured.`);
  }

  // --- Step 0: Create or resume run ---
  let runId: string = input.runId ?? "";
  if (!runId) {
    // Guard: prevent concurrent runs of the same module for the same deal.
    // Uses a CTE with an existence check so the INSERT only fires when no
    // running row exists. This is the app-level equivalent of a partial
    // unique index (deal_id, module_id) WHERE status = 'running'.
    let newRunRows: Array<{ run_id: string }>;
    try {
      newRunRows = await ctx.integrations.db.query(
        `WITH guard AS (
           SELECT 1 FROM module_runs
           WHERE deal_id = $1 AND module_id = $2 AND status = 'running'::module_status
           LIMIT 1
         )
         INSERT INTO module_runs (deal_id, module_id, status, numeric_report_json)
         SELECT $1, $2, 'running'::module_status, $3::jsonb
         WHERE NOT EXISTS (SELECT 1 FROM guard)
         RETURNING id AS run_id`,
        RunIdSchema,
        [dealId, moduleId, numericReport ? JSON.stringify(numericReport) : null],
        { label: "Create pipeline run (guarded, with numeric report)" }
      );
    } catch {
      // Column doesn't exist yet — insert without numeric_report_json
      newRunRows = await ctx.integrations.db.query(
        `WITH guard AS (
           SELECT 1 FROM module_runs
           WHERE deal_id = $1 AND module_id = $2 AND status = 'running'::module_status
           LIMIT 1
         )
         INSERT INTO module_runs (deal_id, module_id, status)
         SELECT $1, $2, 'running'::module_status
         WHERE NOT EXISTS (SELECT 1 FROM guard)
         RETURNING id AS run_id`,
        RunIdSchema,
        [dealId, moduleId],
        { label: "Create pipeline run (guarded, legacy)" }
      );
    }

    if (newRunRows.length === 0) {
      // A running row already exists — return the existing run's ID so the
      // caller can poll progress instead of starting a parallel run.
      const existingRun = await ctx.integrations.db.query(
        `SELECT id AS run_id FROM module_runs
         WHERE deal_id = $1 AND module_id = $2 AND status = 'running'::module_status
         ORDER BY triggered_at DESC LIMIT 1`,
        RunIdSchema,
        [dealId, moduleId],
        { label: "Find existing running run (concurrent guard)" }
      );
      if (existingRun.length > 0) {
        runId = existingRun[0].run_id;
      } else {
        // Race: the other run just completed between our check and this query.
        // Retry with a plain insert (no guard needed anymore).
        const retryRows = await ctx.integrations.db.query(
          `INSERT INTO module_runs (deal_id, module_id, status)
           VALUES ($1, $2, 'running'::module_status)
           RETURNING id AS run_id`,
          RunIdSchema,
          [dealId, moduleId],
          { label: "Create pipeline run (retry after guard race)" }
        );
        runId = retryRows[0].run_id;
      }
    } else {
      runId = newRunRows[0].run_id;
    }
  } else {
    // Only resume runs that are still in 'running' status.
    // Completed or failed runs must NOT be resurrected — that causes the
    // "zombie run" bug where terminated runs get re-opened.
    const currentStatus = await ctx.integrations.db.query(
      `SELECT status FROM module_runs WHERE id = $1 LIMIT 1`,
      z.object({ status: z.string() }),
      [runId],
      { label: "Check run status before resume" }
    );

    if (currentStatus.length === 0) {
      throw new Error(`Run ${runId} not found`);
    }

    const status = currentStatus[0].status;
    if (status === "completed") {
      // Already done — return immediately with a synthetic completed result
      // so the caller knows not to keep polling.
      return {
        status: "completed",
        runId,
        phase: "done",
        progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
        result: null, // Caller should load output from module_outputs
        failedChunks: 0,
        truncatedChunks: 0,
        truncatedMerges: 0,
        firstError: null,
      };
    }

    if (status === "failed" || status === "cancelled") {
      // Terminated — don't resurrect. Return the terminal state.
      return {
        status: "failed",
        runId,
        phase: "terminated",
        progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
        result: null,
        failedChunks: 0,
        truncatedChunks: 0,
        truncatedMerges: 0,
        firstError: `Run was already ${status} — cannot resume`,
      };
    }

    // Status is 'running' — refresh triggered_at to claim ownership
    // Also persist numeric report if provided (so background job can use it)
    try {
      await ctx.integrations.db.execute(
        `UPDATE module_runs SET triggered_at = now(), numeric_report_json = COALESCE($2::jsonb, numeric_report_json) WHERE id = $1`,
        [runId, numericReport ? JSON.stringify(numericReport) : null],
        { label: "Resume run — refresh triggered_at + persist numeric report" }
      );
    } catch {
      // numeric_report_json column may not exist yet — fallback to plain heartbeat
      await ctx.integrations.db.execute(
        `UPDATE module_runs SET triggered_at = now() WHERE id = $1`,
        [runId],
        { label: "Resume run — refresh triggered_at (legacy)" }
      );
    }
  }

  // --- Step 0.4: Clean corrupted parsed_text (phantom columns from old parser) ---
  // Detects and trims phantom columns from spreadsheet documents whose parsed_text
  // was generated by the pre-used-range-fix parser. Idempotent: clean docs are no-ops.
  // Backs up original text to parsed_text_backups table before any writes.
  // TIME-BUDGET AWARE: Will stop between documents and return partial if budget exceeded.
  const cleanResult = await runCleanParsedTextPhase(ctx.integrations.db, {
    dealId,
    dryRun: false,
    startTime,
    timeBudgetMs: TIME_BUDGET_MS,
  });
  if (cleanResult.corruptedCount > 0) {
    console.log(`[Step 0.4] Cleaned ${cleanResult.corruptedCount} document(s), saved ${(cleanResult.totalBytesSaved / 1_000_000).toFixed(1)}MB`);
  }
  if (cleanResult.partial) {
    // Time budget consumed by cleanup — return in_progress so caller re-invokes.
    // Naturally resumable: cleaned docs won't be detected as corrupted next time.
    return {
      status: "in_progress",
      runId,
      phase: "cleanup",
      progress: {
        analysisTotal: cleanResult.documentsTotal,
        analysisCompleted: cleanResult.documentsProcessed,
        mergeRound: 0,
        mergeTotal: 0,
      },
      result: null,
      failedChunks: 0,
      truncatedChunks: 0,
      truncatedMerges: 0,
      firstError: null,
    };
  }

  // --- Step 0.5: Ensure extractions exist (self-sufficient extraction phase) ---
  // ALWAYS run extraction gap-fill regardless of analysis state.
  // Requirement: full extraction data must exist before merge proceeds.
  const extractionResult = await runExtractionPhase(ctx, dealId, startTime);
  if (extractionResult.needed && !extractionResult.completed) {
    // Time budget consumed by extraction — return in_progress so caller re-invokes
    return {
      status: "in_progress",
      runId,
      phase: "extraction",
      progress: {
        analysisTotal: extractionResult.totalChunks,
        analysisCompleted: extractionResult.extractedSoFar,
        mergeRound: 0,
        mergeTotal: 0,
      },
      result: null,
      failedChunks: extractionResult.failedChunks,
      truncatedChunks: 0,
      truncatedMerges: 0,
      firstError: extractionResult.firstError,
      extractionPassStats: extractionResult.passStats,
    };
  }

  // --- Step 0.6: Ensure doc_tables is populated for spreadsheet documents ---
  // Same self-sufficiency pattern as extraction phase. Pure CPU (no LLM calls),
  // completes in seconds. If doc_tables is already populated, this is a no-op.
  const docTablesResult = await runDocTablesPhase(ctx, dealId);
  if (docTablesResult.needed && docTablesResult.warnings.length > 0) {
    console.log(`[DocTablesPhase] Warnings: ${docTablesResult.warnings.join("; ")}`);
  }

  // --- Step 0.7: Inline numeric verification (recomputes after backfill) ---
  // For numeric modules, run the arithmetic engine NOW — after doc_tables is
  // guaranteed populated — and use the fresh result regardless of what the
  // client may have passed in. This closes the two-run bug where client-side
  // NumericVerify ran before backfill and found nothing.
  if (NUMERIC_MODULES.has(moduleId)) {
    // Time budget for numeric: give it up to 60s from whatever remains,
    // but never less than 15s (at which point it's not worth starting).
    const numericTimeBudget = Math.min(60_000, Math.max(0, timeRemaining() - 60_000));
    if (numericTimeBudget >= 15_000) {
      try {
        const inlineResult: NumericVerifyResult = await runNumericVerifyInline(
          ctx.integrations.db,
          dealId,
          numericTimeBudget
        );

        // Replace the input-provided report with the fresh server-side result
        if (inlineResult.figures.length > 0 || inlineResult.discrepancies.length > 0) {
          numericReport = {
            figures: inlineResult.figures,
            discrepancies: inlineResult.discrepancies,
          };
          numericPartial = inlineResult.partial;
          console.log(
            `[NumericInline] Replaced client report: ${inlineResult.figures.length} figures, ` +
            `${inlineResult.discrepancies.length} discrepancies, partial=${inlineResult.partial}`
          );
        } else if (!numericReport) {
          // No data from inline either — ensure downstream knows
          numericReport = null;
          numericPartial = null;
          console.log(`[NumericInline] No numeric data found for this deal.`);
        }
        // If inline returned nothing but client had data, keep client data
        // (edge case: doc_tables exist but are all oversized/unparseable)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[NumericInline] Failed (non-fatal, keeping client report if any): ${msg}`);
        // Keep whatever numericReport the client provided as fallback
      }
    } else {
      console.log(`[NumericInline] Skipped — insufficient time budget (${numericTimeBudget}ms remaining)`);
    }
  }

  // --- Step 1: Load universal extractions + route ---
  // Page sizes tuned per table to stay under the 4MB gRPC response limit.
  // Row payload varies significantly: extraction_json ~2-4KB, result_json ~3-6KB,
  // merged_json ~8-20KB. These are conservative interim heuristics — a production
  // fix would measure actual payload size and back off dynamically.
  const EXTRACTION_PAGE_SIZE = 200;  // ~2-4KB/row → ~400-800KB/page
  const ANALYSIS_PAGE_SIZE = 150;    // ~3-6KB/row → ~450-900KB/page
  const MERGE_CP_PAGE_SIZE = 75;     // ~8-20KB/row → ~600KB-1.5MB/page
  const allExtractions: Array<{ document_id: string; chunk_index: number; extraction_json: any }> = [];
  let offset = 0;
  while (true) {
    const page = await ctx.integrations.db.query(
      `SELECT document_id, chunk_index, extraction_json
       FROM universal_extractions
       WHERE deal_id = $1
       ORDER BY document_id, chunk_index
       LIMIT ${EXTRACTION_PAGE_SIZE} OFFSET ${offset}`,
      ExtractionRowSchema,
      [dealId],
      { label: `Load extractions (offset ${offset})` }
    );
    allExtractions.push(...page);
    if (page.length < EXTRACTION_PAGE_SIZE) break;
    offset += EXTRACTION_PAGE_SIZE;
  }

  const relevantTags = MODULE_TAG_RELEVANCE[moduleId] ?? new Set(["other"]);
  const routed = allExtractions.filter(row => {
    const ext = typeof row.extraction_json === "string"
      ? JSON.parse(row.extraction_json)
      : row.extraction_json;
    // Never analyze failed extractions — they contain no usable text.
    // (Defense-in-depth: the extraction gate should prevent reaching here with
    // failed chunks, but this filter protects against stale DB state or reruns.)
    if (ext.failed) return false;
    const tag = String(ext.documentTag ?? "other");
    return relevantTags.has(tag);
  });

  if (routed.length === 0) {
    await ctx.integrations.db.execute(
      `UPDATE module_runs SET status = 'failed'::module_status, completed_at = now() WHERE id = $1 AND status = 'running'::module_status`,
      [runId],
      { label: "Mark run failed — no chunks" }
    );
    return {
      status: "failed",
      runId,
      phase: "routing",
      progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
      result: null,
      firstError: "No extraction chunks matched this module's document tags (check document tagging)",
    };
  }

  // --- Step 1.5: Web Research Phase (for web research modules only) ---
  // Runs the iterative web search loop server-side with checkpointing.
  // If incomplete (budget exhausted), returns in_progress with phase "web_research".
  // If complete, iterations are loaded later and converted to analysis-compatible format.
  if (WEB_RESEARCH_MODULES.has(moduleId)) {
    const webResearchResult = await runWebResearchPhase(
      ctx,
      dealId,
      moduleId,
      runId,
      startTime,
      TIME_BUDGET_MS,
      routed
    );

    if (webResearchResult.needed && !webResearchResult.completed) {
      // Time budget consumed — return in_progress so caller re-invokes
      return {
        status: "in_progress",
        runId,
        phase: "web_research",
        progress: {
          analysisTotal: webResearchResult.totalIterations,
          analysisCompleted: webResearchResult.iterationCount,
          mergeRound: 0,
          mergeTotal: 0,
        },
        result: null,
        firstError: webResearchResult.firstError,
      };
    }
    // If completed, fall through — inject iterations as synthetic analysis checkpoints
    // so the merge step picks them up identically to normal analysis results.
    const iterRows = await ctx.integrations.db.query(
      `SELECT iteration, query, finding, confidence, platform, category, sources, materiality
       FROM web_research_iterations
       WHERE run_id = $1 AND status = 'completed'
       ORDER BY iteration`,
      z.object({
        iteration: z.coerce.number(),
        query: z.string().nullable(),
        finding: z.string().nullable(),
        confidence: z.coerce.number().nullable(),
        platform: z.string().nullable(),
        category: z.string().nullable(),
        sources: z.any().nullable(),
        materiality: z.string().nullable(),
      }),
      [runId],
      { label: "Load completed iterations for merge injection" }
    );

    // Check if analysis checkpoints already exist (idempotent resume)
    const existingAnalysis = await ctx.integrations.db.query(
      `SELECT chunk_index FROM pipeline_analysis WHERE run_id = $1 LIMIT 1`,
      z.object({ chunk_index: z.coerce.number() }),
      [runId],
      { label: "Check if iteration analysis already injected" }
    );

    if (existingAnalysis.length === 0 && iterRows.length > 0) {
      // Inject each iteration as a synthetic analysis checkpoint
      for (const row of iterRows) {
        const label = `${moduleId} iteration ${row.iteration}: ${row.query ?? "research"}`;
        const extraction = [
          `### Web Research Finding (Iteration ${row.iteration})`,
          "",
          `**Query:** ${row.query ?? "research"}`,
          row.category ? `**Category:** ${row.category}` : (row.platform ? `**Platform:** ${row.platform}` : ""),
          row.materiality ? `**Materiality:** ${row.materiality}` : "",
          `**Confidence:** ${row.confidence ?? 0}/10`,
          row.sources ? `**Sources:** ${(Array.isArray(row.sources) ? row.sources : []).join(", ")}` : "",
          "",
          row.finding ?? "No finding recorded",
        ].filter(Boolean).join("\n");

        await ctx.integrations.db.execute(
          `INSERT INTO pipeline_analysis (run_id, chunk_index, result_json)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (run_id, chunk_index) DO NOTHING`,
          [runId, row.iteration - 1, JSON.stringify({ label, extraction, chunkIndex: row.iteration - 1 })],
          { label: `Inject iteration ${row.iteration} as analysis` }
        );
      }
      console.log(`[WebResearch] Injected ${iterRows.length} iterations as analysis checkpoints`);
    }
  }

  // --- Step 2: Sub-agent analysis (with checkpointing) ---
  // For web research modules, iterations have already been injected as analysis
  // checkpoints above — this step will see them all as "already analyzed" and skip.
  const analyzedRows = await ctx.integrations.db.query(
    `SELECT chunk_index FROM pipeline_analysis
     WHERE run_id = $1
     ORDER BY chunk_index`,
    AnalysisCheckpointSchema,
    [runId],
    { label: "Load analysis checkpoints" }
  );
  const analyzedSet = new Set(analyzedRows.map(r => r.chunk_index));

  // For web research modules, analysis is synthetic (injected from iterations).
  // Skip the normal sub-agent loop entirely — pendingChunks is empty.
  const pendingChunks = WEB_RESEARCH_MODULES.has(moduleId)
    ? []
    : routed.filter((_, i) => !analyzedSet.has(i));
  let analysisCompleted = analyzedSet.size;
  let failedChunks = 0;
  let truncatedChunks = 0;
  let truncatedMerges = 0;
  let firstError: string | null = null;

  // Helper: return in_progress checkpoint
  const returnInProgress = (phase: "analysis" | "merge", mergeRound = 0, mergeGroupsDone = 0, mergeGroupsTotal = 0): PipelineResult => ({
    status: "in_progress",
    runId: runId!,
    phase,
    progress: {
      analysisTotal: routed.length,
      analysisCompleted,
      mergeRound,
      mergeTotal: Math.ceil(Math.log(Math.max(routed.length, 2)) / Math.log(MERGE_GROUP_SIZE)),
      mergeGroupsDone,
      mergeGroupsTotal,
    },
    result: null,
    failedChunks,
    truncatedChunks,
    truncatedMerges,
    firstError,
  });

  // Process pending chunks with dynamic batch sizing
  for (let bStart = 0; bStart < pendingChunks.length; ) {
    const remaining = timeRemaining();
    if (remaining < 60_000) {
      return returnInProgress("analysis");
    }

    const batchSize = remaining < 90_000 ? 5 : ANALYSIS_CONCURRENCY;
    const batch = pendingChunks.slice(bStart, bStart + batchSize);
    bStart += batchSize;

    const results = await Promise.allSettled(
      batch.map(async (row) => {
        const ext = typeof row.extraction_json === "string"
          ? JSON.parse(row.extraction_json)
          : row.extraction_json;

        const chunkText = String(ext.extraction ?? ext.text ?? "");
        const chunkLabel = String(ext.label ?? `Chunk ${row.chunk_index}`);
        const globalIdx = routed.indexOf(row);

        const userContent = `--- Extracted text from "${chunkLabel}" ---\n\n${chunkText}\n\nAnalyze this chunk now.`;

        const result = await callAnthropic(
          ctx,
          {
            model: SUB_AGENT_MODEL,
            max_tokens: SUB_AGENT_MAX_TOKENS,
            system: [{ type: "text", text: subAgentPrompt, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: userContent }],
          },
          `Sub-agent: ${chunkLabel} (${globalIdx + 1}/${routed.length})`
        );

        const textBlock = result.content.find((c: { type: string }) => c.type === "text");
        const extraction = `### Extraction from: ${chunkLabel}\n\n${textBlock?.text ?? ""}`;
        const truncated = result.stop_reason === "max_tokens";

        // Save checkpoint (flag truncated responses so thin findings are traceable)
        await ctx.integrations.db.execute(
          `INSERT INTO pipeline_analysis (run_id, chunk_index, result_json)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (run_id, chunk_index) DO NOTHING`,
          [runId, globalIdx, JSON.stringify({ label: chunkLabel, extraction, chunkIndex: globalIdx, truncated })],
          { label: `Save analysis checkpoint ${globalIdx}` }
        );

        return { label: chunkLabel, extraction, chunkIndex: globalIdx, truncated };
      })
    );

    // Count successes and track failures
    for (const r of results) {
      if (r.status === "fulfilled") {
        analysisCompleted++;
        if (r.value.truncated) truncatedChunks++;
      } else {
        failedChunks++;
        if (!firstError) {
          firstError = r.reason?.message ?? String(r.reason ?? "Unknown error");
        }
      }
    }

    // Refresh triggered_at so long multi-pass runs aren't purged as stale
    await ctx.integrations.db.execute(
      `UPDATE module_runs SET triggered_at = now() WHERE id = $1`,
      [runId],
      { label: "Refresh triggered_at (checkpoint heartbeat)" }
    );

    // Post-batch time check
    if (timeRemaining() < 60_000) {
      return returnInProgress("analysis");
    }
  }

  // --- Step 3: Load all analysis results for merge ---
  // Paginated: result_json holds full chunk analysis text (~3-6KB/row)
  const allAnalysis: Array<{ chunk_index: number; result_json: any }> = [];
  let analysisOffset = 0;
  while (true) {
    const page = await ctx.integrations.db.query(
      `SELECT chunk_index, result_json FROM pipeline_analysis
       WHERE run_id = $1
       ORDER BY chunk_index
       LIMIT ${ANALYSIS_PAGE_SIZE} OFFSET ${analysisOffset}`,
      z.object({ chunk_index: z.coerce.number(), result_json: z.any() }),
      [runId],
      { label: `Load analysis for merge (offset ${analysisOffset})` }
    );
    allAnalysis.push(...page);
    if (page.length < ANALYSIS_PAGE_SIZE) break;
    analysisOffset += ANALYSIS_PAGE_SIZE;
  }

  interface AnalysisNode {
    label: string;
    extraction: string;
    chunkIndex: number;
  }

  const analysisResults: AnalysisNode[] = allAnalysis.map(row => {
    const r = typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json;
    return { label: String(r.label), extraction: String(r.extraction), chunkIndex: row.chunk_index };
  });

  if (analysisResults.length === 0) {
    await ctx.integrations.db.execute(
      `UPDATE module_runs SET status = 'failed'::module_status, completed_at = now() WHERE id = $1 AND status = 'running'::module_status`,
      [runId],
      { label: "Mark run failed — no analysis results" }
    );
    return {
      status: "failed",
      runId,
      phase: "analysis",
      progress: { analysisTotal: routed.length, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
      result: null,
      failedChunks,
      firstError: firstError ?? "All chunks failed or no analysis results produced",
    };
  }

  // --- Step 4: Tree-reduce merge (with checkpointing) ---
  interface MergeNode {
    text: string;
    executiveHeader: string;
    findings: MergedFinding[];
    truncated?: boolean; // true when stop_reason was "max_tokens" — findings may be thin
  }

  // Load existing merge checkpoints (paginated: merged_json is the largest per-row payload, ~8-20KB)
  const mergeCheckpoints: Array<{ tree_level: number; node_index: number; merged_json: any }> = [];
  let mcOffset = 0;
  while (true) {
    const page = await ctx.integrations.db.query(
      `SELECT tree_level, node_index, merged_json
       FROM merge_checkpoints
       WHERE module_run_id = $1
       ORDER BY tree_level, node_index
       LIMIT ${MERGE_CP_PAGE_SIZE} OFFSET ${mcOffset}`,
      MergeCheckpointSchema,
      [runId],
      { label: `Load merge checkpoints (offset ${mcOffset})` }
    );
    mergeCheckpoints.push(...page);
    if (page.length < MERGE_CP_PAGE_SIZE) break;
    mcOffset += MERGE_CP_PAGE_SIZE;
  }

  const checkpointMap = new Map<string, MergeNode>();
  // Tracks persisted failure count per group — stored inside the error checkpoint JSON
  // itself (not row count, since ON CONFLICT DO UPDATE means only 1 row exists per group).
  const errorCountMap = new Map<string, number>();
  const errorMessageMap = new Map<string, string>(); // Preserves last error for diagnostics
  for (const cp of mergeCheckpoints) {
    const data = typeof cp.merged_json === "string" ? JSON.parse(cp.merged_json) : cp.merged_json;
    const cpKey = `${cp.tree_level}:${cp.node_index}`;
    if (data.error) {
      // failureCount is persisted in the JSON; default to 1 for legacy entries written before this field existed
      const count = typeof data.failureCount === "number" ? data.failureCount : 1;
      errorCountMap.set(cpKey, count);
      errorMessageMap.set(cpKey, String(data.error));
      continue;
    }
    checkpointMap.set(cpKey, {
      text: String(data.text ?? ""),
      executiveHeader: String(data.executiveHeader ?? ""),
      findings: (data.findings ?? []) as MergedFinding[],
      truncated: data.truncated === true,
    });
  }

  // Initialize nodes from analysis results
  let nodes: MergeNode[] = analysisResults.map(a => ({
    text: a.extraction,
    executiveHeader: "",
    findings: [],
  }));

  if (nodes.length === 1) nodes.push({ ...nodes[0] });

  const totalMergeRounds = Math.ceil(Math.log(Math.max(nodes.length, 2)) / Math.log(MERGE_GROUP_SIZE));
  let currentRound = 0;

  // Findings accumulator — collects all findings across all rounds.
  // This is the safety net: even if higher rounds fail to re-extract findings,
  // we have the full set from intermediate rounds to fall back on.
  let accumulatedFindings: MergedFinding[] = [];

  // Build numeric block for merge
  const hasNumericData = !!(numericReport && NUMERIC_MODULES.has(moduleId) &&
    (numericReport.figures.length > 0 || numericReport.discrepancies.length > 0));

  let numericBlock = "";
  if (hasNumericData && numericReport) {
    const critDisc = numericReport.discrepancies.filter((d: Record<string, unknown>) => d.severity === "critical");
    const otherDisc = numericReport.discrepancies.filter((d: Record<string, unknown>) => d.severity !== "critical");
    numericBlock = `\n\n## Numeric Verification Report\n*Source: deterministic arithmetic engine*\n\n`;
    if (numericReport.discrepancies.length > 0) {
      numericBlock += `### Discrepancies (${numericReport.discrepancies.length} total, ${critDisc.length} critical)\n`;
      for (const d of [...critDisc, ...otherDisc]) {
        const disc = d as Record<string, unknown>;
        numericBlock += `- **[${String(disc.severity).toUpperCase()}]** ${String(disc.description)}`;
        if (disc.expected != null && disc.actual != null) numericBlock += ` (expected: ${disc.expected}, reported: ${disc.actual})`;
        numericBlock += `\n`;
      }
    }
    if (numericReport.figures.length > 0) {
      numericBlock += `### Verified Figures\n`;
      const MAX_FIGURES = 200;
      if (numericReport.figures.length > MAX_FIGURES) {
        console.warn(`[pipeline-core] numeric figures capped at ${MAX_FIGURES} (had ${numericReport.figures.length})`);
      }
      for (const f of numericReport.figures.slice(0, MAX_FIGURES)) {
        const fig = f as Record<string, unknown>;
        numericBlock += `- **${String(fig.name)}**: ${fig.recomputed_value} @ ${String(fig.source_cell)}\n`;
      }
    }
  }

  // Prepare base merge prompt (numeric blocks are static, findings rule varies per round)
  let baseMergePrompt = rawMergePrompt;
  if (hasNumericData) {
    const numericVerifInst = `## NUMERIC VERIFICATION — AUTHORITATIVE GROUND TRUTH

A "## Numeric Verification Report" section appears in the input below. It contains deterministic arithmetic results produced by code — NOT by AI inference. You MUST:
- Treat every figure and discrepancy in that section as factual ground truth
- Any narrative claim that contradicts a code-verified figure is a CONFIRMED contradiction
- Cross-doc agreement discrepancies are pre-verified contradictions — report them directly as findings
- Never re-derive or contradict a code-verified figure based on text reading${numericPartial ? `

⚠️ PARTIAL COVERAGE WARNING: The numeric verification engine ran out of time and could NOT process all documents/tables in this deal. The figures and discrepancies below are correct for the tables that WERE analyzed, but ABSENCE of a discrepancy does NOT prove correctness — unverified tables may contain additional arithmetic errors. Do NOT claim "code-verified" status for any figure that does not explicitly appear in the Numeric Verification Report below.` : ""}`;
    baseMergePrompt = baseMergePrompt.replace("{{NUMERIC_VERIFICATION_BLOCK}}", numericVerifInst);
    baseMergePrompt = baseMergePrompt.replace("{{NUMERIC_TASK_STEP_1}}",
      "**Numeric Contradictions First**: Convert every discrepancy from the Numeric Verification Report into a finding.\n");
  } else {
    baseMergePrompt = baseMergePrompt.replace("{{NUMERIC_VERIFICATION_BLOCK}}", "");
    baseMergePrompt = baseMergePrompt.replace("{{NUMERIC_TASK_STEP_1}}", "");
  }

  while (nodes.length > 1) {
    currentRound++;

    if (timeRemaining() < 60_000) {
      return returnInProgress("merge", currentRound - 1, 0, 0);
    }

    const groups: Array<{ idx: number; members: MergeNode[] }> = [];
    for (let g = 0; g < Math.ceil(nodes.length / MERGE_GROUP_SIZE); g++) {
      groups.push({ idx: g, members: nodes.slice(g * MERGE_GROUP_SIZE, (g + 1) * MERGE_GROUP_SIZE) });
    }

    // Determine if this is the final round (will produce 1 node)
    const isFinalRound = groups.length === 1 || currentRound === totalMergeRounds;
    const findingsRule = isFinalRound ? FINDINGS_RULE_FINAL : FINDINGS_RULE_INTERMEDIATE;
    const mergePrompt = baseMergePrompt.replace("{{FINDINGS_REQUIREMENT}}", findingsRule);

    const nextNodes: MergeNode[] = new Array(groups.length);
    const totalGroupsThisRound = groups.length;
    let groupsDone = 0;
    let mergeFailedGroups = 0;
    let mergeFirstError: string | null = null;

    // Separate trivial groups (single member or already checkpointed) from groups needing AI merge
    const pendingGroups: Array<{ idx: number; members: MergeNode[] }> = [];
    for (const group of groups) {
      if (group.members.length === 1) {
        nextNodes[group.idx] = group.members[0];
        groupsDone++;
        continue;
      }
      const cpKey = `${currentRound}:${group.idx}`;
      if (checkpointMap.has(cpKey)) {
        nextNodes[group.idx] = checkpointMap.get(cpKey)!;
        groupsDone++;
        continue;
      }
      // Skip groups that have failed too many times — use fallback immediately
      const priorFailures = errorCountMap.get(cpKey) ?? 0;
      if (priorFailures >= MAX_MERGE_GROUP_FAILURES) {
        const lastError = errorMessageMap.get(cpKey) ?? "unknown";
        console.warn(`[pipeline] Skipping group R${currentRound}:G${group.idx} — ${priorFailures} prior failures (last: ${lastError.slice(0, 120)}), using fallback`);
        const memberFindings = group.members.flatMap(m => m.findings ?? []);
        accumulatedFindings.push(...memberFindings);
        const fallback: MergeNode = { text: group.members[0].text, executiveHeader: "Merge skipped (repeated failures)", findings: memberFindings };
        nextNodes[group.idx] = fallback;
        groupsDone++;
        // Save a non-error checkpoint so the group is permanently resolved
        await ctx.integrations.db.execute(
          `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE SET merged_json = $4::jsonb`,
          [runId, currentRound, group.idx, JSON.stringify({ text: fallback.text, executiveHeader: fallback.executiveHeader, findings: fallback.findings, skippedAfterFailures: priorFailures, lastError })],
          { label: `Save fallback checkpoint R${currentRound}:G${group.idx} (skipped after ${priorFailures} failures)` }
        );
        continue;
      }
      pendingGroups.push(group);
    }

    // Process pending groups in batches (parallel within batch, sequential across batches)
    for (let bStart = 0; bStart < pendingGroups.length; ) {
      if (timeRemaining() < 60_000) {
        return returnInProgress("merge", currentRound - 1, groupsDone, totalGroupsThisRound);
      }

      const batchSize = timeRemaining() < 90_000 ? Math.min(3, MERGE_CONCURRENCY) : MERGE_CONCURRENCY;
      const batch = pendingGroups.slice(bStart, bStart + batchSize);
      bStart += batchSize;

      const results = await Promise.allSettled(
        batch.map(async (group) => {
          const setBlocks = group.members.map((m, i) => `## Analysis Set ${i + 1}\n\n${truncateMergeNodeText(m.text, MERGE_NODE_TEXT_CAP)}`);
          const mergeInput = setBlocks.join("\n\n---\n\n") + numericBlock;

          // Dynamic timeout: use at most 80s per attempt, and at most 2 attempts.
          // Worst case = 160s which leaves 40s headroom in the 200s budget.
          // The timeRemaining guard ensures we never exceed the platform limit.
          const perCallTimeout = Math.min(80_000, Math.max(30_000, timeRemaining() - 30_000));
          const mergeResult = await callAnthropic(
            ctx,
            {
              model: useOpus ? OPUS_MODEL : SONNET_MODEL,
              max_tokens: MERGE_MAX_TOKENS,
              system: [{ type: "text", text: mergePrompt, cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: mergeInput }],
            },
            `Merge R${currentRound} G${group.idx + 1}/${totalGroupsThisRound}`,
            2, // 2 attempts, 1 retry
            perCallTimeout
          );

          const mergeText = mergeResult.content.find((c: { type: string }) => c.type === "text")?.text ?? "";
          const truncated = mergeResult.stop_reason === "max_tokens";
          const executiveHeader = extractTag(mergeText, "executive_header") || "Analysis complete.";
          const findingsRaw = extractTag(mergeText, "findings_json");

          let findings: MergedFinding[] = [];
          if (findingsRaw) {
            try {
              const parsed = JSON.parse(findingsRaw);
              if (Array.isArray(parsed)) {
                findings = parsed.map((f: Record<string, unknown>) => ({
                  severity: (f.severity === "critical" || f.severity === "warning" || f.severity === "info") ? f.severity : "info",
                  title: String(f.title ?? "Untitled"),
                  detail: String(f.detail ?? ""),
                  full_analysis: String(f.full_analysis ?? f.detail ?? ""),
                  source_docs: Array.isArray(f.source_docs) ? f.source_docs.map(String) : [],
                  ...(Array.isArray(f.claim_ids) && f.claim_ids.length > 0 ? { claim_ids: f.claim_ids.map(String) } : {}),
                }));
              }
            } catch { /* parse failure — use empty findings */ }
          }

          // Fallback: if findings are empty (model failed to extract), union input
          // members' findings — degrades to unconsolidated duplicates rather than
          // erasing everything below this node in the tree
          if (findings.length === 0) {
            findings = group.members.flatMap(m => m.findings ?? []);
          }

          // Accumulate findings across all rounds so we never lose data
          accumulatedFindings.push(...findings);

          const mergedTextForNode = buildMergedText(executiveHeader, findings);
          const node: MergeNode = { text: mergedTextForNode, executiveHeader, findings, truncated };

          return { group, node };
        })
      );

      // Process results: checkpoint successes, track failures
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const group = batch[i];

        if (result.status === "fulfilled") {
          const { node } = result.value;
          nextNodes[group.idx] = node;
          if (node.truncated) truncatedMerges++;
          groupsDone++;

          // Save merge checkpoint
          await ctx.integrations.db.execute(
            `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json)
             VALUES ($1, $2, $3, $4::jsonb)
             ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE SET merged_json = $4::jsonb`,
            [runId, currentRound, group.idx, JSON.stringify({ text: node.text, executiveHeader: node.executiveHeader, findings: node.findings, truncated: node.truncated ?? false })],
            { label: `Save merge checkpoint R${currentRound}:G${group.idx}` }
          );
        } else {
          // Merge call failed — use a placeholder so the tree can still reduce
          mergeFailedGroups++;
          if (!mergeFirstError) {
            mergeFirstError = result.reason instanceof Error ? result.reason.message : String(result.reason);
          }
          // Use first member's text as fallback so tree reduction can continue
          // Preserve input members' findings so they aren't lost
          const memberFindings = group.members.flatMap(m => m.findings ?? []);
          accumulatedFindings.push(...memberFindings);
          const fallback: MergeNode = { text: group.members[0].text, executiveHeader: "Merge failed", findings: memberFindings };
          nextNodes[group.idx] = fallback;
          groupsDone++;

          // Save error checkpoint with incremented failureCount.
          // ON CONFLICT DO UPDATE overwrites the single row — failureCount inside the JSON
          // is the durable cross-invocation counter (not row count).
          const errCpKey = `${currentRound}:${group.idx}`;
          const prevFailures = errorCountMap.get(errCpKey) ?? 0;
          const newFailureCount = prevFailures + 1;
          errorCountMap.set(errCpKey, newFailureCount); // update in-memory for same-invocation re-encounters
          await ctx.integrations.db.execute(
            `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json)
             VALUES ($1, $2, $3, $4::jsonb)
             ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE SET merged_json = $4::jsonb`,
            [runId, currentRound, group.idx, JSON.stringify({ error: mergeFirstError, failureCount: newFailureCount })],
            { label: `Save merge error checkpoint R${currentRound}:G${group.idx} (failure #${newFailureCount})` }
          );
        }
      }

      // Refresh heartbeat after each batch
      await ctx.integrations.db.execute(
        `UPDATE module_runs SET triggered_at = now() WHERE id = $1`,
        [runId],
        { label: "Refresh triggered_at (merge batch heartbeat)" }
      );
    }

    // Track merge failures in overall counters
    failedChunks += mergeFailedGroups;
    if (!firstError && mergeFirstError) firstError = mergeFirstError;

    nodes = nextNodes;
  }

  // --- Step 5: Complete ---
  const finalNode = nodes[0];

  // If the final node lost its findings (common in deep trees where the last
  // merge round produces narrative prose but fails to re-extract structured JSON),
  // fall back to the de-duplicated accumulated set from all rounds.
  let finalFindings: MergedFinding[];
  if (finalNode.findings && finalNode.findings.length > 0) {
    finalFindings = finalNode.findings;
  } else {
    // Dedup accumulatedFindings by normalized title to remove overlapping entries
    // from multiple rounds that the fallback path collected
    const seen = new Set<string>();
    const deduped: MergedFinding[] = [];
    for (const f of accumulatedFindings) {
      const key = (f.title || "").toLowerCase().trim().replace(/\s+/g, " ");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(f);
    }
    finalFindings = deduped;
  }

  // --- Post-processing: suppress fabricated arithmetic/reconciliation findings ---
  // Only findings grounded in NumericVerify's deterministic output are trustworthy.
  const { FABRICATED_ARITHMETIC_PATTERNS } = await import("./fabricated-arithmetic-patterns.js");

  const preSuppressCount = finalFindings.length;
  finalFindings = finalFindings.filter(f => {
    const text = `${f.title} ${f.detail} ${f.full_analysis}`;
    return !FABRICATED_ARITHMETIC_PATTERNS.some(pat => pat.test(text));
  });
  const suppressedCount = preSuppressCount - finalFindings.length;
  if (suppressedCount > 0) {
    console.log(`[pipeline] Suppressed ${suppressedCount} fabricated arithmetic finding(s)`);
  }

  // Mark run completed
  // Guard: only complete if still running — prevents resurrection after purge/cancel
  await ctx.integrations.db.execute(
    `UPDATE module_runs SET status = 'completed'::module_status, completed_at = now() WHERE id = $1 AND status = 'running'::module_status`,
    [runId],
    { label: "Mark run completed (guarded)" }
  );

  // Post-completion framing audit (non-blocking, logs warnings)
  try {
    runPostCompletionAudit({
      runId,
      moduleId,
      reportText: finalNode.text,
      findings: finalFindings,
    });
  } catch (auditErr) {
    console.warn(`[pipeline] Post-completion audit failed (non-fatal):`, auditErr);
  }

  // Cap mergedText to prevent response payload from exceeding platform limits.
  // FormatReport truncates to its own context window anyway.
  const MAX_MERGED_TEXT_CHARS = 150_000;
  let mergedText = finalNode.text;
  if (mergedText.length > MAX_MERGED_TEXT_CHARS) {
    console.warn(`[pipeline] mergedText ${mergedText.length} chars exceeds ${MAX_MERGED_TEXT_CHARS} cap — truncating`);
    mergedText = mergedText.slice(0, MAX_MERGED_TEXT_CHARS) + "\n\n[…truncated for transport — full content available in DB checkpoints]";
  }

  return {
    status: "completed",
    runId,
    phase: "done",
    progress: {
      analysisTotal: routed.length,
      analysisCompleted: routed.length,
      mergeRound: totalMergeRounds,
      mergeTotal: totalMergeRounds,
    },
    result: {
      executiveHeader: finalNode.executiveHeader,
      findings: finalFindings,
      mergedText,
    },
    failedChunks,
    truncatedChunks,
    truncatedMerges,
    firstError,
  };
}
