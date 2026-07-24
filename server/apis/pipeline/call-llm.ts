/**
 * Shared budget-aware LLM call helper.
 *
 * ALL Anthropic LLM calls in the pipeline route through this function.
 * It enforces:
 *   1. Per-attempt headroom check against the pipeline's platform clock
 *   2. Per-attempt timeout clamped to remaining headroom
 *   3. Retry with exponential backoff (only when headroom permits)
 *
 * Callers no longer manage their own Promise.race / setTimeout / retry loops.
 */
import { z } from "@superblocksteam/sdk-api";
import { EFFECTIVE_CAP_MS, PLATFORM_HEADROOM_MS, MIN_VIABLE_LLM_BUDGET_MS, type PipelineContext } from "./pipeline-config.js";

// ---------------------------------------------------------------------------
// Schema (same MessageResponseSchema used across pipeline-core & extraction)
// ---------------------------------------------------------------------------
export const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  model: z.string(),
  stop_reason: z.string().nullable(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

export type LLMResponse = z.infer<typeof MessageResponseSchema>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
export interface CallLLMOptions {
  /** Pipeline invocation start time (Date.now() at the very top of runPipelineCore) */
  pipelineStartTime: number;
  /** Maximum per-call timeout (ms). Clamped down to headroom if headroom is smaller. */
  maxPerCallTimeout?: number;
  /** Number of retry attempts (default: 3) */
  retries?: number;
  /** Minimum remaining headroom (ms) to even start a call. Default: MIN_VIABLE_LLM_BUDGET_MS */
  minBudget?: number;
}

// ---------------------------------------------------------------------------
// Error class for headroom exhaustion (not a retriable error)
// ---------------------------------------------------------------------------
export class HeadroomExhaustedError extends Error {
  constructor(remainingMs: number, label: string) {
    super(`Headroom exhausted (${Math.round(remainingMs / 1000)}s remaining) — cannot start LLM call: ${label}`);
    this.name = "HeadroomExhaustedError";
  }
}

// ---------------------------------------------------------------------------
// Main helper
// ---------------------------------------------------------------------------
/**
 * Call the Anthropic API with budget-aware retry and platform-clock enforcement.
 *
 * @throws HeadroomExhaustedError if there's not enough headroom to start/continue
 * @throws Error on non-retryable failures or after all retries exhausted
 */
export async function callLLMWithHeadroom(
  ctx: PipelineContext,
  body: Record<string, unknown>,
  label: string,
  options: CallLLMOptions
): Promise<LLMResponse> {
  const {
    pipelineStartTime,
    maxPerCallTimeout = 120_000,
    retries = 3,
    minBudget = MIN_VIABLE_LLM_BUDGET_MS,
  } = options;

  const attemptErrors: string[] = [];

  for (let attempt = 1; attempt <= retries; attempt++) {
    // --- Headroom check BEFORE every attempt ---
    const elapsed = Date.now() - pipelineStartTime;
    const remainingHeadroom = EFFECTIVE_CAP_MS - elapsed - PLATFORM_HEADROOM_MS;

    if (remainingHeadroom < minBudget) {
      const priorErrors = attemptErrors.length > 0
        ? ` | prior_errors: [${attemptErrors.join("; ")}]`
        : "";
      throw new HeadroomExhaustedError(
        remainingHeadroom,
        `${label} (attempt ${attempt}/${retries})${priorErrors}`
      );
    }

    // Budget-aware retry guard (Freeze Exception #4):
    // For retry attempts (not the first), require enough headroom for a FULL attempt
    // at maxPerCallTimeout. A clamped retry with insufficient headroom almost certainly
    // times out again, wasting seconds before the platform kill hits.
    if (attempt > 1 && remainingHeadroom < maxPerCallTimeout) {
      const priorErrors = attemptErrors.length > 0
        ? ` | prior_errors: [${attemptErrors.join("; ")}]`
        : "";
      throw new HeadroomExhaustedError(
        remainingHeadroom,
        `${label} — insufficient headroom for retry (attempt ${attempt}/${retries}, need ${Math.round(maxPerCallTimeout / 1000)}s, have ${Math.round(remainingHeadroom / 1000)}s)${priorErrors}`
      );
    }

    // Clamp per-call timeout to remaining headroom (minus 5s buffer for post-call work)
    const callTimeout = Math.min(maxPerCallTimeout, remainingHeadroom - 5_000);

    try {
      const result = await Promise.race([
        ctx.integrations.ai.apiRequest(
          { method: "POST", path: "/v1/messages", body },
          { response: MessageResponseSchema },
          { label }
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`LLM call timed out after ${Math.round(callTimeout / 1000)}s: ${label}`)),
            callTimeout
          )
        ),
      ]);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attemptErrors.push(`attempt_${attempt}: ${msg.slice(0, 200)}`);

      const isRetryable = /503|429|500|rate.?limit|service.?unavailable|overloaded|timed out|too many|capacity|throttl|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
      if (!isRetryable || attempt === retries) throw err;

      // Exponential backoff (capped at 15s)
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 15_000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("Unreachable");
}
