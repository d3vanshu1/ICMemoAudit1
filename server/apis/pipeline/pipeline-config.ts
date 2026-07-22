/**
 * Pipeline Configuration — single source of truth for platform-aware timing constants.
 *
 * All timing-related constants are derived from PLATFORM_CAP_MS so the pipeline
 * self-adjusts when the platform timeout changes (env: SB_API_TIMEOUT_MS).
 *
 * Invariant: No single LLM call or retry sequence can exceed
 * PLATFORM_CAP_MS − elapsed − PLATFORM_HEADROOM_MS at the point it starts.
 * This is enforced by callLLMWithHeadroom(), the sole entry point for all LLM calls.
 */
import type { z } from "@superblocksteam/sdk-api";

// ===========================================================================
// Platform Envelope
// ===========================================================================

/** Platform hard-kill timeout (ms). Read from env so it self-adjusts when
 *  the platform cap is changed. Verified via DiagTimeoutProbe v2:
 *  - 570s probe survived cleanly (probe_id 2f81f13a, 2026-07-22)
 *  See: https://docs.superblocks.com/enterprise/hybrid-architecture/manage/size_and_time_limits */
export const PLATFORM_CAP_MS = Number(process.env.SB_API_TIMEOUT_MS) || 600_000;

/** Safety buffer subtracted from remaining headroom before starting any
 *  long-running operation. Covers final checkpoint writes + DB overhead. */
export const PLATFORM_HEADROOM_MS = 30_000;

// ===========================================================================
// Derived Time Budgets (all flow from PLATFORM_CAP_MS)
// ===========================================================================

/** Pipeline's own graceful exit point — derived from platform cap.
 *  100s headroom: enough for post-extraction work (analysis start, DB writes)
 *  even in worst-case paths. */
export const TIME_BUDGET_MS = PLATFORM_CAP_MS - 100_000;

/** Minimum budget (ms) required to even attempt an LLM call.
 *  Below this, the call is virtually certain to timeout → wastes an attempt.
 *  Based on observed solo extraction times: median 40-60s, hard chunks 80-120s.
 *  60s gives a realistic shot at success for most chunks. */
export const MIN_VIABLE_LLM_BUDGET_MS = 60_000;

/** Extraction phase's own budget (ms). At 600s cap this is 250s — leaves
 *  headroom for analysis (Step 0.4), absence verification (0.6), merge (0.7).
 *  Formula: cap × 0.42 (rounded to nearest 10s). */
export const EXTRACTION_TIME_BUDGET_MS = Math.round((PLATFORM_CAP_MS * 0.42) / 10_000) * 10_000;

/** ResumeStalePipelines job budget (ms). Derived as cap minus headroom for
 *  DB writes after pipeline completes (same 30s). */
export const RESUME_JOB_TIME_BUDGET_MS = PLATFORM_CAP_MS - PLATFORM_HEADROOM_MS;

/** Staleness threshold (minutes) for the background sweeper.
 *  Must exceed the longest possible legitimate invocation so the sweeper never
 *  claims a still-running pipeline.
 *  Formula: ceil(cap_in_minutes) + 2 (2 min grace for clock skew + DB latency). */
export const STALENESS_THRESHOLD_MINUTES = Math.ceil(PLATFORM_CAP_MS / 60_000) + 2; // 12 at 600s cap

// ===========================================================================
// Types (shared across pipeline files — lives here to avoid circular imports)
// ===========================================================================

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
