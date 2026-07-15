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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const EXTRACTION_MAX_TOKENS = 8000;

/** How much time budget the extraction phase is allowed to consume (ms) */
const EXTRACTION_TIME_BUDGET_MS = 150_000; // 2.5 minutes — leaves headroom for Steps 0.4/0.6/0.7 + platform 300s limit

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
export type ExtractionPhaseResult =
  | { needed: false }
  | { needed: true; completed: true; totalChunks: number }
  | { needed: true; completed: false; extractedSoFar: number; totalChunks: number; failedChunks: number; firstError: string | null };

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
  retries = 3
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

  for (let attempt = 1; attempt <= retries; attempt++) {
    // Budget check before each attempt (not just the first).
    // A single call can take up to 120s; if less than that remains, bail early.
    const remaining = EXTRACTION_TIME_BUDGET_MS - (Date.now() - startTime);
    if (remaining < 30_000) {
      throw new Error(`Budget exhausted mid-retry (attempt ${attempt}/${retries}, ${Math.round(remaining / 1000)}s left): ${label}`);
    }

    try {
      const result = await Promise.race([
        ctx.integrations.ai.apiRequest(
          { method: "POST", path: "/v1/messages", body },
          { response: MessageResponseSchema },
          { label }
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Extraction LLM timed out: ${label}`)), 120_000)
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
      const isRetryable = /503|429|rate.?limit|service.?unavailable|overloaded|timed out/i.test(msg);
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
  startTime: number
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
  const existingRows: Array<{ document_id: string; chunk_index: number; is_failed: boolean; is_truncated: boolean }> = [];
  let keysOffset = 0;

  while (true) {
    const page = await ctx.integrations.db.query(
      `SELECT document_id, chunk_index,
              COALESCE((extraction_json->>'failed')::boolean, false) AS is_failed,
              COALESCE((extraction_json->>'truncated')::boolean, false) AS is_truncated
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
  for (const row of existingRows) {
    if (!row.is_failed && !row.is_truncated) {
      extractedSet.add(`${row.document_id}:${row.chunk_index}`);
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
    for (const chunk of chunks) {
      if (!extractedSet.has(`${doc.id}:${chunk.chunkIndex}`)) {
        allChunks.push(chunk);
      }
    }
  }

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

  const processBatch = async (batch: TextChunk[]): Promise<void> => {
    const results = await Promise.allSettled(
      batch.map(async (chunk) => {
        // Per-call budget check: skip if we've already exceeded the extraction budget.
        // This prevents a batch of 12 calls from all firing when only 20s remain.
        const elapsedBeforeCall = Date.now() - startTime;
        if (elapsedBeforeCall >= EXTRACTION_TIME_BUDGET_MS) {
          budgetExhausted = true;
          return { success: false, error: "budget_skip" };
        }

        try {
          const { text: rawText, truncated } = await callExtractionLLM(ctx, chunk, totalChunks, startTime);

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
          const failedJson = {
            label: sanitizeBraces(chunk.label),
            extraction: "",
            chunkIndex: chunk.chunkIndex,
            sourceFile: sanitizeBraces(chunk.sourceFile),
            documentTag: tag,
            failed: true,
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
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value.success) {
          extractedSoFar++;
        } else if (r.value.error === "budget_skip") {
          // Not a failure — just skipped due to time budget. Don't count it.
        } else {
          failedChunks++;
          if (!firstError && r.value.error) firstError = r.value.error;
        }
      } else {
        // Promise itself rejected (shouldn't happen with inner try/catch, but guard)
        failedChunks++;
        if (!firstError) firstError = r.reason instanceof Error ? r.reason.message : String(r.reason);
      }
    }
  };

  // Process in batches of EXTRACTION_CONCURRENCY
  for (let i = 0; i < allChunks.length; i += EXTRACTION_CONCURRENCY) {
    // Time budget check — before starting batch
    const elapsed = Date.now() - startTime;
    if (elapsed >= EXTRACTION_TIME_BUDGET_MS) {
      return { needed: true, completed: false, extractedSoFar, totalChunks, failedChunks, firstError };
    }

    const batch = allChunks.slice(i, i + EXTRACTION_CONCURRENCY);
    await processBatch(batch);

    // Post-batch check: if any call inside the batch detected budget exhaustion,
    // return partial immediately rather than starting another batch.
    if (budgetExhausted) {
      return { needed: true, completed: false, extractedSoFar, totalChunks, failedChunks, firstError };
    }
  }

  return { needed: true, completed: true, totalChunks };
}
