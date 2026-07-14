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

// ---------------------------------------------------------------------------
// Models & Config
// ---------------------------------------------------------------------------
const SUB_AGENT_MODEL = "claude-sonnet-4-6";
const SUB_AGENT_MAX_TOKENS = 4096;
const SONNET_MODEL = "claude-sonnet-4-6";
const OPUS_MODEL = "claude-opus-4-7";
const MERGE_MAX_TOKENS = 8000;

const ANALYSIS_CONCURRENCY = 15;
const MERGE_CONCURRENCY = 10;
const MERGE_GROUP_SIZE = 4;
const MAX_MERGE_GROUP_FAILURES = 2; // Skip (use fallback) after this many error checkpoints across invocations
const TIME_BUDGET_MS = 200_000; // 3m20s — gives 100s headroom under platform's 300s API timeout
// NOTE: Reduced from 250s because paginated extraction loading, checkpoint saves,
// and DB overhead were pushing total wall-clock past the 300s platform limit.

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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function callAnthropic(
  ctx: PipelineContext,
  body: Record<string, unknown>,
  label: string,
  retries = 3,
  perCallTimeoutMs = 120_000 // 2 minutes per LLM call — prevents hanging indefinitely
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

// ---------------------------------------------------------------------------
// Core Pipeline Function
// ---------------------------------------------------------------------------
export async function runPipelineCore(ctx: PipelineContext, input: PipelineInput): Promise<PipelineResult> {
  const startTime = Date.now();
  const timeRemaining = () => TIME_BUDGET_MS - (Date.now() - startTime);

  const { dealId, moduleId, useOpus, numericReport, numericPartial } = input;

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
    };
  }

  // --- Step 2: Sub-agent analysis (with checkpointing) ---
  const analyzedRows = await ctx.integrations.db.query(
    `SELECT chunk_index FROM pipeline_analysis
     WHERE run_id = $1
     ORDER BY chunk_index`,
    AnalysisCheckpointSchema,
    [runId],
    { label: "Load analysis checkpoints" }
  );
  const analyzedSet = new Set(analyzedRows.map(r => r.chunk_index));

  const pendingChunks = routed.filter((_, i) => !analyzedSet.has(i));
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
  for (const cp of mergeCheckpoints) {
    const data = typeof cp.merged_json === "string" ? JSON.parse(cp.merged_json) : cp.merged_json;
    const cpKey = `${cp.tree_level}:${cp.node_index}`;
    if (data.error) {
      // failureCount is persisted in the JSON; default to 1 for legacy entries written before this field existed
      const count = typeof data.failureCount === "number" ? data.failureCount : 1;
      errorCountMap.set(cpKey, count);
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
        console.warn(`[pipeline] Skipping group R${currentRound}:G${group.idx} — ${priorFailures} prior failures, using fallback`);
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
          [runId, currentRound, group.idx, JSON.stringify({ text: fallback.text, executiveHeader: fallback.executiveHeader, findings: fallback.findings, skippedAfterFailures: priorFailures })],
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
          const setBlocks = group.members.map((m, i) => `## Analysis Set ${i + 1}\n\n${m.text}`);
          const mergeInput = setBlocks.join("\n\n---\n\n") + numericBlock;

          // retries=1 → exactly 1 attempt, 0 retries (callAnthropic loop: attempt <= retries).
          // Worst case = ~120s (single timeout). Previous default was retries=3 (3 attempts,
          // 360s worst-case) which guaranteed platform death on persistent timeouts.
          const mergeResult = await callAnthropic(
            ctx,
            {
              model: useOpus ? OPUS_MODEL : SONNET_MODEL,
              max_tokens: MERGE_MAX_TOKENS,
              system: [{ type: "text", text: mergePrompt, cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: mergeInput }],
            },
            `Merge R${currentRound} G${group.idx + 1}/${totalGroupsThisRound}`,
            1 // 1 attempt, 0 retries
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

  // Mark run completed
  // Guard: only complete if still running — prevents resurrection after purge/cancel
  await ctx.integrations.db.execute(
    `UPDATE module_runs SET status = 'completed'::module_status, completed_at = now() WHERE id = $1 AND status = 'running'::module_status`,
    [runId],
    { label: "Mark run completed (guarded)" }
  );

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
