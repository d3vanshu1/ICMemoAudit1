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
 * 5. NO SINGLE OPERATION MAY EXCEED REMAINING PLATFORM HEADROOM: The platform
 *    hard-kills APIs at EFFECTIVE_CAP_MS (pinned to 600s; verified via
 *    DiagTimeoutProbe v2). TIME_BUDGET_MS (500s) governs the pipeline's graceful
 *    exit point but does NOT constrain long-running sub-operations like escalation
 *    retries. Those are independently clamped by extraction-phase.ts to:
 *      min(desiredBudget, EFFECTIVE_CAP_MS − elapsed − PLATFORM_HEADROOM_MS)
 *    If remaining headroom < MIN_ESCALATION_BUDGET_MS (60s), the retry is
 *    DEFERRED to the next invocation without incrementing attempt_count.
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
import { runClaimsExtraction, type ClaimsLedger } from "./claims-extraction.js";
import { runReconciliation, type ReconciliationResult, type ReconciliationFinding } from "./claims-reconciliation.js";
import { runCleanParsedTextPhase } from "./clean-parsed-text.js";
import { runWebResearchPhase } from "./web-research-phase.js";
import { upsertModuleOutput } from "../modules/upsert-module-output.js";
import { getModuleModel, SONNET_MODEL } from "./model-config.js";
import { runChecklistScan, formatCoverageMapForPrompt, type ChecklistScanResult } from "./checklist-scan-phase.js";
import { runAbsenceVerificationPhase } from "./absence-verification-phase.js";
import { getPipelineVersion } from "./pipeline-version.js";
import { parseDateFromFileName } from "./parse-date-from-filename.js";
import { callLLMWithHeadroom, HeadroomExhaustedError, type LLMResponse } from "./call-llm.js";
import { TIME_BUDGET_MS, EFFECTIVE_CAP_MS, PLATFORM_HEADROOM_MS, MIN_VIABLE_LLM_BUDGET_MS, CHECKPOINT_RESERVE_MS } from "./pipeline-config.js";
import type { NumericVerifyResult } from "./numeric-verify-inline.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SUB_AGENT_MAX_TOKENS = 4096;
const MERGE_MAX_TOKENS = 8000;

const ANALYSIS_CONCURRENCY = 15;
const MERGE_CONCURRENCY = 5;
const MERGE_GROUP_SIZE = 4;
const MAX_MERGE_GROUP_FAILURES = 5; // Skip (use fallback) after this many error checkpoints across invocations
const MERGE_NODE_TEXT_CAP = 3000; // Max chars per node's text in merge input — prevents token overflow
// TIME_BUDGET_MS is imported from pipeline-config.ts (derived from EFFECTIVE_CAP_MS - 100s, floor 120s)

// Report formatting config (inline, post-merge)
const FORMAT_REPORT_MIN_BUDGET_MS = 100_000; // Need at least 100s to attempt report formatting

// Absence verification config (Step 5.5, between merge and format)
const ABSENCE_VERIFICATION_MIN_BUDGET_MS = 120_000; // Need at least 120s — 2 LLM calls per finding
const FORMAT_REPORT_MAX_TOKENS = 12000;
const FORMAT_REPORT_MODEL = SONNET_MODEL; // Always Sonnet — report formatting is quality-critical

/** Modules that go through the web research phase instead of direct analysis */
const WEB_RESEARCH_MODULES = new Set(["external_risk_overlay", "social_reputation"]);

// ---------------------------------------------------------------------------
// Mode-B Shared Helper: Append code-verified reconciliation findings
// ---------------------------------------------------------------------------
// Called from both main-path (post-merge) and fast-path (format-on-resume).
// Mutates finalFindings in-place: appends code-verified findings from reconciliation,
// deduplicates against LLM paraphrases (by matching £-amounts), and concatenates
// housekeeping findings. Must be called AFTER fabricated-arithmetic suppression so
// reconciliation findings bypass that filter entirely.
interface AppendReconResult {
  finalFindings: MergedFinding[];
  housekeepingFindings: MergedFinding[];
}

function appendReconciliationFindings(
  finalFindings: MergedFinding[],
  housekeepingFindings: MergedFinding[],
  claimsReconciliation: ReconciliationResult | null,
): AppendReconResult {
  // --- Append code-verified reconciliation principal findings ---
  if (claimsReconciliation && claimsReconciliation.findings.length > 0) {
    const existingKeys = new Set<string>();
    for (const f of finalFindings) {
      const key = (f.title || "").toLowerCase().trim().replace(/\s+/g, " ");
      if (key) existingKeys.add(key);
    }

    const codeVerifiedFindings: MergedFinding[] = claimsReconciliation.findings
      .filter(rf => rf.finding_kind === "data_divergence" || rf.finding_kind === "cross_version")
      .map(rf => ({
        title: rf.title,
        severity: rf.severity,
        detail: rf.detail,
        full_analysis: rf.full_analysis,
        source_docs: rf.source_docs,
        category: "principal_finding" as const,
        numeric_unverified: false,
        finding_kind: (rf.finding_kind === "cross_version" ? "data_divergence" : rf.finding_kind) as MergedFinding["finding_kind"],
        severity_anchor: rf.severity_anchor != null ? `£${(rf.severity_anchor / 1_000_000).toFixed(1)}m` : undefined,
      }));

    // Remove LLM paraphrases: if code-verified finding has ≥2 £-amounts,
    // drop any existing finding that mentions the same set of amounts.
    let llmDropped = 0;
    for (const cvf of codeVerifiedFindings) {
      const cvKey = (cvf.title || "").toLowerCase().trim().replace(/\s+/g, " ");
      const cvAmounts = cvf.detail.match(/£[\d,.]+m/g) ?? [];
      if (cvAmounts.length >= 2) {
        const beforeLen = finalFindings.length;
        finalFindings = finalFindings.filter(f => {
          const fText = `${f.title} ${f.detail}`;
          return !cvAmounts.every(amt => fText.includes(amt));
        });
        llmDropped += beforeLen - finalFindings.length;
      }
      if (!existingKeys.has(cvKey)) {
        finalFindings.push(cvf);
        existingKeys.add(cvKey);
      }
    }

    if (llmDropped > 0) {
      console.log(`[pipeline] Replaced ${llmDropped} LLM-paraphrased finding(s) with code-verified versions`);
    }
    console.log(`[pipeline] Appended ${codeVerifiedFindings.length} code-verified reconciliation finding(s) to final report`);

    // --- Append reconciliation housekeeping (scope_mismatch, unreconcilable) ---
    const reconHousekeeping: MergedFinding[] = claimsReconciliation.findings
      .filter(rf => rf.finding_kind === "scope_mismatch" || rf.finding_kind === "unreconcilable")
      .map(rf => ({
        title: rf.title,
        severity: rf.severity,
        detail: rf.detail,
        full_analysis: rf.full_analysis,
        source_docs: rf.source_docs,
        category: "housekeeping" as const,
        numeric_unverified: false,
        finding_kind: rf.finding_kind as MergedFinding["finding_kind"],
        severity_anchor: rf.severity_anchor != null ? `£${(rf.severity_anchor / 1_000_000).toFixed(1)}m` : undefined,
      }));

    if (reconHousekeeping.length > 0) {
      housekeepingFindings = [...housekeepingFindings, ...reconHousekeeping];
      const seen = new Set<string>();
      housekeepingFindings = housekeepingFindings.filter(f => {
        const key = (f.title || "").toLowerCase().trim().replace(/\s+/g, " ");
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      console.log(`[pipeline] Appended ${reconHousekeeping.length} reconciliation housekeeping finding(s)`);
    }
  }

  return { finalFindings, housekeepingFindings };
}

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

// MessageResponseSchema is imported via call-llm.ts (LLMResponse type)

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
  /** IDs of the memo(s) under review — excluded from evidence pool at all retrieval call sites. */
  subjectDocumentIds?: string[] | null;
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
  status: "completed" | "in_progress" | "failed" | "cancelled";
  runId: string;
  phase: string;
  progress: PipelineProgress;
  result: {
    executiveHeader: string;
    findings: MergedFinding[];
    mergedText: string;
    fullReport?: string | null;
  } | null;
  failedChunks?: number;
  truncatedChunks?: number; // analysis chunks where stop_reason was "max_tokens"
  truncatedMerges?: number; // merge groups where stop_reason was "max_tokens"
  mergeGroupsFallenBack?: number; // groups that exhausted retries and used unconsolidated fallback text
  firstError?: string | null;
  /** Chunks that exhausted all extraction attempts and are permanently missing from the report. */
  permanentlyFailedExtractions?: { chunkLabel: string; sourceFile: string; chunkIndex: number }[];
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

/**
 * Call Anthropic via the shared budget-aware helper.
 * This is the ONLY LLM entry point in pipeline-core.ts.
 * It clamps each attempt's timeout to remaining platform headroom and re-checks
 * headroom before every retry (unlike the old implementation which had no
 * per-attempt headroom check, allowing 120s × 3 + backoffs ≈ 366s worst case).
 */
async function callAnthropic(
  ctx: PipelineContext,
  body: Record<string, unknown>,
  label: string,
  retries = 3,
  perCallTimeoutMs = 120_000,
  pipelineStartTime: number
): Promise<LLMResponse> {
  return callLLMWithHeadroom(ctx, body, label, {
    pipelineStartTime,
    maxPerCallTimeout: perCallTimeoutMs,
    retries,
    minBudget: 30_000, // Analysis/merge can start with less headroom than extraction
  });
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
// Inline Report Formatting (runs inside the pipeline after merge completes)
// ---------------------------------------------------------------------------

/**
 * Simple report formatting prompt — generates the full IC report inline.
 * Uses a condensed version of the FormatReport prompt structure.
 * The client can optionally re-format with Opus via the FormatReport API,
 * but this inline Sonnet pass eliminates the client-side timeout risk.
 */
async function formatReportInline(
  _ctx: PipelineContext,
  _moduleId: string,
  executiveHeader: string,
  findings: MergedFinding[],
  _timeRemainingMs: number,
  _pipelineStartTime: number,
  housekeepingFindings: MergedFinding[] = [],
  verificationPhaseErrored: boolean = false,
  mergeGroupsFallenBack: number = 0,
): Promise<string | null> {
  // ---------------------------------------------------------------------------
  // PURE MECHANICAL RENDERER — zero Anthropic calls.
  // Signature and budget plumbing preserved for Track 2 (chunked-LLM demo artifact).
  // Completes in milliseconds; budget machinery is trivially satisfied.
  // ---------------------------------------------------------------------------

  if (findings.length === 0) {
    return `# Diligence Report\n\n> 0 findings. No analysis output.\n`;
  }

  // Partition
  const criticals = findings.filter(f => f.severity === "critical");
  const warnings = findings.filter(f => f.severity === "warning");
  const infos = findings.filter(f => f.severity === "info");
  const totalCount = findings.length;
  const criticalCount = criticals.length;
  const warningCount = warnings.length;
  const infoCount = infos.length;

  // Count by gap_type
  const memoOmissions = findings.filter(f => f.gap_type === "memo_omission").length;
  const diligenceGaps = findings.filter(f => f.gap_type === "diligence_gap").length;
  const otherType = totalCount - memoOmissions - diligenceGaps;

  const lines: string[] = [];

  // =========================================================================
  // (a) DISCLOSURE HEADER
  // =========================================================================
  lines.push(`# Diligence Report`);
  lines.push(``);
  // Partition housekeeping by sub-category
  const housekeepingItems = housekeepingFindings.filter(f => f.category !== "human_review_flag");
  const humanReviewItems = housekeepingFindings.filter(f => f.category === "human_review_flag");
  const housekeepingCount = housekeepingItems.length;
  const humanReviewCount = humanReviewItems.length;

  lines.push(`> **${totalCount} principal findings, ${housekeepingCount} housekeeping, ${humanReviewCount} human-review flags — mechanically rendered, no LLM synthesis.**`);
  lines.push(`>`);
  lines.push(`> Severity: ${criticalCount} critical, ${warningCount} warning, ${infoCount} info.`);
  lines.push(`> Category: ${memoOmissions} memo\_omission, ${diligenceGaps} diligence\_gap${otherType > 0 ? `, ${otherType} other` : ""}.`);
  lines.push(`>`);
  lines.push(`> All detail text reproduced verbatim from pipeline output. Zero paraphrase, zero trimming.`);
  if (verificationPhaseErrored) {
    lines.push(`>`);
    lines.push(`> ⚠️ **Absence claims in this report were not adversarially verified (phase error).**`);
  }
  if (mergeGroupsFallenBack > 0) {
    lines.push(`>`);
    lines.push(`> ⚠️ **${mergeGroupsFallenBack} merge group(s) fell back to unconsolidated text after repeated timeouts.** Findings from those groups are carried forward from sub-analysis but were not synthesized by the merge layer.`);
  }
  lines.push(``);

  // Executive header (deal context from pipeline)
  if (executiveHeader) {
    lines.push(`## Deal Context`);
    lines.push(``);
    lines.push(executiveHeader);
    lines.push(``);
  }

  // =========================================================================
  // (b) FULL INDEX — title + severity + category for every finding
  // =========================================================================
  lines.push(`## Findings Index`);
  lines.push(``);
  lines.push(`| # | Severity | Category | Title |`);
  lines.push(`|---|----------|----------|-------|`);

  // Stable ordering: category → severity → title (deterministic)
  const indexed = findings.map((f, i) => ({ ...f, _origIdx: i }));
  const severityRank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  const categoryRank: Record<string, number> = { memo_omission: 0, diligence_gap: 1 };
  indexed.sort((a, b) => {
    const catA = categoryRank[a.gap_type ?? ""] ?? 9;
    const catB = categoryRank[b.gap_type ?? ""] ?? 9;
    if (catA !== catB) return catA - catB;
    const sevA = severityRank[a.severity] ?? 9;
    const sevB = severityRank[b.severity] ?? 9;
    if (sevA !== sevB) return sevA - sevB;
    return a.title.localeCompare(b.title);
  });

  for (let i = 0; i < indexed.length; i++) {
    const f = indexed[i];
    const cat = f.gap_type ?? "unclassified";
    // Escape pipes in titles to avoid breaking table rendering
    const safeTitle = f.title.replace(/\|/g, "\\|");
    lines.push(`| ${i + 1} | ${f.severity.toUpperCase()} | ${cat} | ${safeTitle} |`);
  }
  lines.push(``);

  // =========================================================================
  // (c) FINDINGS — grouped category → severity, verbatim detail, stable anchors
  // =========================================================================
  lines.push(`## Findings`);
  lines.push(``);

  // Group by gap_type
  const categories = new Map<string, Array<MergedFinding & { _origIdx: number }>>();
  for (const f of indexed) {
    const cat = f.gap_type ?? "unclassified";
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat)!.push(f);
  }

  const categoryOrder = ["memo_omission", "diligence_gap", "unclassified"];
  const sortedCategories = [...categories.entries()].sort((a, b) => {
    const aIdx = categoryOrder.indexOf(a[0]);
    const bIdx = categoryOrder.indexOf(b[0]);
    return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
  });

  let globalIdx = 0;
  for (const [category, catFindings] of sortedCategories) {
    const categoryLabel = category === "memo_omission" ? "Memo Omissions"
      : category === "diligence_gap" ? "Diligence Gaps"
      : "Other";

    lines.push(`### ${categoryLabel} (${catFindings.length})`);
    lines.push(``);

    // Already sorted by severity then title from the index sort
    for (const f of catFindings) {
      globalIdx++;
      // Stable anchor ID: finding-{globalIdx}
      lines.push(`<a id="finding-${globalIdx}"></a>`);
      lines.push(``);
      lines.push(`#### ${f.title}`);
      lines.push(``);
      lines.push(`**Severity:** ${f.severity.toUpperCase()} | **Category:** ${category} | **ID:** finding-${globalIdx}`);
      lines.push(``);

      // Detail — VERBATIM, no paraphrase, no trimming
      // Only escape: bare < or > that would create unintended HTML tags
      const safeDetail = escapeMarkdownBreakers(f.detail);
      lines.push(safeDetail);
      lines.push(``);

      // Source documents — VERBATIM
      if (f.source_docs && f.source_docs.length > 0) {
        lines.push(`**Source Documents:**`);
        for (const doc of f.source_docs) {
          lines.push(`- ${doc}`);
        }
        lines.push(``);
      }

      // Evidence documents — VERBATIM
      if (f.evidence_docs && f.evidence_docs.length > 0) {
        lines.push(`**Evidence Documents:**`);
        for (const doc of f.evidence_docs) {
          lines.push(`- ${doc}`);
        }
        lines.push(``);
      }

      // Claim IDs (if present)
      if (f.claim_ids && f.claim_ids.length > 0) {
        lines.push(`**Claim IDs:** ${f.claim_ids.join(", ")}`);
        lines.push(``);
      }

      // Separator between findings
      lines.push(`---`);
      lines.push(``);
    }
  }

  // =========================================================================
  // (d) HOUSEKEEPING APPENDIX — sub-materiality items demoted per Fix 4
  // =========================================================================
  if (housekeepingItems.length > 0) {
    lines.push(`## Housekeeping Appendix`);
    lines.push(``);
    lines.push(`> ${housekeepingItems.length} sub-materiality item(s) demoted from principal findings. Standard DD workstreams, post-close admin, or process-stage items.`);
    lines.push(``);

    for (const f of housekeepingItems) {
      lines.push(`#### ${f.title}`);
      lines.push(``);
      lines.push(`**Severity:** ${f.severity.toUpperCase()} | **Demotion rationale:** ${f.materiality_rationale ?? "Sub-materiality threshold"}`);
      lines.push(``);
      lines.push(escapeMarkdownBreakers(f.detail));
      lines.push(``);
      if (f.source_docs && f.source_docs.length > 0) {
        lines.push(`**Source Documents:** ${f.source_docs.join(", ")}`);
        lines.push(``);
      }
      lines.push(`---`);
      lines.push(``);
    }
  }

  // =========================================================================
  // (e) HUMAN REVIEW FLAGS — emphasis-judgment findings per rubric criterion 2
  // =========================================================================
  if (humanReviewItems.length > 0) {
    lines.push(`## Human Review Flags`);
    lines.push(``);
    lines.push(`> ${humanReviewItems.length} finding(s) flagged for human review. These assert emphasis-judgment claims ("underweighted", "de-emphasised") that failed the six-point verification rubric.`);
    lines.push(``);

    for (const f of humanReviewItems) {
      lines.push(`#### ${f.title}`);
      lines.push(``);
      lines.push(`**Severity:** ${f.severity.toUpperCase()} | **Flag reason:** Emphasis-judgment — requires human assessment`);
      lines.push(``);
      lines.push(escapeMarkdownBreakers(f.detail));
      lines.push(``);
      if (f.source_docs && f.source_docs.length > 0) {
        lines.push(`**Source Documents:** ${f.source_docs.join(", ")}`);
        lines.push(``);
      }
      lines.push(`---`);
      lines.push(``);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Markdown Escaping — only where raw text would break markdown rendering
// ---------------------------------------------------------------------------

/**
 * Escapes characters in verbatim detail text that would break markdown rendering.
 * Does NOT paraphrase or trim — only prevents structural markdown breakage.
 */
function escapeMarkdownBreakers(text: string): string {
  // Escape bare angle brackets that look like HTML tags (not part of intentional markdown)
  // but preserve legitimate markdown syntax.
  // Only escape < when followed by a word char (looks like an HTML tag)
  return text.replace(/<(?=[a-zA-Z/])/g, "&lt;");
}

// ---------------------------------------------------------------------------
// Cancellation Gate
// ---------------------------------------------------------------------------

/** Lightweight single-row check — returns true if the run has been cancelled. */
async function checkCancelled(ctx: PipelineContext, runId: string, gate: string): Promise<boolean> {
  // Check is_cancelled boolean (post-migration-009) with fallback to status check
  try {
    const rows = await ctx.integrations.db.query(
      `SELECT COALESCE(is_cancelled, FALSE) AS is_cancelled FROM module_runs WHERE id = $1 LIMIT 1`,
      z.object({ is_cancelled: z.boolean() }),
      [runId],
      { label: `Cancel gate: ${gate}` }
    );
    if (rows[0]?.is_cancelled) {
      console.log(`[pipeline:cancel-gate] Run ${runId} cancelled at gate: ${gate}`);
      return true;
    }
  } catch (err: unknown) {
    // Discriminate: 42703 = undefined_column (pre-migration) → silent legacy fallback.
    // The Superblocks platform may wrap Postgres errors into a generic
    // 'Integration "..." failed during "query"' message, so we also treat
    // that wrapped form as a likely missing-column scenario (non-fatal).
    const errMsg = err instanceof Error ? err.message : String(err);
    const isLikelyMissingColumn =
      errMsg.includes("42703") ||
      errMsg.includes("does not exist") ||
      errMsg.includes('failed during "query"');
    if (!isLikelyMissingColumn) {
      console.error(`[pipeline:cancel-gate] UNEXPECTED ERROR at gate "${gate}" for run ${runId}: ${errMsg}`);
    }
    // Pre-migration: column doesn't exist → cancellation indistinguishable server-side.
    // Client-side killedModulesRef is the real guard.
  }
  return false;
}

/** Build a terminal cancelled result. */
function cancelledResult(runId: string, gate: string): PipelineResult {
  return {
    status: "cancelled",
    runId,
    phase: `cancelled_at_${gate}`,
    progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
    result: null,
    failedChunks: 0,
    truncatedChunks: 0,
    truncatedMerges: 0,
    firstError: "Cancelled by user",
  };
}

// ---------------------------------------------------------------------------
// Error Capture — persists error details to module_runs for post-mortem.
// Uses IF NOT EXISTS-style try/catch so the column can be added lazily.
// ---------------------------------------------------------------------------

/**
 * Marks a run as failed and persists the error message + phase into the DB.
 * Falls back gracefully if the error_message/error_phase columns don't exist yet.
 * Also writes to integration-owned `pipeline_errors` table for post-mortem.
 */
async function markRunFailed(
  db: PipelineContext["integrations"]["db"],
  runId: string,
  errorMessage: string,
  errorPhase: string,
  dealId?: string,
  moduleId?: string
): Promise<void> {
  try {
    await db.execute(
      `UPDATE module_runs
       SET status = 'failed'::module_status,
           completed_at = now(),
           error_message = $2,
           error_phase = $3
       WHERE id = $1 AND status = 'running'::module_status`,
      [runId, errorMessage, errorPhase],
      { label: `Mark run failed — ${errorPhase}` }
    );
  } catch {
    // error_message/error_phase columns may not exist yet — fall back to status-only
    await db.execute(
      `UPDATE module_runs SET status = 'failed'::module_status, completed_at = now() WHERE id = $1 AND status = 'running'::module_status`,
      [runId],
      { label: `Mark run failed (legacy) — ${errorPhase}` }
    );
  }

  // Persist to integration-owned pipeline_errors table (best-effort)
  try {
    await db.execute(
      `INSERT INTO pipeline_errors (run_id, deal_id, module_id, error_phase, error_message, error_stack)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        runId,
        dealId ?? "00000000-0000-0000-0000-000000000000",
        moduleId ?? "unknown",
        errorPhase,
        errorMessage.slice(0, 4000),
        new Error().stack?.slice(0, 2000) ?? null,
      ],
      { label: `Persist error to pipeline_errors — ${errorPhase}` }
    );
  } catch {
    // pipeline_errors table may not exist yet — non-fatal
  }
}

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
    let status: string;
    let isCancelled: boolean;

    try {
      const currentStatus = await ctx.integrations.db.query(
        `SELECT status, COALESCE(is_cancelled, FALSE) AS is_cancelled FROM module_runs WHERE id = $1 LIMIT 1`,
        z.object({ status: z.string(), is_cancelled: z.boolean() }),
        [runId],
        { label: "Check run status before resume" }
      );

      if (currentStatus.length === 0) {
        throw new Error(`Run ${runId} not found`);
      }

      status = currentStatus[0].status;
      isCancelled = currentStatus[0].is_cancelled;
    } catch (err: unknown) {
      // Dump full error structure — SDK errors strip Postgres detail; we need to
      // learn where the platform actually hides it for future hardening.
      const errDetail = (() => {
        try {
          return JSON.stringify(err, Object.getOwnPropertyNames(err as object));
        } catch {
          return String(err);
        }
      })();
      console.error(`[pipeline:resume-status-check] ERROR for run ${runId}. Full structure: ${errDetail}`);

      // Fallback-probe: status-only query references no missing column.
      // Succeeds → failure was column-related (pre-migration or SDK stripping detail); proceed.
      // Fails → integration genuinely down; rethrow original.
      try {
        const fallbackRows = await ctx.integrations.db.query(
          `SELECT status FROM module_runs WHERE id = $1 LIMIT 1`,
          z.object({ status: z.string() }),
          [runId],
          { label: "Check run status before resume (fallback-probe)" }
        );

        if (fallbackRows.length === 0) {
          throw new Error(`Run ${runId} not found`);
        }

        status = fallbackRows[0].status;
        isCancelled = false;
      } catch (fallbackErr: unknown) {
        // Fallback also failed — integration is genuinely unreachable; rethrow original
        console.error(`[pipeline:resume-status-check] Fallback-probe ALSO FAILED for run ${runId}. Rethrowing original.`);
        throw err;
      }
    }
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

    if (status === "failed" || isCancelled) {
      // Terminated — don't resurrect. Return the terminal state.
      return {
        status: isCancelled ? "cancelled" : "failed",
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

  // --- Step 0.3.5: Load filename→tag map for deterministic independent flag ---
  // Used in two places:
  //   1. Injected into the merge prompt so the model has authoritative tag info
  //   2. Post-merge pass overrides `independent` based on actual tags
  // Loaded early so the fast-path (checkpoint resume → format) also has access.
  const DocTagRow = z.object({ id: z.string(), file_name: z.string(), document_tag: z.string() });
  const docTagRows = await ctx.integrations.db.query(
    `SELECT id, file_name, document_tag FROM documents WHERE deal_id = $1`,
    DocTagRow,
    [dealId],
    { label: "Load filename→tag map for independent flag" }
  );
  /** Maps lowercase filename → document_tag (e.g. "ic_memo", "cim", "financial_model") */
  const fileTagMap = new Map<string, string>();
  /** Maps document ID → filename (for subject identity resolution) */
  const idToFileName = new Map<string, string>();
  for (const row of docTagRows) {
    fileTagMap.set(row.file_name.toLowerCase(), row.document_tag);
    idToFileName.set(row.id, row.file_name);
  }

  // --- Fast-Path: Skip to formatting when merge tree is already complete ---
  // When a prior invocation completed all analysis + merge but timed out during
  // formatting (or formatting returned null), re-running the full pipeline wastes
  // ~170s on redundant heavyweight steps (extraction, doc tables, numeric verify,
  // merge loop). Instead, detect that the final merge node exists + no output saved,
  // and jump straight to formatting with the full time budget available.
  if (runId) {
    // Fast-path check: fetch the top checkpoint WITHOUT the potentially huge `text`
    // field. We use jsonb operators to extract only the fields we need for the check,
    // then reconstruct `text` from findings via buildMergedText() (avoids 4MB gRPC breach).
    const FastPathCheckSchema = z.object({
      tree_level: z.coerce.number(),
      node_index: z.coerce.number(),
      executive_header: z.string(),
      findings_json: z.string(), // JSON-encoded findings array
      is_truncated: z.boolean(),
      has_error: z.boolean(),
    });
    const [topCheckpoint] = await ctx.integrations.db.query(
      `SELECT tree_level, node_index,
              COALESCE(merged_json->>'executiveHeader', '') AS executive_header,
              COALESCE(merged_json->'findings', '[]'::jsonb)::text AS findings_json,
              COALESCE((merged_json->>'truncated')::boolean, false) AS is_truncated,
              jsonb_exists(merged_json, 'error') AS has_error
       FROM merge_checkpoints
       WHERE module_run_id = $1
       ORDER BY tree_level DESC, node_index ASC
       LIMIT 1`,
      FastPathCheckSchema,
      [runId],
      { label: "Fast-path: check for final merge node (lightweight)" }
    );

    if (topCheckpoint) {
      // Only fast-path if: (a) it's a real success node (not error), (b) it's the
      // sole node at its level (node_index=0 and no siblings), (c) no output saved yet
      if (!topCheckpoint.has_error && topCheckpoint.node_index === 0) {
        // Verify it's truly the final node: there should be exactly 1 node at this level
        const [siblingCount] = await ctx.integrations.db.query(
          `SELECT COUNT(*)::int AS cnt FROM merge_checkpoints WHERE module_run_id = $1 AND tree_level = $2`,
          z.object({ cnt: z.coerce.number() }),
          [runId, topCheckpoint.tree_level],
          { label: "Fast-path: verify single final node" }
        );

        const isFinalNode = siblingCount && siblingCount.cnt === 1;

        if (isFinalNode) {
          // Check if output already exists (if so, skip — run should have been marked completed)
          const [outputCheck] = await ctx.integrations.db.query(
            `SELECT 1 AS exists FROM module_outputs WHERE module_run_id = $1 LIMIT 1`,
            z.object({ exists: z.coerce.number() }),
            [runId],
            { label: "Fast-path: check module_outputs" }
          );

          if (!outputCheck) {
            // ✅ Fast-path engaged: final merge node complete, no output yet → format directly
            console.log(`[pipeline:fast-path] Final merge node found at level ${topCheckpoint.tree_level}, skipping to formatting`);

            // Reconstruct findings from the lightweight query (text is rebuilt from findings)
            const findings = JSON.parse(topCheckpoint.findings_json) as MergedFinding[];
            // Reconstruct housekeeping findings from checkpoint merged_json if available
            let fastPathHousekeeping: MergedFinding[] = [];
            try {
              const [cpRow] = await ctx.integrations.db.query(
                `SELECT merged_json->'housekeepingFindings' AS hk FROM merge_checkpoints WHERE module_run_id = $1 AND tree_level = $2 AND node_index = 0 LIMIT 1`,
                z.object({ hk: z.any().nullable() }),
                [runId, topCheckpoint.tree_level],
                { label: "Fast-path: load housekeeping from checkpoint" }
              );
              if (cpRow?.hk && Array.isArray(cpRow.hk)) {
                fastPathHousekeeping = cpRow.hk as MergedFinding[];
              }
            } catch { /* non-fatal — proceed without housekeeping */ }

            const finalNode = {
              text: buildMergedText(topCheckpoint.executive_header, findings),
              executiveHeader: topCheckpoint.executive_header,
              findings,
              truncated: topCheckpoint.is_truncated,
            };

            let finalFindings = finalNode.findings;

            // Apply fabricated arithmetic suppression (no LLM, just regex — fast)
            const { FABRICATED_ARITHMETIC_PATTERNS } = await import("./fabricated-arithmetic-patterns.js");
            const preSuppressCount = finalFindings.length;
            finalFindings = finalFindings.filter(f => {
              const text = `${f.title} ${f.detail} ${f.full_analysis}`;
              return !FABRICATED_ARITHMETIC_PATTERNS.some(pat => pat.test(text));
            });
            const suppressedCount = preSuppressCount - finalFindings.length;
            if (suppressedCount > 0) {
              console.log(`[pipeline:fast-path] Suppressed ${suppressedCount} fabricated arithmetic finding(s)`);
            }

            // --- Mode-B Fix (fast-path): Load reconciliation checkpoint and append ---
            // On resumed runs, claimsReconciliation is not in memory. Load from checkpoint.
            let fastPathRecon: ReconciliationResult | null = null;
            if (moduleId === "contradiction_check") {
              try {
                const reconCpRows = await ctx.integrations.db.query(
                  `SELECT payload FROM pipeline_checkpoints
                   WHERE module_run_id = $1 AND checkpoint_key = 'reconciliation'`,
                  z.object({ payload: z.any() }),
                  [runId],
                  { label: "Fast-path: load reconciliation checkpoint" }
                );
                if (reconCpRows.length > 0 && reconCpRows[0].payload) {
                  fastPathRecon = reconCpRows[0].payload as ReconciliationResult;
                  console.log(`[pipeline:fast-path] Loaded reconciliation checkpoint: ${fastPathRecon.findings.length} findings`);
                }
              } catch {
                // pipeline_checkpoints may not exist — proceed without
              }
            }

            // Apply shared Mode-B append + dedup (same logic as main path)
            const reconAppendResult = appendReconciliationFindings(finalFindings, fastPathHousekeeping, fastPathRecon);
            finalFindings = reconAppendResult.finalFindings;
            fastPathHousekeeping = reconAppendResult.housekeepingFindings;

            // Deterministic independent override (same logic as Step 5.7)
            for (const f of finalFindings) {
              if (f.evidence_docs && f.evidence_docs.length > 0) {
                f.independent = f.evidence_docs.some((docName) => {
                  const tag = fileTagMap.get(docName.toLowerCase());
                  return tag !== "ic_memo";
                });
              }
            }

            // Fast-path format budget: derived from PLATFORM cap, not TIME_BUDGET.
            // The fast-path has no post-format phases (no extraction, no merge remaining) —
            // only a DB upsert after formatting. PLATFORM_HEADROOM_MS (30s) covers that.
            const elapsedMs = Date.now() - startTime;
            const formatBudget = EFFECTIVE_CAP_MS - elapsedMs - PLATFORM_HEADROOM_MS;
            if (formatBudget < FORMAT_REPORT_MIN_BUDGET_MS) {
              console.warn(`[pipeline:fast-path] Insufficient time even on fast-path (budget=${Math.round(formatBudget / 1000)}s, elapsed=${Math.round(elapsedMs / 1000)}s) — returning in_progress`);
              return {
                status: "in_progress",
                runId,
                phase: "fast_path_formatting",
                progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
                result: null,
                failedChunks: 0,
                truncatedChunks: 0,
                truncatedMerges: 0,
                firstError: null,
              };
            }

            // Sanity telemetry: shows the clamp arithmetic in the wild
            const perCallTimeoutPreview = Math.min(formatBudget - 10_000, 230_000);
            console.log(`[pipeline:fast-path] Formatting report — elapsed=${Math.round(elapsedMs / 1000)}s, formatBudget=${Math.round(formatBudget / 1000)}s, perCallTimeout=${Math.round(perCallTimeoutPreview / 1000)}s, findings=${finalFindings.length}`);
            const fullReport = await formatReportInline(ctx, moduleId, finalNode.executiveHeader, finalFindings, formatBudget, startTime, fastPathHousekeeping, false);

            if (!fullReport) {
              console.warn(`[pipeline:fast-path] formatReportInline returned null — will retry on next invocation`);
              return {
                status: "in_progress",
                runId,
                phase: "formatting_retry",
                progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
                result: null,
                failedChunks: 0,
                truncatedChunks: 0,
                truncatedMerges: 0,
                firstError: "Report formatting failed — will retry on next invocation",
              };
            }

            // Save to module_outputs
            let outputSaved = false;
            for (let attempt = 1; attempt <= 2; attempt++) {
              try {
                await upsertModuleOutput(ctx.integrations.db, {
                  runId,
                  dealId,
                  executiveHeader: finalNode.executiveHeader,
                  findings: finalFindings,
                  fullReport,
                });
                console.log(`[pipeline:fast-path] Report saved (${fullReport.length} chars, attempt ${attempt})`);
                outputSaved = true;
                break;
              } catch (saveErr) {
                console.warn(`[pipeline:fast-path] Save failed (attempt ${attempt}/2):`, saveErr);
                if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }

            if (!outputSaved) {
              console.error(`[pipeline:fast-path] module_outputs save failed after 2 attempts — NOT marking completed`);
              return {
                status: "in_progress",
                runId,
                phase: "save_retry",
                progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
                result: null,
                failedChunks: 0,
                truncatedChunks: 0,
                truncatedMerges: 0,
                firstError: "module_outputs save failed — will retry on next invocation",
              };
            }

            // Mark run completed
            await ctx.integrations.db.execute(
              `UPDATE module_runs SET status = 'completed'::module_status, completed_at = now() WHERE id = $1 AND status = 'running'::module_status`,
              [runId],
              { label: "Fast-path: mark run completed" }
            );

            // Post-completion audit (non-blocking)
            try {
              runPostCompletionAudit({
                runId,
                moduleId,
                reportText: finalNode.text,
                findings: finalFindings,
              });
            } catch (auditErr) {
              console.warn(`[pipeline:fast-path] Post-completion audit failed (non-fatal):`, auditErr);
            }

            // Cap mergedText for response
            const MAX_MERGED_TEXT_CHARS = 150_000;
            let mergedText = finalNode.text;
            if (mergedText.length > MAX_MERGED_TEXT_CHARS) {
              mergedText = mergedText.slice(0, MAX_MERGED_TEXT_CHARS) + "\n\n[…truncated for transport]";
            }

            return {
              status: "completed",
              runId,
              phase: "done",
              progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
              result: {
                executiveHeader: finalNode.executiveHeader,
                findings: finalFindings,
                mergedText,
                fullReport,
              },
              failedChunks: 0,
              truncatedChunks: 0,
              truncatedMerges: 0,
              firstError: null,
            };
          }
        }
      }
    }
  }

  // --- Subject & Evidence Pool Guard (resume-aware) ---
  // ALL analysis modules (everything routed through pipeline-core) require:
  //   1. At least one subject document ID — the memo(s) under review
  //   2. At least one evidence document — reference material beyond the subject
  // Executive Summary is NOT routed through pipeline-core so is unaffected.
  //
  // RESUME-AWARENESS: If the run already has analysis checkpoints, the subject
  // was validated on the original invocation. Don't kill a multi-hour run because
  // a resume call arrived with empty subject IDs (auto-resume race condition).
  let subjectIds = input.subjectDocumentIds ?? [];
  if (subjectIds.length === 0 && runId) {
    // Attempt to reconstruct subject IDs: IC memo documents for this deal
    // (same logic as the frontend auto-preselect)
    const icMemoRows = await ctx.integrations.db.query(
      `SELECT id FROM documents WHERE deal_id = $1 AND document_tag = 'ic_memo'`,
      z.object({ id: z.string() }),
      [dealId],
      { label: "Reconstruct subjectIds from ic_memo docs (resume fallback)" }
    );
    if (icMemoRows.length > 0) {
      subjectIds = icMemoRows.map(r => r.id);
      console.log(`[pipeline] Reconstructed subjectIds from ${icMemoRows.length} ic_memo doc(s) (resume fallback)`);
    }
  }
  if (subjectIds.length === 0 && runId) {
    // Even reconstruction failed — check if the run already has checkpoints.
    // If so, skip the guard (subject was validated on first invocation).
    const [existingCp] = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis WHERE run_id = $1`,
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "Check existing checkpoints for resume guard bypass" }
    );
    if (existingCp && existingCp.cnt > 0) {
      console.warn(`[pipeline] Subject guard bypass: run ${runId} has ${existingCp.cnt} analysis checkpoints but empty subjectIds on resume — proceeding without subject exclusion`);
      // Proceed with empty subjectIds — extraction routing already encoded subject/evidence split
    } else {
      // True fresh start with no checkpoints and no subject — fail
      const errMsg = "Cannot run this module without selecting a subject memo. Please choose the 'Memo(s) under review' before running.";
      await markRunFailed(ctx.integrations.db, runId, errMsg, "no_subject_document", dealId, moduleId);
      return {
        status: "failed",
        runId,
        phase: "no_subject_document",
        progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
        result: null,
        failedChunks: 0,
        truncatedChunks: 0,
        truncatedMerges: 0,
        firstError: errMsg,
      };
    }
  } else if (subjectIds.length === 0) {
    // No runId (shouldn't happen in practice) — original guard
    const errMsg = "Cannot run this module without selecting a subject memo. Please choose the 'Memo(s) under review' before running.";
    await markRunFailed(ctx.integrations.db, runId!, errMsg, "no_subject_document", dealId, moduleId);
    return {
      status: "failed",
      runId: runId!,
      phase: "no_subject_document",
      progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
      result: null,
      failedChunks: 0,
      truncatedChunks: 0,
      truncatedMerges: 0,
      firstError: errMsg,
    };
  }

  // Check that the evidence pool (deal docs minus subject IDs) has at least one document
  // with indexed chunks. A document that exists but produced zero chunks (parse failure,
  // unsupported type) means FTS has nothing to search — treat as empty evidence pool.
  const evidenceCountRows = await ctx.integrations.db.query(
    `SELECT COUNT(DISTINCT d.id)::int AS cnt
     FROM documents d
     WHERE d.deal_id = $1
       AND d.id != ALL($2::uuid[])
       AND EXISTS (SELECT 1 FROM document_chunks dc WHERE dc.document_id = d.id)`,
    z.object({ cnt: z.number() }),
    [dealId, subjectIds],
    { label: "Check evidence pool has chunked documents" }
  );
  const evidenceCount = evidenceCountRows[0]?.cnt ?? 0;
  if (evidenceCount === 0) {
    const errMsg = "Cannot run this module without at least one reference document in the evidence pool. Upload documents beyond the subject memo before running.";
    await markRunFailed(ctx.integrations.db, runId!, errMsg, "no_evidence_documents", dealId, moduleId);
    return {
      status: "failed",
      runId: runId!,
      phase: "no_evidence_documents",
      progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
      result: null,
      failedChunks: 0,
      truncatedChunks: 0,
      truncatedMerges: 0,
      firstError: errMsg,
    };
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
  const extractionResult = await runExtractionPhase(ctx, dealId, startTime, runId);
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

  // === CANCEL GATE: post-extraction ===
  if (await checkCancelled(ctx, runId, "post_extraction")) return cancelledResult(runId, "post_extraction");

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
  //
  // CHECKPOINT-RESUME: If a complete numeric report is already persisted for this
  // run (from a prior invocation), reload it and skip re-running the engine.
  // If the engine returns partial=true (budget exhaustion), return in_progress.
  if (NUMERIC_MODULES.has(moduleId)) {
    // Check for persisted complete numeric report from prior invocation
    let numericCheckpointLoaded = false;
    try {
      const cpRows = await ctx.integrations.db.query(
        `SELECT payload FROM pipeline_checkpoints
         WHERE module_run_id = $1 AND checkpoint_key = 'numeric_report'`,
        z.object({ payload: z.any() }),
        [runId],
        { label: "Load numeric report checkpoint" }
      );
      if (cpRows.length > 0 && cpRows[0].payload) {
        const saved = cpRows[0].payload as { figures: unknown[]; discrepancies: unknown[] };
        if (saved.figures && saved.discrepancies) {
          numericReport = { figures: saved.figures as any[], discrepancies: saved.discrepancies as any[] };
          numericPartial = false; // Checkpointed means it completed
          numericCheckpointLoaded = true;
          console.log(
            `[NumericInline] Loaded checkpoint: ${saved.figures.length} figures, ` +
            `${saved.discrepancies.length} discrepancies (complete)`
          );
        }
      }
    } catch {
      // pipeline_checkpoints may not exist yet — proceed to run fresh
    }

    if (!numericCheckpointLoaded) {
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

            // If COMPLETE, persist to checkpoint so resume skips re-running
            if (!inlineResult.partial) {
              try {
                await ctx.integrations.db.execute(
                  `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload)
                   VALUES ($1, 'numeric_report', $2::jsonb)
                   ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
                  [runId, JSON.stringify({ figures: inlineResult.figures, discrepancies: inlineResult.discrepancies })],
                  { label: "Persist numeric report checkpoint" }
                );
              } catch {
                // pipeline_checkpoints table may not exist yet — non-fatal
              }
            }
          } else if (!numericReport) {
            // No data from inline either — ensure downstream knows
            numericReport = null;
            numericPartial = null;
            console.log(`[NumericInline] No numeric data found for this deal.`);
            // Persist empty result so resume knows numeric is done (no data = complete)
            try {
              await ctx.integrations.db.execute(
                `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload)
                 VALUES ($1, 'numeric_report', $2::jsonb)
                 ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
                [runId, JSON.stringify({ figures: [], discrepancies: [] })],
                { label: "Persist empty numeric report checkpoint" }
              );
            } catch { /* non-fatal */ }
          }

          // COMPLETION GATE: if numeric is partial, return in_progress — do NOT proceed to merge
          if (inlineResult.partial) {
            console.log(`[NumericInline] Partial result — returning in_progress for resume`);
            return {
              status: "in_progress",
              runId: runId!,
              phase: "numeric_verify",
              progress: {
                analysisTotal: 0,
                analysisCompleted: 0,
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
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[NumericInline] Failed (non-fatal, keeping client report if any): ${msg}`);
          // Keep whatever numericReport the client provided as fallback
        }
      } else {
        // Insufficient budget to even start numeric — return in_progress for resume
        console.log(`[NumericInline] Insufficient time budget (${numericTimeBudget}ms) — returning in_progress for resume`);
        return {
          status: "in_progress",
          runId: runId!,
          phase: "numeric_verify",
          progress: {
            analysisTotal: 0,
            analysisCompleted: 0,
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
    }
  }

  // --- Step 0.8: Claims-Reconciliation (contradiction_check only) ---
  // Extracts structured claims from IC memos and reconciles against verified figures.
  // Architecture: LLM classifies scope; CODE computes delta. No LLM-computed numbers.
  //
  // CHECKPOINT-RESUME: Persists the claims ledger after extraction and the
  // reconciliation result after completion. On resume, loads both and skips
  // already-finished work. On budget exhaustion, returns in_progress.
  let claimsReconciliation: ReconciliationResult | null = null;
  if (moduleId === "contradiction_check") {
    // Check for persisted reconciliation result from prior invocation
    let reconCheckpointLoaded = false;
    try {
      const reconCpRows = await ctx.integrations.db.query(
        `SELECT payload FROM pipeline_checkpoints
         WHERE module_run_id = $1 AND checkpoint_key = 'reconciliation'`,
        z.object({ payload: z.any() }),
        [runId],
        { label: "Load reconciliation checkpoint" }
      );
      if (reconCpRows.length > 0 && reconCpRows[0].payload) {
        claimsReconciliation = reconCpRows[0].payload as ReconciliationResult;
        reconCheckpointLoaded = true;
        console.log(
          `[ClaimsReconciliation] Loaded checkpoint: ${claimsReconciliation.findings.length} findings ` +
          `(${claimsReconciliation.reconciled_count} reconciled, ` +
          `${claimsReconciliation.unreconcilable_count} unreconcilable)`
        );
      }
    } catch {
      // pipeline_checkpoints may not exist yet
    }

    if (!reconCheckpointLoaded) {
      const claimsTimeBudget = Math.min(120_000, Math.max(0, timeRemaining() - 120_000));
      if (claimsTimeBudget >= 60_000) {
        try {
          // Check for persisted claims ledger from prior invocation
          let claimsLedger: ClaimsLedger | null = null;
          try {
            const ledgerCpRows = await ctx.integrations.db.query(
              `SELECT payload FROM pipeline_checkpoints
               WHERE module_run_id = $1 AND checkpoint_key = 'claims_ledger'`,
              z.object({ payload: z.any() }),
              [runId],
              { label: "Load claims ledger checkpoint" }
            );
            if (ledgerCpRows.length > 0 && ledgerCpRows[0].payload) {
              claimsLedger = ledgerCpRows[0].payload as ClaimsLedger;
              console.log(
                `[ClaimsExtraction] Loaded checkpoint: ${claimsLedger.claims.length} claims ` +
                `(${claimsLedger.extraction_metadata.operating_metric_claims} operating_metric)`
              );
            }
          } catch {
            // pipeline_checkpoints may not exist yet
          }

          // Step 0.8a: Extract structured claims from IC memos (if not checkpointed)
          if (!claimsLedger) {
            claimsLedger = await runClaimsExtraction(
              ctx, dealId, startTime, claimsTimeBudget * 0.5
            );
            // Persist ledger so resume never re-runs LLM extraction
            try {
              await ctx.integrations.db.execute(
                `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload)
                 VALUES ($1, 'claims_ledger', $2::jsonb)
                 ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
                [runId, JSON.stringify(claimsLedger)],
                { label: "Persist claims ledger checkpoint" }
              );
            } catch {
              // pipeline_checkpoints table may not exist yet — non-fatal
            }
          }

          // Step 0.8b: Reconcile claims against verified figures
          if (claimsLedger.claims.length > 0 && numericReport) {
            const reconTimeBudget = Math.min(90_000, Math.max(0, timeRemaining() - 90_000));
            if (reconTimeBudget >= 45_000) {
              claimsReconciliation = await runReconciliation(
                ctx,
                claimsLedger,
                numericReport.figures ?? [],
                numericReport.discrepancies ?? [],
                startTime,
                reconTimeBudget,
              );
              console.log(
                `[ClaimsReconciliation] ${claimsReconciliation.findings.length} findings ` +
                `(${claimsReconciliation.reconciled_count} reconciled, ` +
                `${claimsReconciliation.within_tolerance_count} within tolerance, ` +
                `${claimsReconciliation.unreconcilable_count} unreconcilable)`
              );
              // Persist reconciliation result so resume skips re-running
              try {
                await ctx.integrations.db.execute(
                  `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload)
                   VALUES ($1, 'reconciliation', $2::jsonb)
                   ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
                  [runId, JSON.stringify(claimsReconciliation)],
                  { label: "Persist reconciliation checkpoint" }
                );
              } catch {
                // pipeline_checkpoints table may not exist yet — non-fatal
              }
            } else {
              // Budget exhausted before reconciliation could start — return in_progress
              console.log(`[ClaimsReconciliation] Insufficient time for reconciliation (${reconTimeBudget}ms) — returning in_progress`);
              return {
                status: "in_progress",
                runId: runId!,
                phase: "reconciliation",
                progress: {
                  analysisTotal: 0,
                  analysisCompleted: 0,
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
          } else if (claimsLedger.claims.length === 0) {
            console.log(`[ClaimsReconciliation] No claims extracted — skipping reconciliation`);
          } else {
            console.log(`[ClaimsReconciliation] No numeric report available — skipping reconciliation`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[ClaimsReconciliation] Failed (non-fatal): ${msg}`);
        }
      } else {
        // Budget exhausted before claims extraction could start — return in_progress
        console.log(`[ClaimsReconciliation] Insufficient time budget (${claimsTimeBudget}ms) — returning in_progress`);
        return {
          status: "in_progress",
          runId: runId!,
          phase: "reconciliation",
          progress: {
            analysisTotal: 0,
            analysisCompleted: 0,
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
    }
  }

  // --- Step 1: Load universal extractions + route ---
  // Page sizes tuned per table to stay under the 4MB gRPC response limit.
  // Row payload varies significantly: extraction_json ~2-4KB, result_json ~3-6KB,
  // merged_json ~8-20KB for intermediate nodes BUT up to 2MB+ for final-round nodes
  // (which accumulate ALL findings from the full run). Page sizes MUST account for
  // the worst-case row in each table, not just the average.
  const EXTRACTION_PAGE_SIZE = 200;  // ~2-4KB/row → ~400-800KB/page
  const ANALYSIS_PAGE_SIZE = 150;    // ~3-6KB/row → ~450-900KB/page
  const MERGE_CP_PAGE_SIZE = 20;     // Reduced from 75: final-round nodes can be 200KB-2MB each
                                       // (381 findings × 3-10KB/finding + mergedText). At 20 rows/page,
                                       // worst case = ~2-3MB/page, safely under 4MB gRPC limit.
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
    const errMsg = "No extraction chunks matched this module's document tags (check document tagging)";
    await markRunFailed(ctx.integrations.db, runId!, errMsg, "routing", dealId, moduleId);
    return {
      status: "failed",
      runId: runId!,
      phase: "routing",
      progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
      result: null,
      firstError: errMsg,
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
          `INSERT INTO pipeline_analysis (run_id, chunk_index, result_json, model_used, prompt_version)
           VALUES ($1, $2, $3::jsonb, $4, $5)
           ON CONFLICT (run_id, chunk_index) DO UPDATE SET result_json = $3::jsonb, model_used = $4, prompt_version = $5`,
          [runId, row.iteration - 1, JSON.stringify({ label, extraction, chunkIndex: row.iteration - 1 }), getModuleModel(moduleId), getPipelineVersion()],
          { label: `Inject iteration ${row.iteration} as analysis` }
        );
      }
      console.log(`[WebResearch] Injected ${iterRows.length} iterations as analysis checkpoints`);
    }
  }

  // --- Step 2: Sub-agent analysis (with checkpointing) ---
  // For web research modules, iterations have already been injected as analysis
  // checkpoints above — this step will see them all as "already analyzed" and skip.
  const currentVersion = getPipelineVersion();
  const analyzedRows = await ctx.integrations.db.query(
    `SELECT chunk_index FROM pipeline_analysis
     WHERE run_id = $1 AND prompt_version = $2
     ORDER BY chunk_index`,
    AnalysisCheckpointSchema,
    [runId, currentVersion],
    { label: "Load analysis checkpoints (version-matched)" }
  );

  // Version mismatch detection: check if there are ANY rows for this run with a
  // DIFFERENT prompt_version OR null (pre-versioning = stale by definition).
  const staleRows = await ctx.integrations.db.query(
    `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis
     WHERE run_id = $1 AND (prompt_version IS NULL OR prompt_version != $2)`,
    z.object({ cnt: z.coerce.number() }),
    [runId, currentVersion],
    { label: "Check for stale analysis checkpoints" }
  );

  if (staleRows.length > 0 && staleRows[0].cnt > 0) {
    // Stale checkpoints detected — cannot resume this run. Create a new run_id.
    const errMsg = `VERSION MISMATCH: ${staleRows[0].cnt} analysis rows have a different prompt_version than current (${currentVersion}). Starting fresh run.`;
    console.error(`[pipeline] ${errMsg}`);

    // Create a brand new run instead of reusing this stale one
    const freshRunRows = await ctx.integrations.db.query(
      `INSERT INTO module_runs (deal_id, module_id, status)
       VALUES ($1, $2, 'running'::module_status)
       RETURNING id AS run_id`,
      RunIdSchema,
      [dealId, moduleId],
      { label: "Create fresh run (version mismatch)" }
    );
    const freshRunId = freshRunRows[0].run_id;
    console.log(`[pipeline] Created fresh run ${freshRunId} (replacing stale ${runId})`);

    // Mark the old run as failed with error capture
    await markRunFailed(ctx.integrations.db, runId!, errMsg, "version_mismatch", dealId, moduleId);

    // Recurse with the new run_id (this is safe — it will enter the fresh-start path)
    return runPipelineCore(ctx, { ...input, runId: freshRunId });
  }

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
  let mergeGroupsFallenBack = 0; // groups that exhausted MAX_MERGE_GROUP_FAILURES and used fallback text
  let firstError: string | null = null;

  // --- Checklist Coverage Scan (runs once, before analysis) ---
  // Exhaustive full-text search across ALL document chunks for each
  // diligence checklist category. Produces authoritative coverage map
  // that prevents sub-agents AND the merge layer from fabricating absence claims.
  const CHECKLIST_MODULES = new Set(["omission_audit", "blind_spot_scanner", "diligence_completeness"]);
  let coverageMapBlock = "";
  let dealProcessContextBlock = "";
  if (CHECKLIST_MODULES.has(moduleId)) {
    try {
      const scanResult = await runChecklistScan(ctx, dealId, input.subjectDocumentIds ?? []);
      coverageMapBlock = "\n\n" + formatCoverageMapForPrompt(scanResult);
      console.log(`[pipeline] Checklist scan complete: ${scanResult.coveredCount} covered, ${scanResult.notFoundCount} not found (${scanResult.scanDurationMs}ms, ${scanResult.totalQueries} queries)`);
    } catch (scanErr) {
      console.warn("[pipeline] Checklist scan failed (non-fatal, proceeding without coverage map):", scanErr);
    }

    // Fix 5: Extract deal-process context (DD/adviser table with post-IC staging)
    // Search for workstreams explicitly staged "post IC" or "kick off post IC" in the deal documents.
    // These are ground truth: work the record stages post-IC is open_item_acknowledged, never an omission.
    try {
      const processRows = await ctx.integrations.db.query(
        `SELECT dc.file_name, dc.chunk_text
         FROM document_chunks dc
         JOIN deal_documents dd ON dd.id = dc.document_id
         WHERE dd.deal_id = $1
           AND dc.chunk_text_search @@ to_tsquery('english', 'adviser | advisor | workstream | "kick off" | "post IC" | "due diligence" & provider')
         ORDER BY ts_rank_cd(dc.chunk_text_search, to_tsquery('english', 'adviser | advisor | workstream | "kick off" | "post IC"')) DESC
         LIMIT 5`,
        z.object({ file_name: z.string(), chunk_text: z.string() }),
        [dealId],
        { label: "Fix 5: Extract DD/adviser table context" }
      );
      if (processRows.length > 0) {
        const contextLines = [
          "\n\n## DEAL-PROCESS CONTEXT — Staged Workstreams (Ground Truth)",
          "",
          "The following excerpts from the deal's own documents describe workstreams explicitly",
          "staged for post-IC or post-close completion. These are OPEN ITEMS by design, NOT omissions.",
          "Any finding that flags an item listed here as 'missing' or 'absent' MUST be reclassified",
          "as gap_type = 'open_item_acknowledged' — the record itself discloses these as pending.",
          "",
        ];
        for (const row of processRows) {
          contextLines.push(`### From: ${row.file_name}`);
          contextLines.push(`> ${row.chunk_text.slice(0, 500)}`);
          contextLines.push("");
        }
        dealProcessContextBlock = contextLines.join("\n");
      }
    } catch (processErr) {
      console.warn("[pipeline] Deal-process context extraction failed (non-fatal):", processErr);
    }
  }

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
    // Batch-aware graceful exit: don't launch if the real platform clock can't
    // accommodate worst-case batch (1 full attempt + checkpoint I/O reserve).
    // FE4's HeadroomExhaustedError already gates any second attempt dynamically
    // at retry-time — this pre-batch check only guarantees room for ONE attempt.
    const ANALYSIS_CALL_TIMEOUT = 120_000;
    const analysisBatchWorstCase = ANALYSIS_CALL_TIMEOUT + CHECKPOINT_RESERVE_MS; // 160s
    const platformDeadlineAnalysis = EFFECTIVE_CAP_MS - (Date.now() - startTime);
    if (platformDeadlineAnalysis < analysisBatchWorstCase) {
      console.log(`[pipeline:graceful-exit] Analysis phase — platformDeadline=${Math.round(platformDeadlineAnalysis / 1000)}s < batchWorstCase=${Math.round(analysisBatchWorstCase / 1000)}s — returning in_progress`);
      return returnInProgress("analysis");
    }

    const batchSize = platformDeadlineAnalysis < 90_000 ? 5 : ANALYSIS_CONCURRENCY;
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

        const userContent = `--- Extracted text from "${chunkLabel}" ---\n\n${chunkText}\n\nAnalyze this chunk now.${coverageMapBlock}`;

        const result = await callAnthropic(
          ctx,
          {
            model: getModuleModel(moduleId),
            max_tokens: SUB_AGENT_MAX_TOKENS,
            system: [{ type: "text", text: subAgentPrompt, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: userContent }],
          },
          `Sub-agent: ${chunkLabel} (${globalIdx + 1}/${routed.length})`,
          3,
          120_000,
          startTime
        );

        const textBlock = result.content.find((c: { type: string }) => c.type === "text");
        const extraction = `### Extraction from: ${chunkLabel}\n\n${textBlock?.text ?? ""}`;
        const truncated = result.stop_reason === "max_tokens";

        // Save checkpoint (flag truncated responses so thin findings are traceable)
        await ctx.integrations.db.execute(
          `INSERT INTO pipeline_analysis (run_id, chunk_index, result_json, model_used, prompt_version)
           VALUES ($1, $2, $3::jsonb, $4, $5)
           ON CONFLICT (run_id, chunk_index) DO UPDATE SET result_json = $3::jsonb, model_used = $4, prompt_version = $5`,
          [runId, globalIdx, JSON.stringify({ label: chunkLabel, extraction, chunkIndex: globalIdx, truncated }), getModuleModel(moduleId), currentVersion],
          { label: `Save analysis checkpoint ${globalIdx}` }
        );

        return { label: chunkLabel, extraction, chunkIndex: globalIdx, truncated };
      })
    );

    // Count successes and track failures
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        analysisCompleted++;
        if (r.value.truncated) truncatedChunks++;
      } else {
        failedChunks++;
        const failedRow = batch[i];
        const failedLabel = (() => {
          try {
            const ext = typeof failedRow.extraction_json === "string" ? JSON.parse(failedRow.extraction_json) : failedRow.extraction_json;
            return ext.label ?? `Chunk ${routed.indexOf(failedRow)}`;
          } catch { return `Chunk (batch index ${i})`; }
        })();
        const errMsg = r.reason?.message ?? String(r.reason ?? "Unknown error");
        console.error(`[ANALYSIS FAILED] ${failedLabel} | error: ${errMsg}`);
        if (!firstError) firstError = errMsg;
      }
    }

    // Refresh triggered_at so long multi-pass runs aren't purged as stale
    await ctx.integrations.db.execute(
      `UPDATE module_runs SET triggered_at = now() WHERE id = $1`,
      [runId],
      { label: "Refresh triggered_at (checkpoint heartbeat)" }
    );

    // === CANCEL GATE: between analysis batches ===
    if (await checkCancelled(ctx, runId, "analysis_batch")) return cancelledResult(runId, "analysis_batch");

    // Post-batch graceful exit (redundant with top-of-loop, but catches batches
    // that completed faster than worst-case — allows immediate exit without re-entering loop header)
    const postBatchDeadlineAnalysis = EFFECTIVE_CAP_MS - (Date.now() - startTime);
    if (postBatchDeadlineAnalysis < analysisBatchWorstCase) {
      console.log(`[pipeline:graceful-exit] Analysis post-batch — platformDeadline=${Math.round(postBatchDeadlineAnalysis / 1000)}s — returning in_progress`);
      return returnInProgress("analysis");
    }
  }

  // --- Chunk Coverage Log (per-document in vs. processed) ---
  {
    const docCoverage = new Map<string, { total: number; analyzed: number }>();
    for (const row of routed) {
      const ext = typeof row.extraction_json === "string" ? JSON.parse(row.extraction_json) : row.extraction_json;
      const label = String(ext.label ?? "unknown").replace(/ \(part \d+\)$/, "");
      if (!docCoverage.has(label)) docCoverage.set(label, { total: 0, analyzed: 0 });
      docCoverage.get(label)!.total++;
    }
    // Count analyzed from DB (already stored checkpoint rows)
    const analyzedIndicesNow = await ctx.integrations.db.query(
      `SELECT chunk_index FROM pipeline_analysis WHERE run_id = $1`,
      z.object({ chunk_index: z.coerce.number() }),
      [runId],
      { label: "Coverage log: count analyzed rows" }
    );
    const analyzedSetNow = new Set(analyzedIndicesNow.map(r => r.chunk_index));
    for (let i = 0; i < routed.length; i++) {
      const ext = typeof routed[i].extraction_json === "string" ? JSON.parse(routed[i].extraction_json) : routed[i].extraction_json;
      const label = String(ext.label ?? "unknown").replace(/ \(part \d+\)$/, "");
      if (analyzedSetNow.has(i)) docCoverage.get(label)!.analyzed++;
    }
    const lines = [`[CHUNK COVERAGE] run=${runId} module=${moduleId}`];
    for (const [doc, counts] of docCoverage) {
      const status = counts.analyzed === counts.total ? "✓" : "⚠ DROPPED";
      lines.push(`  ${status} ${doc}: ${counts.analyzed}/${counts.total} chunks analyzed`);
    }
    lines.push(`  TOTAL: ${analyzedSetNow.size}/${routed.length} (${failedChunks} failed this invocation)`);
    console.log(lines.join("\n"));
  }

  // === CANCEL GATE: post-analysis ===
  if (await checkCancelled(ctx, runId, "post_analysis")) return cancelledResult(runId, "post_analysis");

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
    const errMsg = firstError ?? "All chunks failed or no analysis results produced";
    await markRunFailed(ctx.integrations.db, runId!, errMsg, "analysis", dealId, moduleId);
    return {
      status: "failed",
      runId: runId!,
      phase: "analysis",
      progress: { analysisTotal: routed.length, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
      result: null,
      failedChunks,
      firstError: errMsg,
    };
  }

  // --- Step 4: Tree-reduce merge (with checkpointing) ---
  interface MergeNode {
    text: string;
    executiveHeader: string;
    findings: MergedFinding[];
    housekeepingFindings?: MergedFinding[];
    truncated?: boolean; // true when stop_reason was "max_tokens" — findings may be thin
  }

  // Load existing merge checkpoints (paginated).
  // CRITICAL: Strip `text` field from merged_json using `- 'text'` to prevent
  // the final-round node (which accumulates ALL findings → can be >4MB) from
  // breaching the gRPC 4MB response limit. `text` is reconstructable from
  // findings via buildMergedText() and is only needed for the final output.
  const mergeCheckpoints: Array<{ tree_level: number; node_index: number; merged_json: any }> = [];
  let mcOffset = 0;
  while (true) {
    const page = await ctx.integrations.db.query(
      `SELECT tree_level, node_index, (merged_json - 'text') AS merged_json
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
    // `text` is stripped from the query (gRPC 4MB safety) — reconstruct from findings
    const findings = (data.findings ?? []) as MergedFinding[];
    const executiveHeader = String(data.executiveHeader ?? "");
    checkpointMap.set(cpKey, {
      text: data.text ? String(data.text) : buildMergedText(executiveHeader, findings),
      executiveHeader,
      findings,
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
  let accumulatedHousekeeping: MergedFinding[] = [];

  // Build numeric block for merge
  // Architecture: figures = trustworthy cell values (flag where narrative disagrees);
  //               discrepancies = cross-agreement only (live vs frozen reference sheet).
  const hasNumericData = !!(numericReport && NUMERIC_MODULES.has(moduleId) &&
    (numericReport.figures.length > 0 || numericReport.discrepancies.length > 0));

  let numericBlock = "";
  if (hasNumericData && numericReport) {
    numericBlock = `\n\n## Numeric Verification Report\n*Source: deterministic cell-value reads from the financial model*\n\n`;

    // Cross-agreement discrepancies — inject ONLY the rolled-up per-period summary.
    // Each discrepancy.description contains the headline + material-tier lines (bounded).
    // The full detail (all 90+ metrics) is stored in .metrics[] for the tiered report UI
    // but NOT dumped into the merge prompt (would bloat it and cause line-item contradictions).
    if (numericReport.discrepancies.length > 0) {
      numericBlock += `### Cross-Version Divergences\n`;
      numericBlock += `*These are differences between the live model and a frozen reference. Confirm whether each reflects an intentional update or a stale/contradictory reference.*\n\n`;
      for (const d of numericReport.discrepancies) {
        const disc = d as Record<string, unknown>;
        // Prefer the headline (compact one-liner) when available; fall back to description
        const headline = disc.headline as string | undefined;
        if (headline) {
          numericBlock += `**${String(disc.period ?? "Unknown")}:** ${headline}\n\n`;
        }
        // Material movements summary (already bounded to tier-2 lines in description)
        numericBlock += `${String(disc.description)}\n\n`;
      }
    }

    // Verified figures — trustworthy values for narrative comparison
    if (numericReport.figures.length > 0) {
      numericBlock += `### Verified Figures (Trustworthy Cell Values)\n`;
      numericBlock += `*Flag where narrative claims disagree with these code-read values.*\n\n`;
      const MAX_FIG_DISPLAY = 200;
      const figuresArr = numericReport.figures as Array<Record<string, unknown>>;
      if (figuresArr.length > MAX_FIG_DISPLAY) {
        console.warn(`[pipeline-core] numeric figures capped at ${MAX_FIG_DISPLAY} (had ${figuresArr.length})`);
      }
      for (const fig of figuresArr.slice(0, MAX_FIG_DISPLAY)) {
        numericBlock += `- **${String(fig.name)}** (${String(fig.period ?? "")}): ${fig.value} @ ${String(fig.source_cell)}\n`;
      }
    }
  }

  // Prepare base merge prompt (numeric blocks are static, findings rule varies per round)
  let baseMergePrompt = rawMergePrompt;
  if (hasNumericData) {
    const numericVerifInst = `## NUMERIC VERIFICATION — TRUSTWORTHY VALUES

A "## Numeric Verification Report" section appears in the input below. It contains cell values read directly from the financial model by code — NOT by AI inference. You MUST:
- Treat every "Verified Figure" as a trustworthy cell value from the model
- Flag where NARRATIVE claims (from CIM, IC memo, management presentations) disagree with these values — that is a potential contradiction ONLY IF same metric + same scope + same period
- "Cross-Version Divergences" compare the live model to a frozen reference; frame these as "confirm intentional revision vs stale reference," not as asserted errors
- Never invent or re-derive figures — only cite values that appear in the Verified Figures list
- Do NOT treat absence from the list as evidence of a problem — the list covers configured metrics only
- SCOPE RULE: A narrative figure (e.g., "Total Revenue (PF) £194m") contradicts a model figure ONLY if the scope qualifiers match exactly. "Total Revenue (PF)" and "Total revenue (excl. future M&A)" are DIFFERENT metrics — flag as a hedged scope-mismatch note, not a contradiction${numericPartial ? `

⚠️ PARTIAL COVERAGE: The engine ran out of time before processing all tables. Verified Figures are correct for what was analyzed, but coverage is incomplete.` : ""}`;
    baseMergePrompt = baseMergePrompt.replace("{{NUMERIC_VERIFICATION_BLOCK}}", numericVerifInst);
    baseMergePrompt = baseMergePrompt.replace("{{NUMERIC_TASK_STEP_1}}",
      "**Cross-Version Divergences First**: If the Numeric Verification Report contains cross-version divergences, assess each cluster and report as findings where they indicate stale references or contradictions (not merely intentional updates).\n");
  } else {
    baseMergePrompt = baseMergePrompt.replace("{{NUMERIC_VERIFICATION_BLOCK}}", "");
    baseMergePrompt = baseMergePrompt.replace("{{NUMERIC_TASK_STEP_1}}", "");
  }

  // Inject authoritative filename→tag reference so the model uses real tags
  // rather than guessing from filenames when classifying gap_type and evidence_docs.
  // This is appended to the system prompt for all merge rounds.
  const tagMapLines = Array.from(fileTagMap.entries())
    .map(([fn, tag]) => `  "${fn}" → ${tag}`)
    .join("\n");
  const tagMapBlock = tagMapLines.length > 0
    ? `\n\n## Document Tag Reference (authoritative — do NOT infer tags from filenames)\n\n${tagMapLines}\n\nUse these tags to classify evidence_docs accurately. A document is an IC memo ONLY if its tag is "ic_memo".`
    : "";
  baseMergePrompt += tagMapBlock;

  // --- Inject subject identity block: chronologically ordered IC memo record ---
  const subjectDocumentIds: string[] = input.subjectDocumentIds ?? [];
  const subjectFiles = subjectDocumentIds
    .map((id) => ({ id, fileName: idToFileName.get(id) ?? id }))
    .map(({ id, fileName }) => {
      const date = parseDateFromFileName(fileName);
      return { id, fileName, date };
    });

  // Sort: undated first (treated as earliest), then by date ascending. LATEST = max dated.
  subjectFiles.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return -1;
    if (!b.date) return 1;
    return a.date.localeCompare(b.date);
  });

  const subjectIdentityBlock = subjectFiles.length > 0
    ? `\n\n## Subject Under Review — The IC Memo Record

The following document(s) collectively constitute the IC memo record under review, listed chronologically (earliest to latest):

${subjectFiles.map((f, i) => `  ${i + 1}. "${f.fileName}"${f.date ? ` (date: ${f.date})` : " (undated \u2014 treated as earliest)"}`).join("\n")}

The LATEST memo is authoritative for the team's CURRENT claims and thesis. Earlier memos establish what was previously disclosed, asserted, or committed to.`
    : "";
  baseMergePrompt += subjectIdentityBlock;

  // Hierarchical merge loop — collapses N nodes → 1 across multiple rounds.
  // STALENESS SAFETY: triggered_at is refreshed after each batch (see line below
  // "Refresh triggered_at (merge batch heartbeat)"). Under STALENESS_THRESHOLD_MINUTES=12
  // and a 600s cap, the worst-case inter-heartbeat gap is ~1 merge batch (~30-60s),
  // well within the 12-minute threshold. If the cap is raised further, the per-batch
  // heartbeat still fires often enough — unless a single merge call exceeds 12 min,
  // which would require re-visiting the threshold derivation.
  while (nodes.length > 1) {
    currentRound++;

    // === CANCEL GATE: between merge rounds ===
    if (await checkCancelled(ctx, runId, "merge_round")) return cancelledResult(runId, "merge_round");

    // Batch-aware graceful exit: use the real platform clock, not TIME_BUDGET.
    // Merge: timeoutCap varies by round. Worst case = 1× timeoutCap + checkpoint reserve.
    // FE4's HeadroomExhaustedError gates retries dynamically — no need to pre-provision 2×.
    const roundTimeoutCap = currentRound >= 2 ? 180_000 : 165_000;
    const mergeBatchWorstCase = roundTimeoutCap + CHECKPOINT_RESERVE_MS;
    const platformDeadlineMergeRound = EFFECTIVE_CAP_MS - (Date.now() - startTime);
    if (platformDeadlineMergeRound < mergeBatchWorstCase) {
      console.log(`[pipeline:graceful-exit] Merge between-rounds — platformDeadline=${Math.round(platformDeadlineMergeRound / 1000)}s < batchWorstCase=${Math.round(mergeBatchWorstCase / 1000)}s (R${currentRound}, cap=${roundTimeoutCap / 1000}s) — returning in_progress`);
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
        mergeGroupsFallenBack++;
        const memberFindings = group.members.flatMap(m => m.findings ?? []);
        accumulatedFindings.push(...memberFindings);
        const fallback: MergeNode = { text: group.members[0].text, executiveHeader: "Merge skipped (repeated failures)", findings: memberFindings };
        nextNodes[group.idx] = fallback;
        groupsDone++;
        // Save a non-error checkpoint so the group is permanently resolved
        await ctx.integrations.db.execute(
          `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6)
           ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE SET merged_json = $4::jsonb, model_used = $5, prompt_version = $6`,
          [runId, currentRound, group.idx, JSON.stringify({ text: fallback.text, executiveHeader: fallback.executiveHeader, findings: fallback.findings, skippedAfterFailures: priorFailures, lastError }), getModuleModel(moduleId, useOpus), currentVersion],
          { label: `Save fallback checkpoint R${currentRound}:G${group.idx} (skipped after ${priorFailures} failures)` }
        );
        continue;
      }
      pendingGroups.push(group);
    }

    // Process pending groups in batches (parallel within batch, sequential across batches)
    for (let bStart = 0; bStart < pendingGroups.length; ) {
      // Batch-aware graceful exit: real platform clock against worst-case batch duration
      const platformDeadlineMergeBatch = EFFECTIVE_CAP_MS - (Date.now() - startTime);
      if (platformDeadlineMergeBatch < mergeBatchWorstCase) {
        console.log(`[pipeline:graceful-exit] Merge between-batches — platformDeadline=${Math.round(platformDeadlineMergeBatch / 1000)}s < batchWorstCase=${Math.round(mergeBatchWorstCase / 1000)}s (R${currentRound}, done=${groupsDone}/${totalGroupsThisRound}) — returning in_progress`);
        return returnInProgress("merge", currentRound - 1, groupsDone, totalGroupsThisRound);
      }

      const batchSize = platformDeadlineMergeBatch < 90_000 ? Math.min(3, MERGE_CONCURRENCY) : MERGE_CONCURRENCY;
      const batch = pendingGroups.slice(bStart, bStart + batchSize);
      bStart += batchSize;

      const results = await Promise.allSettled(
        batch.map(async (group) => {
          const setBlocks = group.members.map((m, i) => `## Analysis Set ${i + 1}\n\n${truncateMergeNodeText(m.text, MERGE_NODE_TEXT_CAP)}`);
          const mergeInput = setBlocks.join("\n\n---\n\n") + numericBlock + coverageMapBlock + dealProcessContextBlock;

          // Dynamic timeout: later rounds have much larger payloads and need more time.
          // Round 0-1: cap at 165s (raised from 120s — Freeze Exception #3, prompt growth).
          // Round 2+: cap at 180s (final merge can be very large).
          // Merge calls run in parallel within a batch (MERGE_CONCURRENCY=5),
          // so a batch takes ~maxTimeout wall-clock, not N×maxTimeout.
          const timeoutCap = currentRound >= 2 ? 180_000 : 165_000;
          const perCallTimeout = Math.min(timeoutCap, Math.max(30_000, timeRemaining() - 30_000));
          console.log(`[pipeline:merge] R${currentRound}:G${group.idx + 1}/${totalGroupsThisRound} — timeout=${Math.round(perCallTimeout / 1000)}s, budget=${Math.round(timeRemaining() / 1000)}s, inputLen=${setBlocks.join("").length}`);
          const mergeResult = await callAnthropic(
            ctx,
            {
              model: getModuleModel(moduleId, useOpus),
              max_tokens: MERGE_MAX_TOKENS,
              system: [{ type: "text", text: mergePrompt, cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: mergeInput }],
            },
            `Merge R${currentRound} G${group.idx + 1}/${totalGroupsThisRound}`,
            2, // 2 attempts, 1 retry
            perCallTimeout,
            startTime
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
                  ...(f.absence_confidence === "verified_absent" ||
                    f.absence_confidence === "likely_absent" ||
                    f.absence_confidence === "unverified"
                    ? { absence_confidence: f.absence_confidence as string }
                    : {}),
                  ...(f.gap_type === "diligence_gap" || f.gap_type === "memo_omission" || f.gap_type === "open_item_acknowledged"
                    ? { gap_type: f.gap_type as "diligence_gap" | "memo_omission" | "open_item_acknowledged" }
                    : {}),
                  ...(Array.isArray(f.evidence_docs) && f.evidence_docs.length > 0
                    ? { evidence_docs: f.evidence_docs.map(String) }
                    : {}),
                  ...(typeof f.independent === "boolean"
                    ? { independent: f.independent }
                    : {}),
                  ...(typeof f.severity_anchor === "string" ? { severity_anchor: f.severity_anchor } : {}),
                  ...(f.finding_kind === "data_divergence" || f.finding_kind === "source_stated_risk" || f.finding_kind === "absence_claim" || f.finding_kind === "process_observation"
                    ? { finding_kind: f.finding_kind as "data_divergence" | "source_stated_risk" | "absence_claim" | "process_observation" }
                    : {}),
                }));
              }
            } catch { /* parse failure — use empty findings */ }
          }

          // Fix #3: Code-derived source_docs from claim_id provenance.
          // The LLM must not choose the source document — derive it deterministically
          // from the claim_id's extraction origin. "c5-2" → routed[5].document_id → filename.
          for (const f of findings) {
            if (!f.claim_ids || f.claim_ids.length === 0) continue;
            const derivedSources = new Set<string>();
            for (const cid of f.claim_ids) {
              const match = String(cid).match(/^c(\d+)-/);
              if (!match) continue;
              const chunkIdx = parseInt(match[1], 10);
              if (chunkIdx >= 0 && chunkIdx < routed.length) {
                const docId = routed[chunkIdx].document_id;
                const fileName = idToFileName.get(docId);
                if (fileName) derivedSources.add(fileName);
              }
            }
            if (derivedSources.size > 0) {
              const original = f.source_docs?.join(", ") ?? "(none)";
              (f as any).source_docs = Array.from(derivedSources);
              if (original !== (f as any).source_docs.join(", ")) {
                console.log(`[Merge][Fix3-Provenance] "${f.title}" source_docs overridden: ${original} → ${(f as any).source_docs.join(", ")}`);
              }
            }
          }

          // CODE BACKSTOP: absence-verification gate — any finding asserting
          // something is missing/absent/not-confirmed must carry verified absence
          // confidence or be capped at info. Gates on claim shape, not gap_type alone.
          const ABSENCE_PATTERNS = /\b(does not confirm|does not disclose|absent|not disclosed|missing|no mention|fails to address|not addressed|not confirmed|no evidence of|no reference to|omits?|silent on|does not discuss|not discussed)\b/i;

          // Fix #2 (tightened): Data-divergence findings are exempt from the absence cap.
          // Exemption requires EITHER:
          //   (a) finding_kind === "data_divergence" (LLM-tagged at source), OR
          //   (b) severity_anchor carries a delta signature: two currency values,
          //       a signed delta (−£1.8m), or comparison words (vs/differs/higher/lower).
          // A bare "£5.3m" does NOT qualify — it must show a comparison.
          const DELTA_SIGNATURE_PATTERN = /([£$€][\d.,]+[kmbn]*\s*(vs|versus|\/|→|to)\s*[£$€][\d.,]+|[−\-–][£$€]\s*[\d.,]+|[£$€]\s*[−\-–]\s*[\d.,]+|\b(differs? by|lower than|higher than|exceeds.*by|shortfall of|gap of|delta of|revision of|decline of|increase of)\b.*[£$€])/i;

          for (const f of findings) {
            // Exemption: data_divergence finding_kind OR delta signature in anchor
            const isDataDivergence = (f as any).finding_kind === "data_divergence";
            const hasDeltaSignature = typeof (f as any).severity_anchor === "string" &&
              DELTA_SIGNATURE_PATTERN.test((f as any).severity_anchor);
            if (isDataDivergence || hasDeltaSignature) continue;

            // Original gap_type gate (backward compat)
            const hasAbsenceGapType = f.gap_type === "memo_omission" || f.gap_type === "open_item_acknowledged";
            // Broadened: claim-shape detection on any module's findings
            const assertsAbsence = !hasAbsenceGapType &&
              (ABSENCE_PATTERNS.test(f.full_analysis || "") || ABSENCE_PATTERNS.test(f.detail || ""));

            if ((hasAbsenceGapType || assertsAbsence) && f.absence_confidence !== "verified_absent") {
              if (!f.absence_confidence) {
                (f as any).absence_confidence = "unverified";
              }
              if (f.severity === "critical" || f.severity === "warning") {
                const original = f.severity;
                (f as any).severity = "info";
                console.log(`[Merge][FixA] Absence cap applied: "${f.title}" | ${original} → info`);
              }
            }
          }

          // Parse housekeeping appendix (demoted findings — Fix 4/6)
          const housekeepingRaw = extractTag(mergeText, "housekeeping_appendix");
          let housekeepingFindings: MergedFinding[] = [];
          if (housekeepingRaw) {
            try {
              const parsed = JSON.parse(housekeepingRaw);
              if (Array.isArray(parsed)) {
                housekeepingFindings = parsed.map((f: Record<string, unknown>) => ({
                  severity: (f.severity === "critical" || f.severity === "warning" || f.severity === "info") ? f.severity : "info" as const,
                  title: String(f.title ?? "Untitled"),
                  detail: String(f.detail ?? ""),
                  full_analysis: String(f.full_analysis ?? f.detail ?? ""),
                  source_docs: Array.isArray(f.source_docs) ? f.source_docs.map(String) : [],
                  ...(typeof f.materiality_rationale === "string" ? { materiality_rationale: f.materiality_rationale } : {}),
                  ...(f.category === "housekeeping" || f.category === "human_review_flag"
                    ? { category: f.category as string }
                    : { category: "housekeeping" }),
                  ...(typeof f.severity_anchor === "string" ? { severity_anchor: f.severity_anchor } : {}),
                })) as MergedFinding[];
              }
            } catch { /* non-fatal */ }
          }

          // Fix #3: Provenance override for housekeeping findings (same as principal)
          for (const f of housekeepingFindings) {
            const hkClaimIds = (f as any).claim_ids as string[] | undefined;
            if (!hkClaimIds || hkClaimIds.length === 0) continue;
            const derivedSources = new Set<string>();
            for (const cid of hkClaimIds) {
              const match = String(cid).match(/^c(\d+)-/);
              if (!match) continue;
              const chunkIdx = parseInt(match[1], 10);
              if (chunkIdx >= 0 && chunkIdx < routed.length) {
                const docId = routed[chunkIdx].document_id;
                const fileName = idToFileName.get(docId);
                if (fileName) derivedSources.add(fileName);
              }
            }
            if (derivedSources.size > 0) {
              (f as any).source_docs = Array.from(derivedSources);
            }
          }

          // --- Observability: Fix 2 (scope-mismatch) + Fix 3 (severity anchors) ---
          // (placed after housekeeping parse so allMergeFindings includes both sets)
          const allMergeFindings = [...findings, ...housekeepingFindings];
          const scopeMismatches = allMergeFindings.filter(f =>
            f.full_analysis?.includes("[SCOPE_MISMATCH]")
          );
          if (scopeMismatches.length > 0) {
            console.log(`[Merge][Fix2] Scope-qualifier mismatches downgraded (${scopeMismatches.length}):`);
            for (const sm of scopeMismatches) {
              console.log(`  → "${sm.title}" | severity=${sm.severity} | ${sm.detail?.slice(0, 120)}`);
            }
          }
          for (const f of allMergeFindings) {
            if ((f as any).severity_anchor) {
              console.log(`[Merge][Fix3] severity_anchor | "${f.title}" [${f.severity}]: ${(f as any).severity_anchor}`);
            }
          }
          // --- End observability ---

          // Fallback: if findings are empty (model failed to extract), union input
          // members' findings — degrades to unconsolidated duplicates rather than
          // erasing everything below this node in the tree
          if (findings.length === 0) {
            findings = group.members.flatMap(m => m.findings ?? []);
          }

          // Accumulate findings across all rounds so we never lose data
          accumulatedFindings.push(...findings);
          if (housekeepingFindings.length > 0) accumulatedHousekeeping.push(...housekeepingFindings);

          const mergedTextForNode = buildMergedText(executiveHeader, findings);
          const node: MergeNode = { text: mergedTextForNode, executiveHeader, findings, housekeepingFindings: housekeepingFindings.length > 0 ? housekeepingFindings : undefined, truncated };

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
          // Cap `text` in checkpoint to prevent single-row gRPC breach (4MB limit).
          // `text` is reconstructable from findings via buildMergedText() on read-back.
          const MAX_CHECKPOINT_TEXT = 500_000; // ~500KB text cap
          const cpText = node.text.length > MAX_CHECKPOINT_TEXT
            ? node.text.slice(0, MAX_CHECKPOINT_TEXT) + "\n[…checkpoint text truncated]"
            : node.text;
          await ctx.integrations.db.execute(
            `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6)
             ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE SET merged_json = $4::jsonb, model_used = $5, prompt_version = $6`,
            [runId, currentRound, group.idx, JSON.stringify({ text: cpText, executiveHeader: node.executiveHeader, findings: node.findings, housekeepingFindings: node.housekeepingFindings, truncated: node.truncated ?? false }), getModuleModel(moduleId, useOpus), currentVersion],
            { label: `Save merge checkpoint R${currentRound}:G${group.idx}` }
          );
        } else {
          // Merge call failed — use a placeholder so the tree can still reduce
          mergeFailedGroups++;
          const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          console.warn(`[pipeline:merge] Group R${currentRound}:G${group.idx} failed: ${errMsg.slice(0, 200)}`);
          if (!mergeFirstError) {
            mergeFirstError = errMsg;
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
          errorMessageMap.set(errCpKey, errMsg); // preserve latest error message
          await ctx.integrations.db.execute(
            `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6)
             ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE SET merged_json = $4::jsonb, model_used = $5, prompt_version = $6`,
            [runId, currentRound, group.idx, JSON.stringify({ error: errMsg, failureCount: newFailureCount, timestamp: new Date().toISOString() }), getModuleModel(moduleId, useOpus), currentVersion],
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

  // Housekeeping findings: concatenate LLM output + accumulated (includes reconciliation)
  // then dedup. The old `?? accumulatedHousekeeping` dropped reconciliation housekeeping
  // (scope_mismatch, unreconcilable) whenever the merge LLM returned any housekeeping.
  let finalHousekeepingFindings: MergedFinding[] = [
    ...(finalNode.housekeepingFindings ?? []),
    ...accumulatedHousekeeping,
  ];
  {
    const seen = new Set<string>();
    finalHousekeepingFindings = finalHousekeepingFindings.filter(f => {
      const key = (f.title || "").toLowerCase().trim().replace(/\s+/g, " ");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // --- Post-processing: suppress fabricated arithmetic/reconciliation findings ---
  // Only findings grounded in NumericVerify's deterministic output are trustworthy.
  // NOTE: Code-verified reconciliation findings are appended AFTER this filter —
  // they bypass FABRICATED_ARITHMETIC_PATTERNS entirely (they ARE code-verified).
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

  // --- Defect 5, Layer 1: Numeric Divergence Validation (zero-LLM code pass) ---
  // Demotes data_divergence findings that are period-collisions or untraceable.
  // Preserves valid narrative-vs-model comparisons (1 verified + 1 unresolved = pass-through).
  // Runs AFTER fabricated-arithmetic suppression, BEFORE reconciliation append.
  if (numericReport && numericReport.figures.length > 0) {
    // Build verified-figure lookup keyed on (metric_name_lower, period_lower) → value
    const verifiedFigureLookup = new Map<string, string>();
    for (const fig of numericReport.figures as Array<Record<string, unknown>>) {
      const name = String(fig.name ?? "").toLowerCase().trim();
      const period = String(fig.period ?? "").toLowerCase().trim();
      if (name && period) {
        verifiedFigureLookup.set(`${name}|||${period}`, String(fig.value ?? ""));
      }
    }

    // Helper: normalize a numeric string for comparison (strip $, £, %, commas, whitespace)
    const normalizeNumericForLookup = (val: unknown): string | null => {
      if (val == null) return null;
      const s = String(val).replace(/[$£€%,\s]/g, "").trim();
      return s.length > 0 ? s : null;
    };

    // Helper: extract numeric figure strings from text via regex
    const extractNumericFigures = (text: string): string[] => {
      // Matches currency/number patterns like £194m, $12.5M, 15.3%, 1,234, etc.
      const patterns = text.match(/[$£€]?\d[\d,]*\.?\d*[MmBbKk%]?/g);
      return patterns ? [...new Set(patterns)] : [];
    };

    let numDivDemotedCount = 0;
    finalFindings = finalFindings.map(f => {
      // Only process data_divergence findings that are NOT already code-verified
      if (f.finding_kind !== "data_divergence") return f;
      if (f.numeric_unverified === false) return f; // already verified by prior pass

      // Extract cited figures — prefer structured evidence[] coordinates
      let citedFigures: Array<{ value: string; source_doc?: string; metric?: string; period?: string }> = [];
      if (f.evidence && f.evidence.length > 0) {
        citedFigures = f.evidence.map(e => ({
          value: e.figure,
          source_doc: e.source_doc,
          // Evidence entries may carry structured metric/period coordinates (cast to access optional fields)
          metric: (e as Record<string, unknown>).metric as string | undefined,
          period: (e as Record<string, unknown>).period as string | undefined,
        }));
      } else {
        // Fallback: extract figures from title + detail text
        const allText = `${f.title} ${f.detail}`;
        citedFigures = extractNumericFigures(allText).map(v => ({ value: v }));
      }

      if (citedFigures.length === 0) return f; // No figures to validate — pass through

      // Resolve each cited figure against the verified-figure lookup
      let resolvedCount = 0;
      let unresolvedCount = 0;
      const resolvedPeriods: string[] = [];
      const resolvedMetrics: string[] = [];

      for (const cited of citedFigures) {
        let matched = false;

        // Priority 1: Coordinate-based resolution — if evidence carries metric+period, resolve directly
        if (cited.metric && cited.period) {
          const coordKey = `${cited.metric.toLowerCase().trim()}|||${cited.period.toLowerCase().trim()}`;
          if (verifiedFigureLookup.has(coordKey)) {
            const [metric, period] = coordKey.split("|||");
            resolvedMetrics.push(metric);
            resolvedPeriods.push(period);
            matched = true;
            resolvedCount++;
          }
          // If coordinate present but not found in lookup → unresolved (don't fall through to value match)
          if (!matched) { unresolvedCount++; }
          continue;
        }

        // Priority 2: Value-based fallback — scan lookup for matching numeric value
        const normalizedCited = normalizeNumericForLookup(cited.value);
        if (!normalizedCited) { unresolvedCount++; continue; }

        for (const [key, verifiedValue] of verifiedFigureLookup.entries()) {
          const normalizedVerified = normalizeNumericForLookup(verifiedValue);
          if (!normalizedVerified) continue;

          // Check if the cited figure matches this verified figure's value
          if (normalizedCited === normalizedVerified ||
              normalizedCited.replace(/[MmBb]$/, "000000").replace(/[Kk]$/, "000") ===
              normalizedVerified.replace(/[MmBb]$/, "000000").replace(/[Kk]$/, "000")) {
            const [metric, period] = key.split("|||");
            resolvedMetrics.push(metric);
            resolvedPeriods.push(period);
            matched = true;
            resolvedCount++;
            break;
          }
        }
        if (!matched) unresolvedCount++;
      }

      // Apply demotion rules:
      // Rule 1: ZERO resolved → untraceable → demote
      if (resolvedCount === 0) {
        numDivDemotedCount++;
        return {
          ...f,
          numeric_unverified: true,
          severity: "info" as const,
          category: "housekeeping" as const,
          full_analysis: `[UNVERIFIED_DIVERGENCE] ${f.full_analysis}`,
        };
      }

      // Rule 2: 2+ resolved to same metric at DIFFERENT periods → period-collision → demote
      if (resolvedCount >= 2) {
        const uniqueMetrics = [...new Set(resolvedMetrics)];
        const uniquePeriods = [...new Set(resolvedPeriods)];
        // Period collision: same metric name appears but with different periods
        if (uniqueMetrics.length === 1 && uniquePeriods.length > 1) {
          numDivDemotedCount++;
          return {
            ...f,
            numeric_unverified: true,
            severity: "info" as const,
            category: "housekeeping" as const,
            full_analysis: `[PERIOD_MISMATCH] ${f.full_analysis}`,
          };
        }
      }

      // Rule 3: 1 resolved + 1 unresolved → valid narrative-vs-model → PASS THROUGH
      // (Also pass through any other configuration not caught above)
      return f;
    });

    if (numDivDemotedCount > 0) {
      console.log(`[pipeline] Numeric divergence validation: demoted ${numDivDemotedCount} finding(s)`);
    }
  }

  // --- Defect 1: Global Semantic Consolidation (zero-LLM code pass) ---
  // Clusters findings by (1) claim_id overlap and (2) shared issue_key, then
  // collapses each cluster into one representative finding. Runs BEFORE
  // reconciliation append so reconciliation findings remain distinct.
  {
    const preConsolidationCount = finalFindings.length;

    // Build union-find structure for transitive clustering
    const parent: number[] = finalFindings.map((_, i) => i);
    function find(x: number): number {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    }
    function union(a: number, b: number): void {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }

    // Signal 1: claim_id overlap — build inverted index
    const claimToIndices = new Map<string, number[]>();
    for (let i = 0; i < finalFindings.length; i++) {
      const cids = finalFindings[i].claim_ids ?? [];
      for (const cid of cids) {
        const normalized = cid.toLowerCase().trim();
        if (!normalized) continue;
        const existing = claimToIndices.get(normalized);
        if (existing) {
          existing.push(i);
        } else {
          claimToIndices.set(normalized, [i]);
        }
      }
    }
    // Union findings sharing any claim_id
    for (const indices of claimToIndices.values()) {
      for (let k = 1; k < indices.length; k++) {
        union(indices[0], indices[k]);
      }
    }

    // Signal 2: issue_key overlap — union findings sharing a normalized issue_key
    const issueKeyToIndices = new Map<string, number[]>();
    for (let i = 0; i < finalFindings.length; i++) {
      const ik = (finalFindings[i] as any).issue_key;
      if (!ik || typeof ik !== "string") continue;
      const normalized = ik.toLowerCase().trim().replace(/[\s-]+/g, "_");
      if (!normalized) continue;
      const existing = issueKeyToIndices.get(normalized);
      if (existing) {
        existing.push(i);
      } else {
        issueKeyToIndices.set(normalized, [i]);
      }
    }
    for (const indices of issueKeyToIndices.values()) {
      for (let k = 1; k < indices.length; k++) {
        union(indices[0], indices[k]);
      }
    }

    // Group findings by cluster root
    const clusters = new Map<number, number[]>();
    for (let i = 0; i < finalFindings.length; i++) {
      const root = find(i);
      const existing = clusters.get(root);
      if (existing) {
        existing.push(i);
      } else {
        clusters.set(root, [i]);
      }
    }

    // Collapse each cluster into one representative finding
    const severityRank = { critical: 3, warning: 2, info: 1 } as const;
    const consolidated: typeof finalFindings = [];

    for (const members of clusters.values()) {
      if (members.length === 1) {
        consolidated.push(finalFindings[members[0]]);
        continue;
      }

      // Sort members by severity (highest first), then by full_analysis length (longest first)
      members.sort((a, b) => {
        const sa = severityRank[finalFindings[a].severity] ?? 0;
        const sb = severityRank[finalFindings[b].severity] ?? 0;
        if (sb !== sa) return sb - sa;
        return (finalFindings[b].full_analysis?.length ?? 0) - (finalFindings[a].full_analysis?.length ?? 0);
      });

      const representative = finalFindings[members[0]];

      // Union all provenance across cluster members
      const allClaimIds = new Set<string>();
      const allSourceDocs = new Set<string>();
      const allEvidenceDocs = new Set<string>();
      const allEvidence: Array<{ figure: string; source_doc: string; verbatim_snippet: string; verified: boolean }> = [];
      const seenEvidenceKeys = new Set<string>();

      for (const idx of members) {
        const f = finalFindings[idx];
        for (const cid of f.claim_ids ?? []) allClaimIds.add(cid);
        for (const sd of f.source_docs ?? []) allSourceDocs.add(sd);
        for (const ed of f.evidence_docs ?? []) allEvidenceDocs.add(ed);
        for (const ev of f.evidence ?? []) {
          const key = `${ev.figure}|${ev.source_doc}`;
          if (!seenEvidenceKeys.has(key)) {
            seenEvidenceKeys.add(key);
            allEvidence.push(ev);
          }
        }
      }

      const merged: typeof representative = {
        ...representative,
        severity: representative.severity, // already highest from sort
        claim_ids: [...allClaimIds],
        source_docs: [...allSourceDocs],
        evidence_docs: allEvidenceDocs.size > 0 ? [...allEvidenceDocs] : representative.evidence_docs,
        evidence: allEvidence.length > 0 ? allEvidence : representative.evidence,
      };

      consolidated.push(merged);
    }

    finalFindings = consolidated;
    const consolidatedCount = preConsolidationCount - finalFindings.length;
    if (consolidatedCount > 0) {
      console.log(`[pipeline] Global consolidation: ${preConsolidationCount} → ${finalFindings.length} findings (collapsed ${consolidatedCount} duplicates)`);
    }
  }

  // --- Mode-B Fix: Append code-verified reconciliation findings AFTER suppression ---
  // Uses the shared helper so main-path and fast-path can never drift.
  const mainPathReconResult = appendReconciliationFindings(finalFindings, finalHousekeepingFindings, claimsReconciliation);
  finalFindings = mainPathReconResult.finalFindings;
  finalHousekeepingFindings = mainPathReconResult.housekeepingFindings;

  // === CANCEL GATE: pre-absence-verification ===
  if (await checkCancelled(ctx, runId, "pre_absence_verification")) return cancelledResult(runId, "pre_absence_verification");

  // --- Step 5.5: Absence Verification Phase ---
  // For omission_audit / blind_spot_scanner / diligence_completeness, run adversarial
  // verification on any finding with absence_confidence set. Two LLM calls per finding:
  //   Call A: generate alternate search queries
  //   Call B: retrieve evidence and issue REVISED/UPHELD verdict
  // Findings without absence_confidence pass through untouched.
  let verificationPhaseErrored = false;
  if (CHECKLIST_MODULES.has(moduleId)) {
    const verifyBudget = timeRemaining();
    if (verifyBudget >= ABSENCE_VERIFICATION_MIN_BUDGET_MS) {
      console.log(`[pipeline] Running absence verification phase (${Math.round(verifyBudget / 1000)}s budget)`);
      try {
        const verifyResult = await runAbsenceVerificationPhase(
          ctx,
          dealId,
          runId!,
          finalFindings,
          moduleId,
          useOpus,
          input.subjectDocumentIds ?? [],
          timeRemaining,
          startTime
        );
        finalFindings = verifyResult.findings;
        const revised = verifyResult.verificationLog.filter(v => v.verdict.verdict === "REVISED").length;
        const upheld = verifyResult.verificationLog.filter(v => v.verdict.verdict === "UPHELD").length;
        console.log(`[pipeline] Absence verification: ${revised} revised, ${upheld} upheld, completed=${verifyResult.completed}`);

        // If the phase broke early due to budget, return in_progress so next invocation resumes
        if (!verifyResult.completed) {
          return {
            status: "in_progress",
            runId: runId!,
            phase: "absence_verification",
            progress: {
              analysisTotal: routed.length,
              analysisCompleted: routed.length,
              mergeRound: totalMergeRounds,
              mergeTotal: totalMergeRounds,
            },
            result: null,
            failedChunks,
            truncatedChunks,
            truncatedMerges,
            firstError,
          };
        }
      } catch (verifyErr) {
        const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
        console.error(`[pipeline] Absence verification phase failed (non-fatal, findings unchanged): ${msg}`);
        verificationPhaseErrored = true;
      }
    } else {
      console.warn(`[pipeline] Insufficient time for absence verification (${Math.round(verifyBudget / 1000)}s < ${ABSENCE_VERIFICATION_MIN_BUDGET_MS / 1000}s needed) — deferring to next invocation`);
      return {
        status: "in_progress",
        runId: runId!,
        phase: "absence_verification",
        progress: {
          analysisTotal: routed.length,
          analysisCompleted: routed.length,
          mergeRound: totalMergeRounds,
          mergeTotal: totalMergeRounds,
        },
        result: null,
        failedChunks,
        truncatedChunks,
        truncatedMerges,
        firstError,
      };
    }
  }

  // --- Step 5.7: Deterministic `independent` flag override ---
  // The model may emit `independent` based on filename heuristics. This code pass
  // overrides it authoritatively using the actual document_tag for each evidence_doc.
  // Rule: independent = evidence_docs.some(filename => tagOf(filename) !== 'ic_memo')
  //        i.e. false only when ALL evidence_docs have tag ic_memo.
  // Only applies to findings with non-empty evidence_docs (gap_type = "memo_omission").
  // Lookup source: `fileTagMap` loaded from DB at Step 0.3.5 (filename→document_tag).
  let independentOverrides = 0;
  for (const f of finalFindings) {
    if (f.evidence_docs && f.evidence_docs.length > 0) {
      const hasNonIcMemo = f.evidence_docs.some((docName) => {
        const tag = fileTagMap.get(docName.toLowerCase());
        // If tag is unknown (e.g. filename mismatch), treat as independent to avoid
        // incorrectly marking corroboration as non-independent.
        return tag !== "ic_memo";
      });
      const oldValue = f.independent;
      f.independent = hasNonIcMemo;
      if (oldValue !== hasNonIcMemo) independentOverrides++;
    }
  }
  if (independentOverrides > 0) {
    console.log(`[pipeline] Deterministic independent override: corrected ${independentOverrides} finding(s)`);
  }

  // === CANCEL GATE: pre-formatting ===
  if (await checkCancelled(ctx, runId, "pre_formatting")) return cancelledResult(runId, "pre_formatting");

  // --- Step 6: Inline Report Formatting ---
  // Attempt to format the full report server-side so the client doesn't need a separate
  // FormatReport call (which was hitting the 300s platform timeout for large reports).
  // If insufficient time budget remains, return in_progress so the next invocation picks it up.
  let fullReport: string | null = null;
  const formatBudget = timeRemaining();

  if (formatBudget >= FORMAT_REPORT_MIN_BUDGET_MS) {
    console.log(`[pipeline] Formatting report inline (${Math.round(formatBudget / 1000)}s budget)`);
    fullReport = await formatReportInline(ctx, moduleId, finalNode.executiveHeader, finalFindings, formatBudget, startTime, finalHousekeepingFindings, verificationPhaseErrored, mergeGroupsFallenBack);
  } else {
    console.warn(`[pipeline] Insufficient time for inline formatting (${Math.round(formatBudget / 1000)}s < ${FORMAT_REPORT_MIN_BUDGET_MS / 1000}s needed) — deferring to next invocation`);
    // Return in_progress so the client re-invokes with a fresh time budget
    return {
      status: "in_progress",
      runId,
      phase: "formatting",
      progress: {
        analysisTotal: routed.length,
        analysisCompleted: routed.length,
        mergeRound: totalMergeRounds,
        mergeTotal: totalMergeRounds,
      },
      result: null,
      failedChunks,
      truncatedChunks,
      truncatedMerges,
      firstError,
    };
  }

  // RULE: "Completed = Report". A run is only marked completed when a formatted
  // report has been successfully generated AND saved to module_outputs.
  // If formatting failed (fullReport is null), return in_progress so the next
  // invocation retries with a fresh time budget. This prevents the silent-failure
  // scenario where a run shows "completed" with no output.
  if (!fullReport) {
    console.warn(`[pipeline] formatReportInline returned null — NOT marking completed (completed = report). Will retry on next invocation.`);
    return {
      status: "in_progress",
      runId,
      phase: "formatting_retry",
      progress: {
        analysisTotal: routed.length,
        analysisCompleted: routed.length,
        mergeRound: totalMergeRounds,
        mergeTotal: totalMergeRounds,
      },
      result: null,
      failedChunks,
      truncatedChunks,
      truncatedMerges,
      firstError: "Report formatting failed — will retry on next invocation",
    };
  }

  // Persist formatted report to module_outputs.
  // If this save fails, DO NOT mark the run completed — the client would get
  // result:null and GetRunOutput would also find nothing.
  let outputSaved = false;

  // --- Surface permanently_failed extractions BEFORE saving the report ---
  // Query for chunks that exhausted all extraction attempts. If any exist,
  // inject a disclosure section into the report so the user is informed.
  const PermFailedSchema = z.object({
    chunk_index: z.coerce.number(),
    label: z.string(),
    source_file: z.string(),
  });
  let permanentlyFailedExtractions: { chunkLabel: string; sourceFile: string; chunkIndex: number }[] = [];
  try {
    const permFailed = await ctx.integrations.db.query(
      `SELECT
         ue.chunk_index,
         COALESCE(ue.extraction_json->>'label', 'Chunk ' || ue.chunk_index) AS label,
         COALESCE(ue.extraction_json->>'sourceFile', d.file_name, 'unknown') AS source_file
       FROM universal_extractions ue
       LEFT JOIN documents d ON d.id = ue.document_id
       WHERE ue.deal_id = $1
         AND (ue.extraction_json->>'permanently_failed')::boolean = true
       ORDER BY ue.chunk_index`,
      PermFailedSchema,
      [dealId],
      { label: "Query permanently_failed extractions" }
    );
    permanentlyFailedExtractions = permFailed.map(r => ({
      chunkLabel: r.label,
      sourceFile: r.source_file,
      chunkIndex: r.chunk_index,
    }));
    if (permanentlyFailedExtractions.length > 0) {
      console.warn(
        `[pipeline] ⚠️  ${permanentlyFailedExtractions.length} permanently_failed extraction(s) — ` +
        `these sections are MISSING from the report: ` +
        permanentlyFailedExtractions.map(e => `"${e.chunkLabel}" (${e.sourceFile})`).join(", ")
      );
      // Inject disclosure into the report
      const disclosureLines = permanentlyFailedExtractions.map(
        e => `  • ${e.chunkLabel} — source: ${e.sourceFile}`
      );
      const disclosureSection =
        `\n\n---\n\n⚠️ **Extraction Gaps — ${permanentlyFailedExtractions.length} section(s) could not be extracted:**\n\n` +
        disclosureLines.join("\n") +
        `\n\nThese sections were omitted from the analysis after exhausting all retry attempts. ` +
        `Content from these source documents is NOT reflected in the findings above.`;
      fullReport = fullReport + disclosureSection;
    }
  } catch (pfErr) {
    console.warn("[pipeline] Failed to query permanently_failed extractions:", pfErr);
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await upsertModuleOutput(ctx.integrations.db, {
        runId,
        dealId,
        executiveHeader: finalNode.executiveHeader,
        findings: finalFindings,
        fullReport,
      });
      console.log(`[pipeline] Report saved to module_outputs (${fullReport.length} chars, attempt ${attempt})`);
      outputSaved = true;
      break;
    } catch (saveErr) {
      console.warn(`[pipeline] Failed to save report to module_outputs (attempt ${attempt}/2):`, saveErr);
      if (attempt < 2) {
        // Brief pause before retry
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  if (!outputSaved) {
    // Both save attempts failed — return in_progress so the client re-invokes.
    // The merge tree is complete (checkpoints saved), so re-invocation will
    // skip straight to formatting+save with a fresh time budget.
    console.error(`[pipeline] module_outputs save failed after 2 attempts — NOT marking completed`);
    return {
      status: "in_progress",
      runId,
      phase: "save_retry",
      progress: {
        analysisTotal: routed.length,
        analysisCompleted: routed.length,
        mergeRound: totalMergeRounds,
        mergeTotal: totalMergeRounds,
      },
      result: null,
      failedChunks,
      truncatedChunks,
      truncatedMerges,
      firstError: "module_outputs save failed — will retry on next invocation",
    };
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
      fullReport,
    },
    failedChunks,
    truncatedChunks,
    truncatedMerges,
    mergeGroupsFallenBack: mergeGroupsFallenBack > 0 ? mergeGroupsFallenBack : undefined,
    firstError,
    permanentlyFailedExtractions: permanentlyFailedExtractions.length > 0 ? permanentlyFailedExtractions : undefined,
  };
}
