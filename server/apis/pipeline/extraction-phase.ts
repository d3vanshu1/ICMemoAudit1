/**
 * Extraction Phase — ensures universal_extractions exist for a deal.
 *
 * Loads documents, chunks them, identifies gaps against existing extractions
 * in the DB, and runs the LLM extraction prompt on missing chunks
 * (with concurrency + time budget), saving results incrementally.
 *
 * Returns:
 *  - { needed: false } if all expected chunks are already extracted
 *  - { needed: true, completed: true, totalChunks } if all gaps filled in this call
 *  - { needed: true, completed: false, extractedSoFar, totalChunks } if time budget ran out
 */
import { z } from "@superblocksteam/sdk-api";
import {
  UNIVERSAL_EXTRACTION_PROMPT,
  injectClaimIds,
  sanitizeBraces,
  isSpreadsheetFile,
  chunkDocument,
  CHUNK_CHARS,
  EXTRACTION_MODEL,
  EXTRACTION_CONCURRENCY,
  type TextChunk,
} from "./extraction-prompt.js";
import type { PipelineContext } from "./pipeline-core.js";
import { EFFECTIVE_CAP_MS, PLATFORM_HEADROOM_MS, MIN_VIABLE_LLM_BUDGET_MS, EXTRACTION_TIME_BUDGET_MS, CHECKPOINT_RESERVE_MS } from "./pipeline-config.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const EXTRACTION_MAX_TOKENS = 16000;

// EFFECTIVE_CAP_MS, PLATFORM_HEADROOM_MS, EXTRACTION_TIME_BUDGET_MS imported from pipeline-config.ts (single source of truth)

/** Minimum budget (ms) required to even attempt an escalation retry.
 *  Below this, the retry is virtually certain to timeout → wastes an attempt.
 *  Based on observed solo extraction times: median 40-60s, hard chunks 80-120s.
 *  60s gives a realistic shot at success for most chunks. */
const MIN_ESCALATION_BUDGET_MS = MIN_VIABLE_LLM_BUDGET_MS;

/** Inter-call stagger delay within a batch (ms). Spreads 8 calls over ~1.75s
 *  instead of firing all simultaneously, reducing 429 bursts. */
const STAGGER_DELAY_MS = 250;

/** Maximum number of gap-fill chunks to attempt per invocation.
 *  At 600s cap with 250s extraction budget, we can process ~6 full batches
 *  of 8 concurrently (48 chunks). Spreading load across invocations for
 *  larger gap sets still prevents rate-limit storms.
 *
 *  RATE-LIMIT MATH (Anthropic via Superblocks integration):
 *  - Peak instantaneous concurrency: 8 (EXTRACTION_CONCURRENCY)
 *  - Stagger: 250ms between calls in a batch → 8 calls over 1.75s
 *  - Inter-batch cooldown: 5s (INTER_BATCH_COOLDOWN_MS)
 *  - Observed extraction response time: 40-120s per call
 *  - Effective batch cadence: ~45-125s per batch (response_time + cooldown)
 *  - Peak RPM (extraction phase alone): ~8 req / 45s = ~10.7 RPM (best case)
 *  - Total requests per invocation: 48 (spread over ~250s of wall-clock)
 *  - This is 3× the prior 16-gap cap; validated against the same
 *    EXTRACTION_CONCURRENCY=8 that was reduced from 12 specifically to avoid
 *    429 storms. At 8 concurrent with 250ms stagger, we stay well under the
 *    account-level RPM tier (empirically, 429s ceased at concurrency ≤ 8).
 *  - If 429s return at 48 gaps, reduce MAX_GAPS back or increase COOLDOWN. */
const MAX_GAPS_PER_INVOCATION = 48; // 6 full batches of 8

/** Cooldown between batches (ms) when processing gap-fills.
 *  Only applied when total gaps exceed MAX_GAPS_PER_INVOCATION — gives the
 *  rate limiter time to recover between batches. */
const INTER_BATCH_COOLDOWN_MS = 5_000;

/** When remaining gap-fill chunks are ≤ this count, drop concurrency to 1 ("solo"
 *  mode) so each call gets the full time budget rather than sharing it.
 *  Set to match EXTRACTION_CONCURRENCY: if the gaps fit in one batch anyway,
 *  there's no throughput cost to running them sequentially with full budgets. */
const SMALL_TAIL_THRESHOLD = 8;

/** Budget floor for the solo path (ms). Solo calls only bail when less than
 *  this much time remains. Set to 45s because a successful solo extraction
 *  typically needs 40-80s of model time; anything less fires a doomed call
 *  that wastes an attempt and increments toward permanent failure. */
const SOLO_BUDGET_CHECK_MS = 45_000;

/** Escalating budgets for extraction attempts (ms). Each entry is the DESIRED
 *  budget for that attempt level; actual budget is clamped to platform headroom.
 *  Attempt 1: 150s | Attempt 2: 210s | Attempt 3: 270s
 *  Graduated so we learn whether borderline chunks succeed at intermediate budgets. */
const ESCALATION_BUDGETS = [150_000, 210_000, 270_000] as const;
const MAX_EXTRACTION_ATTEMPTS = ESCALATION_BUDGETS.length; // 3

/** Page size for loading existing extraction keys (small rows: ~80 bytes each) */
const EXTRACTION_KEYS_PAGE_SIZE = 5000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const DocumentMetaSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  document_tag: z.string().nullable(),
  text_length: z.coerce.number(),
});

const TextSegmentSchema = z.object({
  segment: z.string(),
});

/** Max bytes per text segment query (stay well under the 4MB gRPC cap) */
const TEXT_SEGMENT_SIZE = 3_000_000; // ~3MB

const ExistingChunkSchema = z.object({
  document_id: z.string(),
  chunk_index: z.coerce.number(),
  is_failed: z.coerce.boolean(),
  is_truncated: z.coerce.boolean(),
  attempt_count: z.coerce.number(),
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ExtractionPassStats {
  attemptedThisPass: number;
  succeededThisPass: number;
  failedThisPass: number;
  skippedDueToBudget: number;
}

export type ExtractionPhaseResult =
  | { needed: false }
  | { needed: true; completed: true; totalChunks: number }
  | { needed: true; completed: false; extractedSoFar: number; totalChunks: number; failedChunks: number; firstError: string | null; passStats: ExtractionPassStats };

// ---------------------------------------------------------------------------
// LLM call with retry + truncation detection
// ---------------------------------------------------------------------------
interface ExtractionLLMResult {
  text: string;
  truncated: boolean;
}

async function callExtractionLLM(
  ctx: PipelineContext,
  chunk: TextChunk,
  totalChunks: number,
  startTime: number,
  retries = 3,
  solo = false,
  budgetOverride?: number
): Promise<ExtractionLLMResult> {
  const label = `Extract: ${sanitizeBraces(chunk.label)} (${chunk.chunkIndex + 1}/${totalChunks})`;
  const body = {
    model: EXTRACTION_MODEL,
    max_tokens: EXTRACTION_MAX_TOKENS,
    system: [
      {
        type: "text",
        text: UNIVERSAL_EXTRACTION_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `--- Extracted text from "${sanitizeBraces(chunk.label)}" ---\n\n${sanitizeBraces(chunk.text)}\n\nThe above is "${sanitizeBraces(chunk.label)}" (source: ${sanitizeBraces(chunk.sourceFile)}). Perform a comprehensive extraction now.`,
      },
    ],
  };

  // Accumulate errors from each attempt so we can persist the full retry history
  // when the budget-exhaustion check fires (which otherwise hides the root cause).
  const attemptErrors: string[] = [];

  for (let attempt = 1; attempt <= retries; attempt++) {
    // Budget check before each attempt (not just the first).
    // A single call can take up to 120s; if less than that remains, bail early.
    const effectiveBudget = budgetOverride ?? (solo ? ESCALATION_BUDGETS[0] : EXTRACTION_TIME_BUDGET_MS);
    const remaining = effectiveBudget - (Date.now() - startTime);
    const budgetFloor = solo ? SOLO_BUDGET_CHECK_MS : 30_000;
    if (remaining < budgetFloor) {
      const priorErrors = attemptErrors.length > 0
        ? ` | prior_errors: [${attemptErrors.join("; ")}]`
        : "";
      throw new Error(`Budget exhausted mid-retry (attempt ${attempt}/${retries}, ${Math.round(remaining / 1000)}s left): ${label}${priorErrors}`);
    }

    try {
      const callTimeout = solo
        ? remaining - 10_000          // Solo: uncapped — ~140s on fresh budget
        : Math.min(120_000, remaining - 5_000); // Concurrent: capped at 120s
      const result = await Promise.race([
        ctx.integrations.ai.apiRequest(
          { method: "POST", path: "/v1/messages", body },
          { response: MessageResponseSchema },
          { label }
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(
            `Extraction LLM timed out after ${Math.round(callTimeout / 1000)}s: ${label}`
          )), callTimeout)
        ),
      ]);
      const textBlock = result.content.find((c: { type: string }) => c.type === "text");
      if (!textBlock) throw new Error(`No text in response for ${chunk.label}`);

      // Truncation detection: stop_reason === "max_tokens" means the response
      // was cut off mid-generation. The text may be incomplete/invalid JSON.
      const truncated = result.stop_reason === "max_tokens";

      return { text: textBlock.text.trim(), truncated };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attemptErrors.push(`attempt_${attempt}: ${msg.slice(0, 200)}`);
      // Broad retryable check — covers HTTP status codes, Anthropic error messages,
      // and Superblocks SDK integration error wrappers.
      const isRetryable = /503|429|500|rate.?limit|service.?unavailable|overloaded|timed out|too many|capacity|throttl|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
      if (!isRetryable || attempt === retries) throw err;
      await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(2, attempt - 1), 15000)));
    }
  }
  throw new Error("Unreachable");
}

// ---------------------------------------------------------------------------
// Main extraction phase
// ---------------------------------------------------------------------------
export async function runExtractionPhase(
  ctx: PipelineContext,
  dealId: string,
  startTime: number,
  runId?: string
): Promise<ExtractionPhaseResult> {
  // --- Step A: Load document metadata (no parsed_text) ---
  const docMetas: Array<{ id: string; file_name: string; document_tag: string | null; text_length: number }> = [];
  let docOffset = 0;

  while (true) {
    const page = await ctx.integrations.db.query(
      `SELECT id, file_name, document_tag, COALESCE(length(parsed_text), 0) AS text_length
       FROM documents
       WHERE deal_id = $1
       ORDER BY file_name
       LIMIT 10 OFFSET ${docOffset}`,
      DocumentMetaSchema,
      [dealId],
      { label: `Load doc metadata (offset ${docOffset})` }
    );
    if (page.length === 0) break;
    docOffset += page.length;
    for (const doc of page) {
      if (isSpreadsheetFile(doc.file_name)) continue;
      if (doc.text_length === 0) continue;
      docMetas.push(doc);
    }
  }

  if (docMetas.length === 0) {
    return { needed: true, completed: true, totalChunks: 0 };
  }

  // --- Step B: Load existing extraction keys (paginated) ---
  // Each row is small (~80 bytes: UUID + int + two bools), but row count can
  // grow unboundedly across re-processing cycles. Page to stay under 4MB gRPC cap.
  const existingRows: Array<{ document_id: string; chunk_index: number; is_failed: boolean; is_truncated: boolean; attempt_count: number }> = [];
  let keysOffset = 0;

  while (true) {
    const page = await ctx.integrations.db.query(
      `SELECT document_id, chunk_index,
              COALESCE((extraction_json->>'failed')::boolean, false) AS is_failed,
              COALESCE((extraction_json->>'truncated')::boolean, false) AS is_truncated,
              COALESCE((extraction_json->>'attempt_count')::int,
                CASE WHEN COALESCE((extraction_json->>'failed')::boolean, false) THEN 1 ELSE 0 END
              ) AS attempt_count
       FROM universal_extractions
       WHERE deal_id = $1
       ORDER BY document_id, chunk_index
       LIMIT ${EXTRACTION_KEYS_PAGE_SIZE} OFFSET ${keysOffset}`,
      ExistingChunkSchema,
      [dealId],
      { label: `Load existing extraction keys (offset ${keysOffset})` }
    );
    existingRows.push(...page);
    if (page.length < EXTRACTION_KEYS_PAGE_SIZE) break;
    keysOffset += EXTRACTION_KEYS_PAGE_SIZE;
  }

  // Build a set of successfully-extracted (doc_id, chunk_index) pairs.
  // Exclude failed AND truncated extractions — they need to be re-done.
  const extractedSet = new Set<string>();
  // Track attempt counts for failed chunks (used by escalation logic).
  const failedChunkAttempts = new Map<string, number>();
  for (const row of existingRows) {
    if (!row.is_failed && !row.is_truncated) {
      extractedSet.add(`${row.document_id}:${row.chunk_index}`);
    }
    if (row.is_failed) {
      failedChunkAttempts.set(`${row.document_id}:${row.chunk_index}`, row.attempt_count);
    }
  }

  // --- Step C: Per-document gap detection ---
  // Do NOT use an aggregate short-circuit here. A surplus in one document
  // can numerically mask a deficit in another. Check each document individually.
  const allChunks: TextChunk[] = [];
  const tagByDocId: Record<string, string> = {};

  for (const doc of docMetas) {
    // Check how many chunks this doc should have
    const expectedDocChunks = Math.ceil(doc.text_length / CHUNK_CHARS);
    // Count how many successful extractions exist for this doc
    let existingDocCount = 0;
    for (let i = 0; i < expectedDocChunks; i++) {
      if (extractedSet.has(`${doc.id}:${i}`)) existingDocCount++;
    }
    if (existingDocCount >= expectedDocChunks) continue; // doc fully extracted

    // Fetch parsed_text in segments to stay under 4MB gRPC cap
    let parsedText = "";
    if (doc.text_length <= TEXT_SEGMENT_SIZE) {
      const rows = await ctx.integrations.db.query(
        `SELECT parsed_text AS segment FROM documents WHERE id = $1`,
        TextSegmentSchema,
        [doc.id],
        { label: `Load text: ${doc.file_name}` }
      );
      parsedText = rows[0]?.segment ?? "";
    } else {
      let pos = 1; // SQL SUBSTRING is 1-indexed
      while (pos <= doc.text_length) {
        const rows = await ctx.integrations.db.query(
          `SELECT SUBSTRING(parsed_text FROM ${pos} FOR ${TEXT_SEGMENT_SIZE}) AS segment FROM documents WHERE id = $1`,
          TextSegmentSchema,
          [doc.id],
          { label: `Load text segment ${Math.ceil(pos / TEXT_SEGMENT_SIZE)}: ${doc.file_name}` }
        );
        parsedText += rows[0]?.segment ?? "";
        pos += TEXT_SEGMENT_SIZE;
      }
    }

    if (!parsedText.trim()) continue;

    tagByDocId[doc.id] = doc.document_tag ?? "other";
    const chunks = chunkDocument(doc.file_name, doc.id, parsedText);
    // Only keep chunks that haven't been successfully extracted yet
    // and haven't exhausted all retry attempts.
    for (const chunk of chunks) {
      const key = `${doc.id}:${chunk.chunkIndex}`;
      if (extractedSet.has(key)) continue; // already succeeded
      const attempts = failedChunkAttempts.get(key) ?? 0;
      if (attempts >= MAX_EXTRACTION_ATTEMPTS) continue; // permanently exhausted
      allChunks.push(chunk);
    }
  }

  // Prioritize the three always-failing documents so we get diagnostic data sooner
  const PRIORITY_DOC_IDS = new Set([
    "5c0e0060-0d36-4971-88e9-3bc440041897", // SCG - Project Saint-IM_vF.pdf
    "989537e9-cad0-4588-b7d0-5391d29a44d8", // 2026-06-21 Saint IC update_vS.pdf
    "b5ae5ba1-ef41-4947-a706-7c888c896e6a", // SCG IC Screening Memo vS.pdf
  ]);
  allChunks.sort((a, b) => {
    const aPri = PRIORITY_DOC_IDS.has(a.documentId) ? 0 : 1;
    const bPri = PRIORITY_DOC_IDS.has(b.documentId) ? 0 : 1;
    return aPri - bPri;
  });

  const successfulCount = extractedSet.size;
  const totalChunks = allChunks.length + successfulCount; // total = pending + already done
  if (allChunks.length === 0) {
    // All documents fully covered
    return { needed: false };
  }

  // --- Step D: Process missing chunks in batches with concurrency ---
  let extractedSoFar = successfulCount;
  let failedChunks = 0;
  let firstError: string | null = null;
  let budgetExhausted = false;

  // Per-pass observability counters
  let attemptedThisPass = 0;
  let succeededThisPass = 0;
  let failedThisPass = 0;

  // Budget override for solo mode — set per-iteration before calling processBatch.
  // Clamped to platform headroom so solo chunks can't breach the platform cap.
  let soloBudgetOverride: number | undefined;

  const processBatch = async (batch: TextChunk[]): Promise<void> => {
    // Stagger launches: each call starts STAGGER_DELAY_MS after the previous one.
    // All calls still run concurrently once launched — only the start is spread out.
    const promises: Promise<{ success: boolean; error: string | null }>[] = [];
    for (let idx = 0; idx < batch.length; idx++) {
      const chunk = batch[idx];
      // Delay each call (first fires immediately)
      const staggeredCall = (async () => {
        if (idx > 0) await new Promise(r => setTimeout(r, idx * STAGGER_DELAY_MS));

        // Per-call budget check: skip if we've already exceeded the extraction budget.
        // This prevents a batch of 8 calls from all firing when only 20s remain.
        // In solo mode, skip this check — solo chunks get their own fresh clock.
        if (!isSolo) {
          const elapsedBeforeCall = Date.now() - startTime;
          if (elapsedBeforeCall >= EXTRACTION_TIME_BUDGET_MS) {
            budgetExhausted = true;
            return { success: false, error: "budget_skip" };
          }
        }

        try {
          // Solo chunks get a fresh startTime so their internal timeout measures
          // from call start. Budget is clamped to platform headroom via soloBudgetOverride.
          const chunkStart = isSolo ? Date.now() : startTime;
          const { text: rawText, truncated } = await callExtractionLLM(ctx, chunk, totalChunks, chunkStart, 3, isSolo, soloBudgetOverride);

          // If truncated, mark it so future runs will retry this chunk
          if (truncated) {
            const tag = tagByDocId[chunk.documentId] ?? "other";
            const truncatedJson = {
              label: sanitizeBraces(chunk.label),
              extraction: "",
              chunkIndex: chunk.chunkIndex,
              sourceFile: sanitizeBraces(chunk.sourceFile),
              documentTag: tag,
              truncated: true,
            };
            await ctx.integrations.db.execute(
              `INSERT INTO universal_extractions (deal_id, document_id, chunk_index, content_hash, extraction_json)
               VALUES ($1, $2, $3, $4, $5::jsonb)
               ON CONFLICT (deal_id, document_id, chunk_index)
               DO UPDATE SET content_hash = EXCLUDED.content_hash,
                             extraction_json = EXCLUDED.extraction_json,
                             created_at = now()`,
              [dealId, chunk.documentId, chunk.chunkIndex, chunk.contentHash, JSON.stringify(truncatedJson)],
              { label: `Save truncated extraction ${chunk.chunkIndex}` }
            );
            // Count as processed (not successful) — won't be retried this invocation
            return { success: false, error: `Truncated (max_tokens): ${chunk.label}` };
          }

          const idTaggedText = injectClaimIds(rawText, chunk.chunkIndex);
          const tag = tagByDocId[chunk.documentId] ?? "other";

          const extractionJson = {
            label: sanitizeBraces(chunk.label),
            extraction: `### Universal Extraction from: ${sanitizeBraces(chunk.label)}\n\n${sanitizeBraces(idTaggedText)}`,
            chunkIndex: chunk.chunkIndex,
            sourceFile: sanitizeBraces(chunk.sourceFile),
            documentTag: tag,
          };

          // Save immediately to DB (checkpoint)
          await ctx.integrations.db.execute(
            `INSERT INTO universal_extractions (deal_id, document_id, chunk_index, content_hash, extraction_json)
             VALUES ($1, $2, $3, $4, $5::jsonb)
             ON CONFLICT (deal_id, document_id, chunk_index)
             DO UPDATE SET content_hash = EXCLUDED.content_hash,
                           extraction_json = EXCLUDED.extraction_json,
                           created_at = now()`,
            [dealId, chunk.documentId, chunk.chunkIndex, chunk.contentHash, JSON.stringify(extractionJson)],
            { label: `Save extraction ${chunk.chunkIndex}` }
          );
          return { success: true, error: null };
        } catch (err) {
          // Save failed extraction so it can be retried on next invocation
          const errMsg = err instanceof Error ? err.message : String(err);
          const tag = tagByDocId[chunk.documentId] ?? "other";
          const prevAttempts = failedChunkAttempts.get(`${chunk.documentId}:${chunk.chunkIndex}`) ?? 0;
          const newAttemptCount = prevAttempts + 1;
          const failedJson = {
            label: sanitizeBraces(chunk.label),
            extraction: "",
            chunkIndex: chunk.chunkIndex,
            sourceFile: sanitizeBraces(chunk.sourceFile),
            documentTag: tag,
            failed: true,
            attempt_count: newAttemptCount,
            error_msg: errMsg.slice(0, 1000),
          };
          try {
            await ctx.integrations.db.execute(
              `INSERT INTO universal_extractions (deal_id, document_id, chunk_index, content_hash, extraction_json)
               VALUES ($1, $2, $3, $4, $5::jsonb)
               ON CONFLICT (deal_id, document_id, chunk_index)
               DO UPDATE SET content_hash = EXCLUDED.content_hash,
                             extraction_json = EXCLUDED.extraction_json,
                             created_at = now()`,
              [dealId, chunk.documentId, chunk.chunkIndex, chunk.contentHash, JSON.stringify(failedJson)],
              { label: `Save failed extraction ${chunk.chunkIndex}` }
            );
          } catch { /* best effort */ }
          return { success: false, error: errMsg };
        }
      })();
      promises.push(staggeredCall);
    }

    const results = await Promise.allSettled(promises);

    for (const r of results) {
      if (r.status === "fulfilled") {
        attemptedThisPass++;
        if (r.value.success) {
          extractedSoFar++;
          succeededThisPass++;
        } else if (r.value.error === "budget_skip") {
          // Not a failure — just skipped due to time budget. Don't count it.
          attemptedThisPass--; // Was never actually attempted
        } else {
          failedChunks++;
          failedThisPass++;
          if (!firstError && r.value.error) firstError = r.value.error;
        }
      } else {
        // Promise itself rejected (shouldn't happen with inner try/catch, but guard)
        attemptedThisPass++;
        failedChunks++;
        failedThisPass++;
        if (!firstError) firstError = r.reason instanceof Error ? r.reason.message : String(r.reason);
      }
    }
  };

  // Process in batches of EXTRACTION_CONCURRENCY, capped at MAX_GAPS_PER_INVOCATION.
  // When many gaps exist, processing a limited subset per invocation prevents
  // rate-limit storms. The pipeline will be re-invoked and pick up remaining gaps.
  const chunksToProcess = allChunks.length > MAX_GAPS_PER_INVOCATION
    ? allChunks.slice(0, MAX_GAPS_PER_INVOCATION)
    : allChunks;
  const isThrottled = allChunks.length > MAX_GAPS_PER_INVOCATION;

  const makePassStats = (): ExtractionPassStats => ({
    attemptedThisPass,
    succeededThisPass,
    failedThisPass,
    skippedDueToBudget: chunksToProcess.length - attemptedThisPass,
  });

  // When only a few chunks remain, run them one-at-a-time (solo) so each
  // call gets the full budget (~140s) instead of sharing it across 8 concurrent
  // calls that all race the same 150s clock.
  const effectiveConcurrency = chunksToProcess.length <= SMALL_TAIL_THRESHOLD
    ? 1
    : EXTRACTION_CONCURRENCY;
  const isSolo = effectiveConcurrency === 1;

  for (let i = 0; i < chunksToProcess.length; i += effectiveConcurrency) {
    // Time budget check — before starting batch
    const elapsed = Date.now() - startTime;
    if (elapsed >= EXTRACTION_TIME_BUDGET_MS) {
      return { needed: true, completed: false, extractedSoFar, totalChunks, failedChunks, firstError, passStats: makePassStats() };
    }

    // Batch-aware graceful exit: never launch if the real platform clock can't
    // accommodate worst-case batch (1× extraction timeout + checkpoint reserve).
    // FE4's HeadroomExhaustedError gates retries dynamically — no need to pre-provision 2×.
    const EXTRACTION_CALL_TIMEOUT = 130_000;
    const extractionBatchWorstCase = EXTRACTION_CALL_TIMEOUT + CHECKPOINT_RESERVE_MS;
    const platformDeadlineExtraction = EFFECTIVE_CAP_MS - elapsed;
    if (platformDeadlineExtraction < extractionBatchWorstCase) {
      console.log(`[pipeline:graceful-exit] Extraction phase — platformDeadline=${Math.round(platformDeadlineExtraction / 1000)}s < batchWorstCase=${Math.round(extractionBatchWorstCase / 1000)}s — returning partial`);
      return { needed: true, completed: false, extractedSoFar, totalChunks, failedChunks, firstError, passStats: makePassStats() };
    }

    // Inter-batch cooldown when throttled (skip before first batch)
    if (isThrottled && i > 0) {
      await new Promise(r => setTimeout(r, INTER_BATCH_COOLDOWN_MS));
    }

    // Heartbeat: update triggered_at so the stale-pipeline sweeper doesn't
    // claim this run while extraction is still actively processing.
    if (runId) {
      await ctx.integrations.db.execute(
        `UPDATE module_runs SET triggered_at = NOW() WHERE id = $1`,
        [runId],
        { label: "Extraction heartbeat" }
      );
    }

    const batch = chunksToProcess.slice(i, i + effectiveConcurrency);

    if (isSolo) {
      // Solo: each chunk gets an escalation-level budget, but CLAMPED to remaining
      // platform headroom. This prevents the boundary case where pipeline starts at
      // t=149.9s and a 150s budget would breach the 300s platform cap with zero margin.
      const pipelineElapsed = Date.now() - startTime;
      const remainingHeadroom = EFFECTIVE_CAP_MS - pipelineElapsed - PLATFORM_HEADROOM_MS;

      if (remainingHeadroom < MIN_ESCALATION_BUDGET_MS) {
        // Not enough headroom for a meaningful solo attempt — bail.
        return { needed: true, completed: false, extractedSoFar, totalChunks, failedChunks, firstError, passStats: makePassStats() };
      }

      // Clamp the solo budget to remaining headroom
      soloBudgetOverride = Math.min(ESCALATION_BUDGETS[0], remainingHeadroom);
      await processBatch(batch);
    } else {
      // Concurrent: race the batch against remaining pipeline budget. Ensures we
      // abandon the batch once time budget is exhausted rather than waiting for
      // the slowest in-flight call.
      const remainingMs = EXTRACTION_TIME_BUDGET_MS - (Date.now() - startTime);
      const deadlineTimer = new Promise<"DEADLINE">((resolve) =>
        setTimeout(() => resolve("DEADLINE"), remainingMs)
      );

      const raceResult = await Promise.race([
        processBatch(batch).then(() => "BATCH_DONE" as const),
        deadlineTimer,
      ]);

      if (raceResult === "DEADLINE") {
        budgetExhausted = true;
      }
    }

    // Post-batch check: if any call inside the batch detected budget exhaustion
    // OR the deadline timer fired, return partial immediately.
    if (budgetExhausted) {
      return { needed: true, completed: false, extractedSoFar, totalChunks, failedChunks, firstError, passStats: makePassStats() };
    }
  }

  // If we capped the chunks (more gaps exist than we attempted), always return incomplete
  if (allChunks.length > chunksToProcess.length) {
    return { needed: true, completed: false, extractedSoFar, totalChunks, failedChunks, firstError, passStats: makePassStats() };
  }

  // --- Step E: Escalation retries for previously-failed chunks ---
  // Runs only when no first-attempt chunks remain (all have had a first pass).
  // Processes retries one-at-a-time with graduated budgets, CLAMPED to platform
  // headroom so a single escalation can never blow the platform's hard-kill cap.
  //
  // Key invariant: if remaining headroom < MIN_ESCALATION_BUDGET_MS, the retry is
  // DEFERRED to the next invocation WITHOUT incrementing attempt_count. This
  // prevents doomed short-budget attempts from exhausting the chunk's retry limit.
  const firstPassChunks = chunksToProcess.filter(c =>
    (failedChunkAttempts.get(`${c.documentId}:${c.chunkIndex}`) ?? 0) === 0
  );
  const retryChunks = chunksToProcess.filter(c => {
    const attempts = failedChunkAttempts.get(`${c.documentId}:${c.chunkIndex}`) ?? 0;
    return attempts >= 1 && attempts < MAX_EXTRACTION_ATTEMPTS;
  });

  let escalationSucceeded = 0;
  let escalationFailed = 0;

  if (firstPassChunks.length === 0 && retryChunks.length > 0) {
    for (const chunk of retryChunks) {
      const attempts = failedChunkAttempts.get(`${chunk.documentId}:${chunk.chunkIndex}`) ?? 1;
      const desiredBudget = ESCALATION_BUDGETS[Math.min(attempts, MAX_EXTRACTION_ATTEMPTS - 1)];

      // --- Headroom check: can we fit a meaningful retry before the platform kills us? ---
      const pipelineElapsed = Date.now() - startTime;
      const remainingHeadroom = EFFECTIVE_CAP_MS - pipelineElapsed - PLATFORM_HEADROOM_MS;

      if (remainingHeadroom < MIN_ESCALATION_BUDGET_MS) {
        // Not enough headroom for a real attempt — defer to next invocation.
        // Do NOT increment attempt_count; the chunk stays in its current state.
        console.log(
          `[extraction:escalation] Deferring chunk ${chunk.chunkIndex} (${chunk.label}) — ` +
          `headroom=${Math.round(remainingHeadroom / 1000)}s < min=${Math.round(MIN_ESCALATION_BUDGET_MS / 1000)}s, ` +
          `pipelineElapsed=${Math.round(pipelineElapsed / 1000)}s, platformCap=${Math.round(EFFECTIVE_CAP_MS / 1000)}s`
        );
        break;
      }

      // Clamp the budget to remaining headroom — never exceed what we can safely fit
      const clampedBudget = Math.min(desiredBudget, remainingHeadroom);
      if (clampedBudget < desiredBudget) {
        console.log(
          `[extraction:escalation] Clamping budget for chunk ${chunk.chunkIndex}: ` +
          `desired=${Math.round(desiredBudget / 1000)}s → clamped=${Math.round(clampedBudget / 1000)}s ` +
          `(headroom=${Math.round(remainingHeadroom / 1000)}s)`
        );
      }

      const chunkStart = Date.now();
      const tag = tagByDocId[chunk.documentId] ?? "other";

      try {
        const { text: rawText, truncated } = await callExtractionLLM(
          ctx, chunk, totalChunks, chunkStart, 3, true, clampedBudget
        );

        if (truncated) {
          // Save as truncated — will be retried at next level
          const truncatedJson = {
            label: sanitizeBraces(chunk.label),
            extraction: "",
            chunkIndex: chunk.chunkIndex,
            sourceFile: sanitizeBraces(chunk.sourceFile),
            documentTag: tag,
            truncated: true,
            attempt_count: attempts + 1,
          };
          await ctx.integrations.db.execute(
            `INSERT INTO universal_extractions (deal_id, document_id, chunk_index, content_hash, extraction_json)
             VALUES ($1, $2, $3, $4, $5::jsonb)
             ON CONFLICT (deal_id, document_id, chunk_index)
             DO UPDATE SET content_hash = EXCLUDED.content_hash,
                           extraction_json = EXCLUDED.extraction_json,
                           created_at = now()`,
            [dealId, chunk.documentId, chunk.chunkIndex, chunk.contentHash, JSON.stringify(truncatedJson)],
            { label: `Save truncated escalation ${chunk.chunkIndex}` }
          );
          escalationFailed++;
        } else {
          // Success — save the extraction
          const idTaggedText = injectClaimIds(rawText, chunk.chunkIndex);
          const extractionJson = {
            label: sanitizeBraces(chunk.label),
            extraction: `### Universal Extraction from: ${sanitizeBraces(chunk.label)}\n\n${sanitizeBraces(idTaggedText)}`,
            chunkIndex: chunk.chunkIndex,
            sourceFile: sanitizeBraces(chunk.sourceFile),
            documentTag: tag,
          };
          await ctx.integrations.db.execute(
            `INSERT INTO universal_extractions (deal_id, document_id, chunk_index, content_hash, extraction_json)
             VALUES ($1, $2, $3, $4, $5::jsonb)
             ON CONFLICT (deal_id, document_id, chunk_index)
             DO UPDATE SET content_hash = EXCLUDED.content_hash,
                           extraction_json = EXCLUDED.extraction_json,
                           created_at = now()`,
            [dealId, chunk.documentId, chunk.chunkIndex, chunk.contentHash, JSON.stringify(extractionJson)],
            { label: `Save escalation success ${chunk.chunkIndex}` }
          );
          extractedSoFar++;
          escalationSucceeded++;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isTimeout = /timed out|timeout|ETIMEDOUT/i.test(errMsg);

        // --- Item 3a fix: if budget was clamped AND the failure is a timeout,
        // this was a doomed stunted attempt. Do NOT increment attempt_count —
        // defer to next invocation exactly like the <60s headroom path.
        // Only full-budget failures (or non-timeout errors at any budget) count.
        if (clampedBudget < desiredBudget && isTimeout) {
          console.log(
            `[extraction:escalation] Timeout on clamped attempt for chunk ${chunk.chunkIndex} — ` +
            `NOT incrementing attempt_count (was ${attempts}, budget was clamped ` +
            `${Math.round(desiredBudget / 1000)}s → ${Math.round(clampedBudget / 1000)}s). ` +
            `Deferring to next invocation.`
          );
          // Don't save a new failed row — leave existing state untouched so
          // the chunk retries at full budget on next invocation.
          break;
        }

        const newAttemptCount = attempts + 1;
        const isFinal = newAttemptCount >= MAX_EXTRACTION_ATTEMPTS;
        const failedJson = {
          label: sanitizeBraces(chunk.label),
          extraction: "",
          chunkIndex: chunk.chunkIndex,
          sourceFile: sanitizeBraces(chunk.sourceFile),
          documentTag: tag,
          failed: true,
          permanently_failed: isFinal,
          attempt_count: newAttemptCount,
          char_count: chunk.text.length,
          estimated_tokens: Math.ceil(chunk.text.length / 4),
          error_msg: errMsg.slice(0, 1000),
        };
        try {
          await ctx.integrations.db.execute(
            `INSERT INTO universal_extractions (deal_id, document_id, chunk_index, content_hash, extraction_json)
             VALUES ($1, $2, $3, $4, $5::jsonb)
             ON CONFLICT (deal_id, document_id, chunk_index)
             DO UPDATE SET content_hash = EXCLUDED.content_hash,
                           extraction_json = EXCLUDED.extraction_json,
                           created_at = now()`,
            [dealId, chunk.documentId, chunk.chunkIndex, chunk.contentHash, JSON.stringify(failedJson)],
            { label: `Save ${isFinal ? "permanently" : "escalation"} failed ${chunk.chunkIndex}` }
          );
        } catch { /* best effort */ }
        escalationFailed++;
        if (!firstError) firstError = errMsg;
      }

      // Only attempt 1 escalation per invocation — preserves the single-retry-per-call
      // policy. The headroom clamp above guarantees this one retry fits safely.
      break;
    }
  }

  // Count definitively exhausted chunks (all 3 attempts used) — separate from
  // in-progress retries. Only exhausted chunks count toward the <5 skip policy.
  const permanentlyExhausted = existingRows.filter(
    r => r.is_failed && r.attempt_count >= MAX_EXTRACTION_ATTEMPTS
  ).length;

  // Adjust failedChunks: only count chunks whose retries are fully exhausted.
  // In-progress retries (attempt_count < MAX) will be retried on next invocation.
  const exhaustedFailures = permanentlyExhausted + escalationFailed;
  const retriesStillPending = retryChunks.length - (escalationSucceeded + escalationFailed);

  // If retries are still pending (not all escalation attempts exhausted), return incomplete
  // so the pipeline re-invokes to continue escalation.
  if (retriesStillPending > 0) {
    return { needed: true, completed: false, extractedSoFar, totalChunks, failedChunks: exhaustedFailures, firstError, passStats: makePassStats() };
  }

  // All chunks have been attempted through their full escalation path.
  // The <5 policy: if fewer than 5 are permanently failed, proceed anyway.
  // This governs pipeline progression; escalation governs exhaustion.
  if (exhaustedFailures >= 5) {
    return { needed: true, completed: false, extractedSoFar, totalChunks, failedChunks: exhaustedFailures, firstError, passStats: makePassStats() };
  }

  return { needed: true, completed: true, totalChunks };
}
