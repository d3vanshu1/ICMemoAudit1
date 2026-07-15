/**
 * Web Research Phase — server-side iteration loop for external_risk_overlay
 * and social_reputation modules.
 *
 * Replaces the fragile client-side `runWebResearchModule` callback that ran
 * 7-9 sequential API calls with zero persistence. A closed tab meant complete
 * loss of all completed iterations.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * INVARIANTS — these are the "four things built in from the start":
 *
 * 1. ON CONFLICT (run_id, iteration) DO UPDATE: Checkpoint writes use UPSERT,
 *    not bare INSERT. A 'failed' → retry overwrites cleanly.
 *
 * 2. Budget check INSIDE the retry loop: Before each retry attempt inside
 *    runWebSearchIteration, not just before the first call. Same lesson as
 *    callExtractionLLM.
 *
 * 3. Promise.race each iteration against the remaining deadline: A slow,
 *    non-erroring call can't silently exceed the overall budget. Same fix
 *    as the extraction batch-race.
 *
 * 4. Phase display update is in the same diff as the phase itself (handled in
 *    the client-side changes in this commit).
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { z } from "@superblocksteam/sdk-api";
import {
  runWebSearchIteration,
  parseIterationResult,
  buildExternalRiskIterationPrompt,
  buildSocialReputationIterationPrompt,
  EXTERNAL_RISK_SYSTEM_PROMPT,
  SOCIAL_REPUTATION_SYSTEM_PROMPT,
  SOCIAL_REPUTATION_CATEGORIES,
} from "../modules/web-research.js";
import type { PipelineContext } from "./pipeline-core.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const EXTERNAL_RISK_MAX_ITERATIONS = 7;
const SOCIAL_REPUTATION_MAX_ITERATIONS = 9;
const CONFIDENCE_THRESHOLD = 8; // Stop when confidence >= this
const CONSECUTIVE_THRESHOLD = 2; // Must hit threshold this many times in a row

/** Per-iteration deadline — if a single iteration hasn't returned in this time, abort it */
const ITERATION_DEADLINE_MS = 90_000; // 90s starting point (adjustable)

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const IterationRowSchema = z.object({
  iteration: z.coerce.number(),
  query: z.string().nullable(),
  finding: z.string().nullable(),
  confidence: z.coerce.number().nullable(),
  platform: z.string().nullable(),
  category: z.string().nullable(),
  sources: z.any().nullable(),
  materiality: z.string().nullable(),
  status: z.string(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface WebResearchPhaseResult {
  needed: boolean;
  completed: boolean;
  iterationCount: number;
  totalIterations: number;
  firstError: string | null;
}

interface CompletedIteration {
  iteration: number;
  query: string;
  finding: string;
  confidence: number;
  platform?: string;
  category?: string;
  sources?: string[];
  materiality?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeBraces(text: string): string {
  if (!text) return text;
  return text.replace(/\{/g, "\uFE5B").replace(/\}/g, "\uFE5C");
}

/** Build the "previousFindings" summary string from completed iterations */
function buildPreviousFindings(iterations: CompletedIteration[]): string {
  if (iterations.length === 0) return "";
  return iterations
    .map(
      (it) =>
        `Iteration ${it.iteration}: [${it.category ?? it.platform ?? "GENERAL"}] ${it.query} → ${it.finding.slice(0, 300)} (confidence: ${it.confidence}/10)`
    )
    .join("\n\n");
}

/** Build deal context string from deal metadata */
function buildDealContext(dealName: string, dealDescription: string | null): string {
  return dealDescription
    ? `${dealName} — ${dealDescription}`
    : dealName;
}

/** Build document context from routed extractions (first ~20k chars of findings) */
function buildDocContext(
  routed: Array<{ extraction_json: any }>
): string {
  const parts: string[] = [];
  let totalLen = 0;
  const MAX_DOC_CONTEXT = 20_000;

  for (const row of routed) {
    const ext =
      typeof row.extraction_json === "string"
        ? JSON.parse(row.extraction_json)
        : row.extraction_json;
    // Use findings or raw text from extraction
    const text = ext.findings ?? ext.keyFacts ?? ext.rawText ?? "";
    const chunk = typeof text === "string" ? text : JSON.stringify(text);
    if (totalLen + chunk.length > MAX_DOC_CONTEXT) {
      parts.push(chunk.slice(0, MAX_DOC_CONTEXT - totalLen));
      break;
    }
    parts.push(chunk);
    totalLen += chunk.length;
  }

  return parts.join("\n---\n");
}

// ---------------------------------------------------------------------------
// Main Phase Function
// ---------------------------------------------------------------------------
export async function runWebResearchPhase(
  ctx: PipelineContext,
  dealId: string,
  moduleId: string,
  runId: string,
  startTime: number,
  timeBudgetMs: number,
  routed: Array<{ document_id: string; chunk_index: number; extraction_json: any }>
): Promise<WebResearchPhaseResult> {
  const maxIterations =
    moduleId === "social_reputation"
      ? SOCIAL_REPUTATION_MAX_ITERATIONS
      : EXTERNAL_RISK_MAX_ITERATIONS;

  // --- Step 1: Load completed iterations from DB (resume point) ---
  const existingRows = await ctx.integrations.db.query(
    `SELECT iteration, query, finding, confidence, platform, category, sources, materiality, status
     FROM web_research_iterations
     WHERE run_id = $1 AND status = 'completed'
     ORDER BY iteration`,
    IterationRowSchema,
    [runId],
    { label: "Load completed web research iterations" }
  );

  const completedIterations: CompletedIteration[] = existingRows.map((row) => ({
    iteration: row.iteration,
    query: row.query ?? "research",
    finding: row.finding ?? "",
    confidence: row.confidence ?? 0,
    platform: row.platform ?? undefined,
    category: row.category ?? undefined,
    sources: Array.isArray(row.sources) ? row.sources.map(String) : undefined,
    materiality: row.materiality ?? undefined,
  }));

  // If all iterations already done, short-circuit
  if (completedIterations.length >= maxIterations) {
    return {
      needed: true,
      completed: true,
      iterationCount: completedIterations.length,
      totalIterations: maxIterations,
      firstError: null,
    };
  }

  // Check confidence-based early stopping on existing data
  let consecutiveHigh = 0;
  for (let i = completedIterations.length - 1; i >= 0; i--) {
    if (completedIterations[i].confidence >= CONFIDENCE_THRESHOLD) {
      consecutiveHigh++;
    } else {
      break;
    }
  }
  if (consecutiveHigh >= CONSECUTIVE_THRESHOLD && completedIterations.length > 0) {
    return {
      needed: true,
      completed: true,
      iterationCount: completedIterations.length,
      totalIterations: maxIterations,
      firstError: null,
    };
  }

  // --- Step 2: Build context ---
  const dealRows = await ctx.integrations.db.query(
    `SELECT name, description FROM deals WHERE id = $1 LIMIT 1`,
    z.object({ name: z.string(), description: z.string().nullable() }),
    [dealId],
    { label: "Load deal for web research context" }
  );
  if (dealRows.length === 0) {
    return {
      needed: true,
      completed: false,
      iterationCount: completedIterations.length,
      totalIterations: maxIterations,
      firstError: "Deal not found",
    };
  }

  const dealContext = buildDealContext(dealRows[0].name, dealRows[0].description);
  const docContext = buildDocContext(routed);
  const researchCategories = SOCIAL_REPUTATION_CATEGORIES;

  // --- Step 3: Run remaining iterations sequentially ---
  let firstError: string | null = null;
  const startIteration = completedIterations.length + 1;

  for (let i = startIteration; i <= maxIterations; i++) {
    // Budget check before starting this iteration
    const elapsed = Date.now() - startTime;
    const remaining = timeBudgetMs - elapsed;
    if (remaining < 30_000) {
      // Not enough budget for another iteration — return partial
      console.log(
        `[WebResearch] Budget exhausted before iteration ${i} (${Math.round(remaining / 1000)}s left)`
      );
      return {
        needed: true,
        completed: false,
        iterationCount: completedIterations.length,
        totalIterations: maxIterations,
        firstError,
      };
    }

    // Build prompt with current state of previous findings
    const previousFindings = buildPreviousFindings(completedIterations);
    let iterationPrompt: string;
    const systemPrompt =
      moduleId === "social_reputation"
        ? SOCIAL_REPUTATION_SYSTEM_PROMPT
        : EXTERNAL_RISK_SYSTEM_PROMPT;

    if (moduleId === "social_reputation") {
      iterationPrompt = buildSocialReputationIterationPrompt(
        sanitizeBraces(dealContext),
        sanitizeBraces(docContext),
        sanitizeBraces(previousFindings),
        sanitizeBraces(researchCategories)
      );
    } else {
      iterationPrompt = buildExternalRiskIterationPrompt(
        sanitizeBraces(dealContext),
        sanitizeBraces(docContext),
        sanitizeBraces(previousFindings)
      );
    }

    const label = `Web research: ${moduleId} iteration ${i}/${maxIterations}`;

    // Deadline for this specific iteration: min(ITERATION_DEADLINE_MS, remaining budget)
    const iterationDeadlineMs = Date.now() + Math.min(ITERATION_DEADLINE_MS, remaining - 5_000);
    // Overall deadline passed to the retry loop inside runWebSearchIteration
    const overallDeadlineMs = startTime + timeBudgetMs;

    try {
      // Race the iteration against its own deadline (invariant #3)
      const { text, truncated } = await Promise.race([
        runWebSearchIteration(
          ctx.integrations.ai,
          systemPrompt,
          iterationPrompt,
          overallDeadlineMs, // Budget check inside retry loop (invariant #2)
          label
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Iteration ${i} exceeded deadline (${Math.round(ITERATION_DEADLINE_MS / 1000)}s)`)),
            Math.max(1000, iterationDeadlineMs - Date.now())
          )
        ),
      ]);

      const parsed = parseIterationResult(text, i);

      // Checkpoint write: ON CONFLICT DO UPDATE (invariant #1)
      await ctx.integrations.db.execute(
        `INSERT INTO web_research_iterations
           (deal_id, run_id, module_id, iteration, query, finding, confidence, platform, category, sources, materiality, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'completed')
         ON CONFLICT (run_id, iteration)
         DO UPDATE SET
           query = EXCLUDED.query,
           finding = EXCLUDED.finding,
           confidence = EXCLUDED.confidence,
           platform = EXCLUDED.platform,
           category = EXCLUDED.category,
           sources = EXCLUDED.sources,
           materiality = EXCLUDED.materiality,
           status = 'completed',
           error_message = NULL`,
        [
          dealId,
          runId,
          moduleId,
          i,
          parsed.query,
          truncated ? `[TRUNCATED] ${parsed.finding}` : parsed.finding,
          parsed.confidence,
          parsed.platform ?? null,
          parsed.category ?? null,
          parsed.sources ? JSON.stringify(parsed.sources) : null,
          parsed.materiality ?? null,
        ],
        { label: `Checkpoint iteration ${i}` }
      );

      // Track in memory for next iteration's prompt
      completedIterations.push({
        iteration: i,
        query: parsed.query,
        finding: truncated ? `[TRUNCATED] ${parsed.finding}` : parsed.finding,
        confidence: parsed.confidence,
        platform: parsed.platform,
        category: parsed.category,
        sources: parsed.sources,
        materiality: parsed.materiality,
      });

      console.log(
        `[WebResearch] Iteration ${i}/${maxIterations} complete — confidence ${parsed.confidence}/10${truncated ? " [TRUNCATED]" : ""}`
      );

      // Confidence-based early stopping
      if (parsed.confidence >= CONFIDENCE_THRESHOLD) {
        consecutiveHigh++;
        if (consecutiveHigh >= CONSECUTIVE_THRESHOLD) {
          console.log(
            `[WebResearch] Early stop: ${consecutiveHigh} consecutive iterations at confidence >= ${CONFIDENCE_THRESHOLD}`
          );
          return {
            needed: true,
            completed: true,
            iterationCount: completedIterations.length,
            totalIterations: maxIterations,
            firstError,
          };
        }
      } else {
        consecutiveHigh = 0;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[WebResearch] Iteration ${i} failed: ${msg}`);

      if (!firstError) firstError = msg;

      // Checkpoint the failure (ON CONFLICT DO UPDATE — invariant #1)
      await ctx.integrations.db.execute(
        `INSERT INTO web_research_iterations
           (deal_id, run_id, module_id, iteration, status, error_message)
         VALUES ($1, $2, $3, $4, 'failed', $5)
         ON CONFLICT (run_id, iteration)
         DO UPDATE SET
           status = 'failed',
           error_message = EXCLUDED.error_message`,
        [dealId, runId, moduleId, i, msg.slice(0, 500)],
        { label: `Checkpoint failed iteration ${i}` }
      );

      // If budget was exhausted, return partial immediately
      if (/budget exhausted/i.test(msg)) {
        return {
          needed: true,
          completed: false,
          iterationCount: completedIterations.length,
          totalIterations: maxIterations,
          firstError,
        };
      }

      // Otherwise continue to next iteration (the failed one is checkpointed)
      // Don't add to completedIterations — it shouldn't count toward stopping logic
    }
  }

  // All iterations done (or skipped due to failures)
  return {
    needed: true,
    completed: true,
    iterationCount: completedIterations.length,
    totalIterations: maxIterations,
    firstError,
  };
}
