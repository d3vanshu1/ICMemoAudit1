import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { buildMergedText, type MergedFinding } from "../modules/build-merged-text.js";
import { SUB_AGENT_PROMPTS } from "../modules/analyze-chunk.js";
import { MERGE_PROMPTS, FINDINGS_RULE_FINAL } from "../modules/merge-findings.js";

// ---------------------------------------------------------------------------
// This API is a "safety net" background runner.
//
// Design:
//   - Intended to run on a 5-minute schedule (external cron or manual trigger)
//   - Finds module_runs in 'running' status where triggered_at > 6 minutes old
//     (meaning no client tab or previous invocation is actively driving it)
//   - Picks ONE stale run and re-invokes RunModulePipeline's shared logic
//   - Uses the existing runId so it resumes from checkpoints — zero data loss
//
// Why one run per invocation?
//   - Each pipeline pass can consume up to 4m10s of the 5-min platform limit
//   - Processing multiple runs sequentially would exceed the timeout
//   - External scheduler calls this every 5 minutes anyway
//
// Coexistence with client poll loop:
//   - Client refreshes triggered_at per batch (heartbeat)
//   - So actively-driven runs always have triggered_at < 6 min and are skipped
//   - If client disconnects, triggered_at goes stale → this picks it up next cycle
// ---------------------------------------------------------------------------

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

const STALENESS_THRESHOLD_MINUTES = 6;

const StaleRunSchema = z.object({
  id: z.string(),
  deal_id: z.string(),
  module_id: z.string(),
});

export default api({
  name: "ResumeStalePipelines",
  description: "Background safety net: finds stale running pipelines and resumes them",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({}),

  output: z.object({
    found: z.number(),
    resumed: z.string().nullable(),
    outcome: z.string(),
  }),

  async run(ctx) {
    // Find stale runs: status='running' and triggered_at older than threshold
    const staleRuns = await ctx.integrations.db.query(
      `SELECT id, deal_id, module_id
       FROM module_runs
       WHERE status = 'running'::module_status
         AND triggered_at < now() - interval '${STALENESS_THRESHOLD_MINUTES} minutes'
       ORDER BY triggered_at ASC
       LIMIT 5`,
      StaleRunSchema,
      [],
      { label: "Find stale running pipelines" }
    );

    if (staleRuns.length === 0) {
      return { found: 0, resumed: null, outcome: "No stale runs found" };
    }

    // Pick the oldest stale run to resume
    const target = staleRuns[0];

    // Refresh triggered_at immediately to prevent other invocations from picking the same run
    await ctx.integrations.db.execute(
      `UPDATE module_runs SET triggered_at = now() WHERE id = $1`,
      [target.id],
      { label: "Claim stale run (refresh triggered_at)" }
    );

    // Now invoke RunModulePipeline logic via the same API endpoint pattern:
    // We import and call the pipeline's run function directly by executing it as an API.
    // However, since we can't call another API from within an API in Superblocks,
    // we replicate the invocation semantics: the client (or this job) calls RunModulePipeline
    // with the existing runId, and it resumes from checkpoints.
    //
    // Since this API IS the scheduled runner, we use executeApi-style logic.
    // But SDK APIs cannot call other SDK APIs directly at runtime.
    // Instead, this API simply marks the run as "claimable" and returns the run info
    // so an external orchestrator (cron, webhook, or UI button) can call RunModulePipeline.
    //
    // ACTUALLY: The cleanest approach given Superblocks constraints is to inline the
    // pipeline logic here. But that duplicates 600 lines. Instead, we export the core
    // logic from run-module-pipeline.ts? No — the api() wrapper is the export.
    //
    // Best practical approach: This API returns the stale run's details. The external
    // scheduler then calls RunModulePipeline(dealId, moduleId, runId) as a second step.
    // This keeps things DRY and testable.
    //
    // For a SINGLE API that does both "find + resume" in one call, we need to
    // inline the core pipeline. Let's do that — the user wants zero external orchestration
    // beyond "call this one API every 5 minutes."

    // ===== INLINE PIPELINE RESUME (mirrors RunModulePipeline) =====
    // We import the shared constants and call Anthropic directly.
    // This is the same flow as RunModulePipeline with runId set.

    const startTime = Date.now();
    const TIME_BUDGET_MS = 250_000; // 4m10s
    const timeRemaining = () => TIME_BUDGET_MS - (Date.now() - startTime);

    const ANALYSIS_CONCURRENCY = 15;
    const MERGE_CONCURRENCY = 10;
    const MERGE_GROUP_SIZE = 4;
    const SUB_AGENT_MODEL = "claude-sonnet-4-6";
    const SUB_AGENT_MAX_TOKENS = 4096;
    const SONNET_MODEL = "claude-sonnet-4-6";
    const OPUS_MODEL = "claude-opus-4-7";
    const MERGE_MAX_TOKENS = 8000;

    const { id: runId, deal_id: dealId, module_id: moduleId } = target;

    const subAgentPrompt = SUB_AGENT_PROMPTS[moduleId];
    if (!subAgentPrompt) {
      return { found: staleRuns.length, resumed: runId, outcome: `No prompt configured for module "${moduleId}"` };
    }
    const rawMergePrompt = MERGE_PROMPTS[moduleId];
    if (!rawMergePrompt) {
      return { found: staleRuns.length, resumed: runId, outcome: `No merge prompt for module "${moduleId}"` };
    }

    // Mark running
    await ctx.integrations.db.execute(
      `UPDATE module_runs SET status = 'running'::module_status WHERE id = $1`,
      [runId],
      { label: "Resume run → running" }
    );

    // Helper: call Anthropic with retries
    const MessageResponseSchema = z.object({
      id: z.string(),
      type: z.literal("message"),
      role: z.literal("assistant"),
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    });

    async function callAnthropic(
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

    function extractTag(text: string, tag: string): string {
      const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
      const match = text.match(regex);
      return match ? match[1].trim() : "";
    }

    // --- Load extractions & route ---
    const MODULE_TAG_RELEVANCE: Record<string, Set<string>> = {
      contradiction_check: new Set(["financial_statement", "legal_agreement", "operational_report", "market_analysis", "tax_document", "insurance_document", "environmental_report", "valuation_report", "other"]),
      management_assessment: new Set(["operational_report", "legal_agreement", "market_analysis", "other"]),
      market_analysis: new Set(["market_analysis", "operational_report", "other"]),
      legal_risk: new Set(["legal_agreement", "insurance_document", "environmental_report", "other"]),
      financial_analysis: new Set(["financial_statement", "tax_document", "valuation_report", "other"]),
    };

    const ExtractionRowSchema = z.object({
      document_id: z.string(),
      chunk_index: z.coerce.number(),
      extraction_json: z.any(),
    });

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
      const ext = typeof row.extraction_json === "string" ? JSON.parse(row.extraction_json) : row.extraction_json;
      const tag = String(ext.documentTag ?? "other");
      return relevantTags.has(tag);
    });

    if (routed.length === 0) {
      await ctx.integrations.db.execute(
        `UPDATE module_runs SET status = 'failed'::module_status, completed_at = now() WHERE id = $1`,
        [runId],
        { label: "Mark run failed — no chunks" }
      );
      return { found: staleRuns.length, resumed: runId, outcome: "failed: no routed chunks" };
    }

    // --- Analysis phase (with checkpointing) ---
    const AnalysisCheckpointSchema = z.object({ chunk_index: z.coerce.number() });
    const existingCheckpoints = await ctx.integrations.db.query(
      `SELECT chunk_index FROM pipeline_analysis WHERE run_id = $1`,
      AnalysisCheckpointSchema,
      [runId],
      { label: "Load analysis checkpoints" }
    );
    const completedSet = new Set(existingCheckpoints.map(r => r.chunk_index));
    let analysisCompleted = completedSet.size;
    const pendingChunks = routed.filter(r => !completedSet.has(r.chunk_index));

    let failedChunks = 0;
    let firstError: string | null = null;

    for (let bStart = 0; bStart < pendingChunks.length; ) {
      const remaining = timeRemaining();
      if (remaining < 60_000) {
        return { found: staleRuns.length, resumed: runId, outcome: `in_progress: analysis ${analysisCompleted}/${routed.length}` };
      }
      const batchSize = remaining < 90_000 ? 5 : ANALYSIS_CONCURRENCY;
      const batch = pendingChunks.slice(bStart, bStart + batchSize);
      bStart += batchSize;

      const results = await Promise.allSettled(
        batch.map(async (chunk) => {
          const ext = typeof chunk.extraction_json === "string" ? JSON.parse(chunk.extraction_json) : chunk.extraction_json;
          const content = JSON.stringify(ext, null, 2);

          const resp = await callAnthropic(
            {
              model: SUB_AGENT_MODEL,
              max_tokens: SUB_AGENT_MAX_TOKENS,
              system: [{ type: "text", text: subAgentPrompt, cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content }],
            },
            `Analyze chunk ${chunk.chunk_index}`
          );

          const text = resp.content.find(c => c.type === "text")?.text ?? "";
          const label = extractTag(text, "label") || "unlabeled";
          const extraction = extractTag(text, "extraction") || text;

          return { chunkIndex: chunk.chunk_index, result: { label, extraction } };
        })
      );

      for (const r of results) {
        if (r.status === "fulfilled") {
          analysisCompleted++;
          await ctx.integrations.db.execute(
            `INSERT INTO pipeline_analysis (run_id, chunk_index, result_json)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (run_id, chunk_index) DO UPDATE SET result_json = $3::jsonb`,
            [runId, r.value.chunkIndex, JSON.stringify(r.value.result)],
            { label: `Save analysis chunk ${r.value.chunkIndex}` }
          );
        } else {
          failedChunks++;
          if (!firstError) firstError = r.reason instanceof Error ? r.reason.message : String(r.reason);
        }
      }

      // Heartbeat
      await ctx.integrations.db.execute(
        `UPDATE module_runs SET triggered_at = now() WHERE id = $1`,
        [runId],
        { label: "Heartbeat (analysis batch)" }
      );

      if (timeRemaining() < 60_000) {
        return { found: staleRuns.length, resumed: runId, outcome: `in_progress: analysis ${analysisCompleted}/${routed.length}` };
      }
    }

    // --- Load all analysis for merge ---
    const allAnalysis = await ctx.integrations.db.query(
      `SELECT chunk_index, result_json FROM pipeline_analysis WHERE run_id = $1 ORDER BY chunk_index LIMIT 1000`,
      z.object({ chunk_index: z.coerce.number(), result_json: z.any() }),
      [runId],
      { label: "Load all analysis for merge" }
    );

    interface AnalysisNode { label: string; extraction: string; chunkIndex: number; }
    const analysisResults: AnalysisNode[] = allAnalysis.map(row => {
      const r = typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json;
      return { label: String(r.label), extraction: String(r.extraction), chunkIndex: row.chunk_index };
    });

    if (analysisResults.length === 0) {
      await ctx.integrations.db.execute(
        `UPDATE module_runs SET status = 'failed'::module_status, completed_at = now() WHERE id = $1`,
        [runId],
        { label: "Mark run failed — no analysis" }
      );
      return { found: staleRuns.length, resumed: runId, outcome: "failed: no analysis results" };
    }

    // --- Merge phase ---
    interface MergeNode { text: string; executiveHeader: string; findings: MergedFinding[]; }

    const MergeCheckpointSchema = z.object({
      tree_level: z.coerce.number(),
      node_index: z.coerce.number(),
      merged_json: z.any(),
    });

    const mergeCheckpoints = await ctx.integrations.db.query(
      `SELECT tree_level, node_index, merged_json FROM merge_checkpoints WHERE module_run_id = $1 ORDER BY tree_level, node_index`,
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

    let nodes: MergeNode[] = analysisResults.map(a => ({
      text: a.extraction, executiveHeader: "", findings: [],
    }));
    if (nodes.length === 1) nodes.push({ ...nodes[0] });

    // Prepare merge prompt
    let mergePrompt = rawMergePrompt.replace("{{FINDINGS_REQUIREMENT}}", FINDINGS_RULE_FINAL);
    mergePrompt = mergePrompt.replace("{{NUMERIC_VERIFICATION_BLOCK}}", "");
    mergePrompt = mergePrompt.replace("{{NUMERIC_TASK_STEP_1}}", "");

    const useOpus = false; // Background runner uses Sonnet for cost efficiency

    let currentRound = 0;
    while (nodes.length > 1) {
      currentRound++;
      if (timeRemaining() < 60_000) {
        return { found: staleRuns.length, resumed: runId, outcome: `in_progress: merge round ${currentRound - 1}` };
      }

      const groups: Array<{ idx: number; members: MergeNode[] }> = [];
      for (let g = 0; g < Math.ceil(nodes.length / MERGE_GROUP_SIZE); g++) {
        groups.push({ idx: g, members: nodes.slice(g * MERGE_GROUP_SIZE, (g + 1) * MERGE_GROUP_SIZE) });
      }

      const nextNodes: MergeNode[] = new Array(groups.length);
      const pendingGroups: Array<{ idx: number; members: MergeNode[] }> = [];

      for (const group of groups) {
        if (group.members.length === 1) { nextNodes[group.idx] = group.members[0]; continue; }
        const cpKey = `${currentRound}:${group.idx}`;
        if (checkpointMap.has(cpKey)) { nextNodes[group.idx] = checkpointMap.get(cpKey)!; continue; }
        pendingGroups.push(group);
      }

      for (let bStart = 0; bStart < pendingGroups.length; ) {
        if (timeRemaining() < 60_000) {
          return { found: staleRuns.length, resumed: runId, outcome: `in_progress: merge round ${currentRound}` };
        }
        const batchSize = timeRemaining() < 90_000 ? Math.min(3, MERGE_CONCURRENCY) : MERGE_CONCURRENCY;
        const batch = pendingGroups.slice(bStart, bStart + batchSize);
        bStart += batchSize;

        const results = await Promise.allSettled(
          batch.map(async (group) => {
            const setBlocks = group.members.map((m, i) => `## Analysis Set ${i + 1}\n\n${m.text}`);
            const mergeInput = setBlocks.join("\n\n---\n\n");

            const mergeResult = await callAnthropic(
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
              } catch { /* ignore */ }
            }

            const mergedTextForNode = buildMergedText(executiveHeader, findings);
            return { group, node: { text: mergedTextForNode, executiveHeader, findings } as MergeNode };
          })
        );

        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const group = batch[i];
          if (result.status === "fulfilled") {
            nextNodes[group.idx] = result.value.node;
            await ctx.integrations.db.execute(
              `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json)
               VALUES ($1, $2, $3, $4::jsonb)
               ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE SET merged_json = $4::jsonb`,
              [runId, currentRound, group.idx, JSON.stringify(result.value.node)],
              { label: `Save merge checkpoint R${currentRound}:G${group.idx}` }
            );
          } else {
            failedChunks++;
            if (!firstError) firstError = result.reason instanceof Error ? result.reason.message : String(result.reason);
            nextNodes[group.idx] = { text: group.members[0].text, executiveHeader: "Merge failed", findings: [] };
            await ctx.integrations.db.execute(
              `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json)
               VALUES ($1, $2, $3, $4::jsonb)
               ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE SET merged_json = $4::jsonb`,
              [runId, currentRound, group.idx, JSON.stringify({ error: firstError })],
              { label: `Save merge error R${currentRound}:G${group.idx}` }
            );
          }
        }

        await ctx.integrations.db.execute(
          `UPDATE module_runs SET triggered_at = now() WHERE id = $1`,
          [runId],
          { label: "Heartbeat (merge batch)" }
        );
      }

      nodes = nextNodes;
    }

    // --- Complete ---
    const finalNode = nodes[0];
    await ctx.integrations.db.execute(
      `UPDATE module_runs SET status = 'completed'::module_status, completed_at = now() WHERE id = $1`,
      [runId],
      { label: "Mark run completed" }
    );

    // Save final result to module_results (same as RunModulePipeline would)
    await ctx.integrations.db.execute(
      `INSERT INTO module_results (deal_id, module_id, run_id, result_json)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (deal_id, module_id) DO UPDATE SET run_id = $3, result_json = $4::jsonb, created_at = now()`,
      [dealId, moduleId, runId, JSON.stringify({
        executiveHeader: finalNode.executiveHeader,
        findings: finalNode.findings,
        mergedText: finalNode.text,
      })],
      { label: "Save final module result" }
    );

    return {
      found: staleRuns.length,
      resumed: runId,
      outcome: `completed: ${moduleId} for deal ${dealId} (${failedChunks} failed chunks)`,
    };
  },
});
