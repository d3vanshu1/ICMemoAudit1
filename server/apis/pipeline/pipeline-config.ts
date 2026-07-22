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

/** Platform hard-kill timeout (ms).
 *
 *  DELIBERATE PIN: SB_API_TIMEOUT_MS is NOT a user-settable env var in Superblocks.
 *  The platform cap is controlled via `superblocks_agent_quotas_default_api_timeout`
 *  on the self-hosted data plane — we cannot read it at runtime.
 *
 *  Pinned to 600_000 based on empirical verification:
 *    - DiagTimeoutProbe v2, 570s sleep survived (probe_id 2f81f13a, 2026-07-22)
 *    - Re-probe required if Superblocks changes the cap (run DiagTimeoutProbe at 570s)
 *    - If the cap is ever reverted to 300s, this pin causes the pipeline to breach
 *      the platform kill — TIME_BUDGET_MS would be 500s, far past the 300s kill.
 *      That failure mode is loud (every run dies immediately), not silent.
 *
 *  Fallback: if the env var IS ever exposed, it overrides the pin (fail-safe: lower
 *  values make the pipeline more conservative, never less safe). */
export const PLATFORM_CAP_MS = Number(process.env.SB_API_TIMEOUT_MS) || 300_000;

/** Effective cap: deliberate pin at 600s, verified via DiagTimeoutProbe.
 *  The fallback above is 300s (fail-safe). This override is the operational value.
 *  To revert to 300s operation: set PIPELINE_CAP_OVERRIDE_MS = undefined. */
const PIPELINE_CAP_OVERRIDE_MS: number | undefined = 600_000;

/** The actual cap used for all derived constants. Override wins if set. */
export const EFFECTIVE_CAP_MS = PIPELINE_CAP_OVERRIDE_MS ?? PLATFORM_CAP_MS;

/** Safety buffer subtracted from remaining headroom before starting any
 *  long-running operation. Covers final checkpoint writes + DB overhead. */
export const PLATFORM_HEADROOM_MS = 30_000;

// ===========================================================================
// Derived Time Budgets (all flow from PLATFORM_CAP_MS)
// ===========================================================================

/** Pipeline's own graceful exit point — derived from effective cap.
 *  100s headroom: enough for post-extraction work (DB writes, checkpoint saves)
 *  even in worst-case paths. Floor of 120s prevents nonsensical sub-minute budgets. */
export const TIME_BUDGET_MS = Math.max(120_000, EFFECTIVE_CAP_MS - 100_000);

/** Minimum budget (ms) required to even attempt an LLM call.
 *  Below this, the call is virtually certain to timeout → wastes an attempt.
 *  Based on observed solo extraction times: median 40-60s, hard chunks 80-120s.
 *  60s gives a realistic shot at success for most chunks. */
export const MIN_VIABLE_LLM_BUDGET_MS = 60_000;

/** Extraction phase's own budget (ms). At 600s cap this is 250s — leaves
 *  headroom for clean-parsed-text (Step 0.4), doc-tables (0.6), numeric-inline (0.7).
 *  Formula: effective_cap × 0.42 (rounded to nearest 10s). */
export const EXTRACTION_TIME_BUDGET_MS = Math.round((EFFECTIVE_CAP_MS * 0.42) / 10_000) * 10_000;

/** ResumeStalePipelines job budget (ms). Derived as effective cap minus headroom for
 *  DB writes after pipeline completes (same 30s). */
export const RESUME_JOB_TIME_BUDGET_MS = EFFECTIVE_CAP_MS - PLATFORM_HEADROOM_MS;

/** Staleness threshold (minutes) for the background sweeper.
 *  Must exceed the longest possible legitimate invocation so the sweeper never
 *  claims a still-running pipeline.
 *  Formula: ceil(effective_cap_in_minutes) + 2 (2 min grace for clock skew + DB latency). */
export const STALENESS_THRESHOLD_MINUTES = Math.ceil(EFFECTIVE_CAP_MS / 60_000) + 2; // 12 at 600s cap

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
