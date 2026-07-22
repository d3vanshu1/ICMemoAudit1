import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { runPipelineCore } from "./pipeline-core.js";
import { upsertModuleOutput } from "../modules/upsert-module-output.js";
import { STALENESS_THRESHOLD_MINUTES, RESUME_JOB_TIME_BUDGET_MS } from "./pipeline-config.js";

// ---------------------------------------------------------------------------
// Background Pipeline Runner (Safety Net)
//
// Design:
//   - Intended to run on a 5-minute schedule (external cron or manual trigger)
//   - Finds module_runs in 'running' status where triggered_at > 6 minutes old
//     (meaning no client tab or previous invocation is actively driving it)
//   - Processes ALL stale runs within its own time budget (not just one),
//     claiming each atomically before processing
//   - Uses the existing runId so it resumes from checkpoints — zero data loss
//
// Why a time-bounded batch instead of one-per-tick?
//   - A "Run All" + walk away scenario creates multiple stale runs at once
//   - If we only process one per 5-min tick, later runs can sit long enough to
//     cross the PurgeStaleRuns 30-min threshold and be marked failed before
//     this job ever touches them — permanently losing checkpointed progress
//   - With batching, we drain the backlog within a few invocations
//
// Coexistence with client poll loop:
//   - Client refreshes triggered_at per batch (heartbeat)
//   - So actively-driven runs always have triggered_at < 6 min and are skipped
//   - If client disconnects, triggered_at goes stale → this picks it up next cycle
//
// On completion:
//   - Saves to module_outputs (same INSERT the client would do via SaveModuleResult)
//   - Since no client is present, the background runner is responsible for persisting
//     the final report so the UI can display it later
// ---------------------------------------------------------------------------

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

const NUMERIC_MODULES_SET = new Set(["contradiction_check", "model_assumptions_stress"]);

const StaleRunSchema = z.object({
  id: z.string(),
  deal_id: z.string(),
  module_id: z.string(),
});

export default api({
  name: "ResumeStalePipelines",
  description: "Background safety net: finds stale running pipelines and resumes them (batched)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({}),

  output: z.object({
    found: z.number(),
    processed: z.array(z.object({
      runId: z.string(),
      moduleId: z.string(),
      outcome: z.string(),
    })),
  }),

  async run(ctx) {
    const jobStart = Date.now();
    const timeRemaining = () => RESUME_JOB_TIME_BUDGET_MS - (Date.now() - jobStart);

    // Find all stale runs: status='running' and triggered_at older than threshold
    const staleRuns = await ctx.integrations.db.query(
      `SELECT id, deal_id, module_id
       FROM module_runs
       WHERE status = 'running'::module_status
         AND triggered_at < now() - interval '${STALENESS_THRESHOLD_MINUTES} minutes'
       ORDER BY triggered_at ASC
       LIMIT 10`,
      StaleRunSchema,
      [],
      { label: "Find stale running pipelines" }
    );

    if (staleRuns.length === 0) {
      return { found: 0, processed: [] };
    }

    const processed: Array<{ runId: string; moduleId: string; outcome: string }> = [];

    for (const target of staleRuns) {
      // Check time budget — need at least 60s to make meaningful progress
      if (timeRemaining() < 60_000) {
        break;
      }

      // For numeric-dependent modules, check availability BEFORE claiming
      // so we don't refresh triggered_at on a run we can't process.
      if (NUMERIC_MODULES_SET.has(target.module_id)) {
        let numericAvailable = false;
        try {
          const hasNumeric = await ctx.integrations.db.query(
            `SELECT numeric_report_json IS NOT NULL AS has_report FROM module_runs WHERE id = $1`,
            z.object({ has_report: z.boolean() }),
            [target.id],
            { label: "Pre-claim: check if run has persisted numeric report" }
          );
          numericAvailable = hasNumeric.length > 0 && hasNumeric[0].has_report;
        } catch {
          // Column doesn't exist yet — treat as unavailable
        }

        if (!numericAvailable) {
          processed.push({
            runId: target.id,
            moduleId: target.module_id,
            outcome: "skipped: numeric-dependent module without persisted numeric report (not claimed)",
          });
          continue;
        }
      }

      // Atomically claim this run (CAS on triggered_at to prevent double-pickup)
      const claimed = await ctx.integrations.db.query(
        `UPDATE module_runs
         SET triggered_at = now()
         WHERE id = $1 AND status = 'running'::module_status
           AND triggered_at < now() - interval '${STALENESS_THRESHOLD_MINUTES} minutes'
         RETURNING id`,
        z.object({ id: z.string() }),
        [target.id],
        { label: `Claim stale run ${target.id}` }
      );

      if (claimed.length === 0) {
        // Another process already claimed it — skip
        continue;
      }

      // Load persisted numeric report if available (already confirmed exists for numeric modules)
      let numericReport: any = null;
      try {
        const numericRow = await ctx.integrations.db.query(
          `SELECT numeric_report_json FROM module_runs WHERE id = $1 AND numeric_report_json IS NOT NULL`,
          z.object({ numeric_report_json: z.any() }),
          [target.id],
          { label: "Load persisted numeric report" }
        );
        if (numericRow.length > 0) {
          numericReport = typeof numericRow[0].numeric_report_json === "string"
            ? JSON.parse(numericRow[0].numeric_report_json)
            : numericRow[0].numeric_report_json;
        }
      } catch {
        // Column may not exist yet — proceed without numeric grounding
      }

      try {
        const result = await runPipelineCore(ctx, {
          dealId: target.deal_id,
          moduleId: target.module_id,
          runId: target.id,
          useOpus: false,
          numericReport,
        });

        // If the pipeline completed, persist the output to module_outputs
        if (result.status === "completed" && result.result) {
          const findingsMarkdown = result.result.findings.map((f: any) => {
            const sev = f.severity ? `[${String(f.severity).toUpperCase()}]` : "";
            return `### ${sev} ${f.title}\n\n${f.detail || f.full_analysis || ""}`;
          }).join("\n\n---\n\n");

          const fullReport = `# ${target.module_id.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}\n\n## Executive Summary\n\n${result.result.executiveHeader}\n\n## Findings\n\n${findingsMarkdown}\n\n---\n*Generated by background pipeline runner.*`;

          await upsertModuleOutput(ctx.integrations.db, {
            runId: result.runId,
            dealId: target.deal_id,
            executiveHeader: result.result.executiveHeader,
            findings: result.result.findings,
            fullReport,
          });
        }

        processed.push({
          runId: target.id,
          moduleId: target.module_id,
          outcome: result.status === "completed"
            ? `completed (${result.failedChunks ?? 0} failed chunks)`
            : result.status === "in_progress"
              ? `in_progress: ${result.phase}`
              : `failed: ${result.firstError ?? result.phase}`,
        });
      } catch (err) {
        const msg = err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
        processed.push({
          runId: target.id,
          moduleId: target.module_id,
          outcome: `error: ${msg.slice(0, 200)}`,
        });
      }
    }

    return {
      found: staleRuns.length,
      processed,
    };
  },
});
