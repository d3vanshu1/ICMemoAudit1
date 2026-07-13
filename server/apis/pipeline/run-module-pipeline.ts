import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { buildMergedText, type MergedFinding } from "../modules/build-merged-text.js";
import { NUMERIC_MODULES } from "../modules/constants.js";
import { SUB_AGENT_PROMPTS } from "../modules/analyze-chunk.js";
import { MERGE_PROMPTS, FINDINGS_RULE_FINAL, FINDINGS_RULE_INTERMEDIATE } from "../modules/merge-findings.js";

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// Models & Config
// ---------------------------------------------------------------------------
const SUB_AGENT_MODEL = "claude-sonnet-4-6";
const SUB_AGENT_MAX_TOKENS = 4096;
const SONNET_MODEL = "claude-sonnet-4-6";
const OPUS_MODEL = "claude-opus-4-7";
const MERGE_MAX_TOKENS = 8000;
const REPORT_MAX_TOKENS = 16000;

const ANALYSIS_CONCURRENCY = 15;
const MERGE_GROUP_SIZE = 4;
const TIME_BUDGET_MS = 250_000; // 4m10s — must stay under platform's 5min app API limit

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
const CountSchema = z.object({ cnt: z.coerce.number() });

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
// Sub-Agent Prompts (compact — only the module-specific system prompt)
// Imported logic from analyze-chunk.ts
// ---------------------------------------------------------------------------
// NOTE: Full prompts are large. We import them dynamically to keep this file manageable.
// For now, we store a simplified version inline and delegate to the existing AnalyzeChunk API pattern.

// Rather than duplicating all prompts (2000+ lines), we'll store analysis results
// in a pipeline_analysis_results table and call the existing sub-APIs via a
// "function-call" pattern using the Anthropic integration directly.

// Actually — the cleanest approach: the sub-agent prompts and merge prompts are
// already defined in the existing API files. Since we can't call APIs from APIs
// in Superblocks, we need to inline the core logic here. But to keep this file
// manageable, we'll import the prompts from a shared location.

// For this initial implementation, we'll use a two-table checkpoint approach:
//   1. pipeline_analysis (deal_id, module_id, run_id, chunk_index, result_json) 
//   2. merge_checkpoints (already exists)
// The pipeline reads/writes these to track progress.

// ---------------------------------------------------------------------------
// Helper: Anthropic call with retries
// ---------------------------------------------------------------------------
async function callAnthropic(
  ctx: { integrations: { ai: { apiRequest: Function } } },
  body: Record<string, unknown>,
  label: string,
  retries = 3
): Promise<z.infer<typeof MessageResponseSchema>> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await ctx.integrations.ai.apiRequest(
        { method: "POST", path: "/v1/messages", body },
        { response: MessageResponseSchema },
        { label }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = /503|429|rate.?limit|service.?unavailable|overloaded/i.test(msg);
      if (!isRetryable || attempt === retries) throw err;
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 15000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("Unreachable");
}

// ---------------------------------------------------------------------------
// Helper: Extract XML tag content
// ---------------------------------------------------------------------------
function extractTag(text: string, tag: string): string {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
export default api({
  name: "RunModulePipeline",
  description: "Server-side module pipeline: analysis → merge → report, with checkpointing",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string(),
    moduleId: z.string(),
    runId: z.string().nullable().optional(),
    useOpus: z.boolean().nullable().optional(),
    // Numeric report (pre-computed by client before kicking off pipeline)
    numericReport: z.object({
      figures: z.array(z.any()),
      discrepancies: z.array(z.any()),
    }).nullable().optional(),
  }),

  output: z.object({
    status: z.enum(["completed", "in_progress", "failed"]),
    runId: z.string(),
    phase: z.string(),
    progress: z.object({
      analysisTotal: z.number(),
      analysisCompleted: z.number(),
      mergeRound: z.number(),
      mergeTotal: z.number(),
    }),
    // Only populated when status === "completed"
    result: z.object({
      executiveHeader: z.string(),
      findings: z.array(z.any()),
      mergedText: z.string(),
    }).nullable(),
    // Failure diagnostics
    failedChunks: z.number().optional(),
    firstError: z.string().nullable().optional(),
  }),

  async run(ctx, input) {
    const startTime = Date.now();
    const timeRemaining = () => TIME_BUDGET_MS - (Date.now() - startTime);

    const { dealId, moduleId, useOpus, numericReport } = input;

    // Look up prompts for this module
    const subAgentPrompt = SUB_AGENT_PROMPTS[moduleId];
    if (!subAgentPrompt) {
      throw new Error(`Module "${moduleId}" sub-agent prompt not configured.`);
    }

    // Prepare merge prompt with numeric/findings substitutions
    const rawMergePrompt = MERGE_PROMPTS[moduleId];
    if (!rawMergePrompt) {
      throw new Error(`Module "${moduleId}" merge prompt not configured.`);
    }

    // --- Step 0: Create or resume run ---
    let runId = input.runId;
    if (!runId) {
      const rows = await ctx.integrations.db.query(
        `INSERT INTO module_runs (deal_id, module_id, status)
         VALUES ($1, $2, 'running'::module_status)
         RETURNING id AS run_id`,
        RunIdSchema,
        [dealId, moduleId],
        { label: "Create pipeline run" }
      );
      runId = rows[0].run_id;
    } else {
      // Mark as running (in case it was failed from timeout)
      await ctx.integrations.db.execute(
        `UPDATE module_runs SET status = 'running'::module_status WHERE id = $1`,
        [runId],
        { label: "Resume run → running" }
      );
    }

    // --- Step 1: Load universal extractions + route ---
    const allExtractions = await ctx.integrations.db.query(
      `SELECT document_id, chunk_index, extraction_json
       FROM universal_extractions
       WHERE deal_id = $1
       ORDER BY document_id, chunk_index
       LIMIT 1000`,
      ExtractionRowSchema,
      [dealId],
      { label: "Load extractions" }
    );

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
        `UPDATE module_runs SET status = 'failed'::module_status, completed_at = now() WHERE id = $1`,
        [runId],
        { label: "Mark run failed — no chunks" }
      );
      return {
        status: "failed" as const,
        runId,
        phase: "routing",
        progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
        result: null,
      };
    }

    // --- Step 2: Sub-agent analysis (with checkpointing) ---
    // Check which chunks are already analyzed for this run
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
    let firstError: string | null = null;

    // Helper: return in_progress checkpoint
    const returnInProgress = (phase: "analysis" | "merge", mergeRound = 0) => ({
      status: "in_progress" as const,
      runId,
      phase,
      progress: {
        analysisTotal: routed.length,
        analysisCompleted,
        mergeRound,
        mergeTotal: Math.ceil(Math.log(Math.max(routed.length, 2)) / Math.log(MERGE_GROUP_SIZE)),
      },
      result: null,
      failedChunks,
      firstError,
    });

    // Process pending chunks with dynamic batch sizing
    for (let bStart = 0; bStart < pendingChunks.length; ) {
      // Dynamic batch size: shrink as time runs low
      const remaining = timeRemaining();
      let batchSize: number;
      if (remaining < 60_000) {
        // Less than 60s — checkpoint immediately, don't start another batch
        return returnInProgress("analysis");
      } else if (remaining < 90_000) {
        // Less than 90s — small batch to avoid overrun
        batchSize = 5;
      } else {
        batchSize = ANALYSIS_CONCURRENCY;
      }

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

          const textBlock = result.content.find(c => c.type === "text");
          const extraction = `### Extraction from: ${chunkLabel}\n\n${textBlock?.text ?? ""}`;

          // Save checkpoint
          await ctx.integrations.db.execute(
            `INSERT INTO pipeline_analysis (run_id, chunk_index, result_json)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (run_id, chunk_index) DO NOTHING`,
            [runId, globalIdx, JSON.stringify({ label: chunkLabel, extraction, chunkIndex: globalIdx })],
            { label: `Save analysis checkpoint ${globalIdx}` }
          );

          return { label: chunkLabel, extraction, chunkIndex: globalIdx };
        })
      );

      // Count successes and track failures
      for (const r of results) {
        if (r.status === "fulfilled") {
          analysisCompleted++;
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

      // Post-batch time check: if we're close to platform kill, checkpoint immediately
      if (timeRemaining() < 60_000) {
        return returnInProgress("analysis");
      }
    }

    // --- Step 3: Load all analysis results for merge ---
    const allAnalysis = await ctx.integrations.db.query(
      `SELECT chunk_index, result_json FROM pipeline_analysis
       WHERE run_id = $1
       ORDER BY chunk_index
       LIMIT 1000`,
      z.object({ chunk_index: z.coerce.number(), result_json: z.any() }),
      [runId],
      { label: "Load all analysis for merge" }
    );

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
        `UPDATE module_runs SET status = 'failed'::module_status, completed_at = now() WHERE id = $1`,
        [runId],
        { label: "Mark run failed — no analysis results" }
      );
      return {
        status: "failed" as const,
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
    }

    // Load existing merge checkpoints
    const mergeCheckpoints = await ctx.integrations.db.query(
      `SELECT tree_level, node_index, merged_json
       FROM merge_checkpoints
       WHERE module_run_id = $1
       ORDER BY tree_level, node_index`,
      MergeCheckpointSchema,
      [runId],
      { label: "Load merge checkpoints" }
    );

    const checkpointMap = new Map<string, MergeNode>();
    for (const cp of mergeCheckpoints) {
      const data = typeof cp.merged_json === "string" ? JSON.parse(cp.merged_json) : cp.merged_json;
      if (data.error) continue;
      checkpointMap.set(`${cp.tree_level}:${cp.node_index}`, {
        text: String(data.text ?? ""),
        executiveHeader: String(data.executiveHeader ?? ""),
        findings: (data.findings ?? []) as MergedFinding[],
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
        for (const f of numericReport.figures.slice(0, 30)) {
          const fig = f as Record<string, unknown>;
          numericBlock += `- **${String(fig.name)}**: ${fig.recomputed_value} @ ${String(fig.source_cell)}\n`;
        }
      }
    }

    // Prepare merge prompt (substitute numeric and findings blocks)
    // This mirrors the logic in merge-findings.ts
    let mergePrompt = rawMergePrompt.replace("{{FINDINGS_REQUIREMENT}}", FINDINGS_RULE_FINAL);
    if (hasNumericData) {
      const numericVerifInst = `## NUMERIC VERIFICATION — AUTHORITATIVE GROUND TRUTH

A "## Numeric Verification Report" section appears in the input below. It contains deterministic arithmetic results produced by code — NOT by AI inference. You MUST:
- Treat every figure and discrepancy in that section as factual ground truth
- Any narrative claim that contradicts a code-verified figure is a CONFIRMED contradiction
- Cross-doc agreement discrepancies are pre-verified contradictions — report them directly as findings
- Never re-derive or contradict a code-verified figure based on text reading`;
      mergePrompt = mergePrompt.replace("{{NUMERIC_VERIFICATION_BLOCK}}", numericVerifInst);
      mergePrompt = mergePrompt.replace("{{NUMERIC_TASK_STEP_1}}",
        "**Numeric Contradictions First**: Convert every discrepancy from the Numeric Verification Report into a finding.\n");
    } else {
      mergePrompt = mergePrompt.replace("{{NUMERIC_VERIFICATION_BLOCK}}", "");
      mergePrompt = mergePrompt.replace("{{NUMERIC_TASK_STEP_1}}", "");
    }

    while (nodes.length > 1) {
      currentRound++;

      if (timeRemaining() < 60_000) {
        // Not enough time for another merge round
        return returnInProgress("merge", currentRound - 1);
      }

      const groups: Array<{ idx: number; members: MergeNode[] }> = [];
      for (let g = 0; g < Math.ceil(nodes.length / MERGE_GROUP_SIZE); g++) {
        groups.push({ idx: g, members: nodes.slice(g * MERGE_GROUP_SIZE, (g + 1) * MERGE_GROUP_SIZE) });
      }

      const nextNodes: MergeNode[] = new Array(groups.length);
      const isFinalRound = currentRound === totalMergeRounds;

      for (const group of groups) {
        // Mid-round time check: bail before starting a long merge call
        if (timeRemaining() < 60_000) {
          return returnInProgress("merge", currentRound - 1);
        }

        if (group.members.length === 1) {
          nextNodes[group.idx] = group.members[0];
          continue;
        }

        // Check checkpoint
        const cpKey = `${currentRound}:${group.idx}`;
        if (checkpointMap.has(cpKey)) {
          nextNodes[group.idx] = checkpointMap.get(cpKey)!;
          continue;
        }

        // Perform merge
        const setBlocks = group.members.map((m, i) => `## Analysis Set ${i + 1}\n\n${m.text}`);
        const mergeInput = setBlocks.join("\n\n---\n\n") + numericBlock;

        const mergeResult = await callAnthropic(
          ctx,
          {
            model: useOpus ? OPUS_MODEL : SONNET_MODEL,
            max_tokens: MERGE_MAX_TOKENS,
            system: [{ type: "text", text: mergePrompt, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: mergeInput }],
          },
          `Merge R${currentRound} G${group.idx + 1}/${groups.length}`
        );

        const mergeText = mergeResult.content.find(c => c.type === "text")?.text ?? "";
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

        const mergedTextForNode = buildMergedText(executiveHeader, findings);
        const node: MergeNode = { text: mergedTextForNode, executiveHeader, findings };
        nextNodes[group.idx] = node;

        // Save merge checkpoint
        await ctx.integrations.db.execute(
          `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE SET merged_json = $4::jsonb`,
          [runId, currentRound, group.idx, JSON.stringify({ text: mergedTextForNode, executiveHeader, findings })],
          { label: `Save merge checkpoint R${currentRound}:G${group.idx}` }
        );
      }

      nodes = nextNodes;
    }

    // --- Step 5: Complete ---
    const finalNode = nodes[0];

    // Mark run completed
    await ctx.integrations.db.execute(
      `UPDATE module_runs SET status = 'completed'::module_status, completed_at = now() WHERE id = $1`,
      [runId],
      { label: "Mark run completed" }
    );

    return {
      status: "completed" as const,
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
        findings: finalNode.findings,
        mergedText: finalNode.text,
      },
      failedChunks,
      firstError,
    };
  },
});
