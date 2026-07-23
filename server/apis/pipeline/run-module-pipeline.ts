import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { runPipelineCore, type PipelineResult } from "./pipeline-core.js";

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// API — Thin wrapper around the shared pipeline core.
//
// This is the API the client poll loop calls. It:
//   1. Creates or resumes a run (via runId)
//   2. Processes as many chunks/merges as fit in the time budget
//   3. Returns in_progress (so the client can re-invoke) or completed
//
// The actual logic lives in pipeline-core.ts so that the background
// safety-net API (ResumeStalePipelines) calls the identical code path.
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
    /** IDs of the memo(s) under review. Required for modules that need subject exclusion. */
    subjectDocumentIds: z.array(z.string()).nullable().optional(),
    // Numeric report (pre-computed by client before kicking off pipeline)
    numericReport: z.object({
      figures: z.array(z.any()),
      discrepancies: z.array(z.any()),
    }).nullable().optional(),
    // True when NumericVerify hit its time budget and only processed a subset of tables
    numericPartial: z.boolean().nullable().optional(),
  }),

  output: z.object({
    status: z.enum(["completed", "in_progress", "failed", "cancelled"]),
    runId: z.string(),
    phase: z.string(),
    progress: z.object({
      analysisTotal: z.number(),
      analysisCompleted: z.number(),
      mergeRound: z.number(),
      mergeTotal: z.number(),
      mergeGroupsDone: z.number().optional(),
      mergeGroupsTotal: z.number().optional(),
    }),
    // Only populated when status === "completed"
    result: z.object({
      executiveHeader: z.string(),
      findings: z.array(z.any()),
      mergedText: z.string(),
      fullReport: z.string().nullable().optional(),
    }).nullable(),
    // Failure & quality diagnostics
    failedChunks: z.number().optional(),
    truncatedChunks: z.number().optional(),
    truncatedMerges: z.number().optional(),
    firstError: z.string().nullable().optional(),
    // Per-invocation extraction observability
    extractionPassStats: z.object({
      attemptedThisPass: z.number(),
      succeededThisPass: z.number(),
      failedThisPass: z.number(),
      skippedDueToBudget: z.number(),
    }).optional(),
  }),

  async run(ctx, input): Promise<PipelineResult> {
    return runPipelineCore(ctx, {
      dealId: input.dealId,
      moduleId: input.moduleId,
      runId: input.runId,
      useOpus: input.useOpus,
      subjectDocumentIds: input.subjectDocumentIds,
      numericReport: input.numericReport,
      numericPartial: input.numericPartial,
    });
  },
});
