/**
 * Extraction Phase — ensures universal_extractions exist for a deal.
 *
 * If the deal already has extractions in the DB, this is a no-op.
 * If not, it loads documents, chunks them, runs the LLM extraction prompt
 * on each chunk (with concurrency + time budget), and saves results
 * incrementally to `universal_extractions`.
 *
 * Returns:
 *  - { needed: false } if extractions already exist
 *  - { needed: true, completed: true, totalChunks } if all chunks extracted in this call
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
  type TextChunk,
} from "./extraction-prompt.js";
import type { PipelineContext } from "./pipeline-core.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const EXTRACTION_MODEL = "claude-sonnet-4-6";
const EXTRACTION_MAX_TOKENS = 8000;
const EXTRACTION_CONCURRENCY = 12;

/** How much time budget the extraction phase is allowed to consume (ms) */
const EXTRACTION_TIME_BUDGET_MS = 180_000; // 3 minutes

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
  | { needed: true; completed: false; extractedSoFar: number; totalChunks: number };

// ---------------------------------------------------------------------------
// LLM call with retry
// ---------------------------------------------------------------------------
async function callExtractionLLM(
  ctx: PipelineContext,
  chunk: TextChunk,
  totalChunks: number,
  retries = 3
): Promise<string> {
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
      return textBlock.text.trim();
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

  // --- Step B: Compute expected total chunks and compare to existing ---
  const expectedTotal = docMetas.reduce(
    (sum, d) => sum + Math.ceil(d.text_length / CHUNK_CHARS),
    0
  );

  // Load existing extraction keys (document_id + chunk_index) to identify gaps
  const existingRows = await ctx.integrations.db.query(
    `SELECT document_id, chunk_index,
            COALESCE((extraction_json->>'failed')::boolean, false) AS is_failed
     FROM universal_extractions
     WHERE deal_id = $1`,
    ExistingChunkSchema,
    [dealId],
    { label: "Load existing extraction keys" }
  );

  // Build a set of successfully-extracted (doc_id, chunk_index) pairs
  const extractedSet = new Set<string>();
  for (const row of existingRows) {
    if (!row.is_failed) {
      extractedSet.add(`${row.document_id}:${row.chunk_index}`);
    }
  }

  // Count successful extractions
  const successfulCount = extractedSet.size;
  if (successfulCount >= expectedTotal) {
    // All chunks already extracted — skip
    return { needed: false };
  }

  // --- Step C: Load text & chunk only for documents with missing extractions ---
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
      let pos = 1;
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

  const totalChunks = allChunks.length + successfulCount; // total = pending + already done
  if (allChunks.length === 0) {
    // Edge case: all chunks accounted for (rounding matched)
    return { needed: false };
  }

  // --- Step D: Process missing chunks in batches with concurrency ---
  let extractedSoFar = successfulCount;

  const processBatch = async (batch: TextChunk[]): Promise<boolean> => {
    const results = await Promise.allSettled(
      batch.map(async (chunk) => {
        try {
          const rawText = await callExtractionLLM(ctx, chunk, totalChunks);
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
          return true;
        } catch (err) {
          // Save failed extraction so it can be retried on next invocation
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
          return false;
        }
      })
    );

    extractedSoFar += results.filter(r => r.status === "fulfilled").length;
    return true;
  };

  // Process in batches of EXTRACTION_CONCURRENCY
  for (let i = 0; i < allChunks.length; i += EXTRACTION_CONCURRENCY) {
    // Time budget check
    const elapsed = Date.now() - startTime;
    if (elapsed >= EXTRACTION_TIME_BUDGET_MS) {
      return { needed: true, completed: false, extractedSoFar, totalChunks };
    }

    const batch = allChunks.slice(i, i + EXTRACTION_CONCURRENCY);
    await processBatch(batch);
  }

  return { needed: true, completed: true, totalChunks };
}
