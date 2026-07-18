/**
 * Absence Verification Phase (Step 2)
 *
 * For each finding that has an absence_confidence field set, runs a two-call
 * adversarial verification:
 *   Call A: Generate alternate search queries (different terminology than the finding)
 *   Call B: Retrieve evidence and issue verdict (REVISED or UPHELD)
 *
 * Checkpoints each verdict to absence_verification_checkpoints so resumed
 * invocations skip already-verified findings.
 *
 * Only applies to omission_audit, blind_spot_scanner, diligence_completeness.
 */
import { z } from "@superblocksteam/sdk-api";
import { getModuleModel } from "./model-config.js";
import type { MergedFinding } from "../modules/build-merged-text.js";
import type { PipelineContext } from "./pipeline-core.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationVerdict {
  verdict: "REVISED" | "UPHELD";
  revisedDetail?: string;
  evidenceQuoted?: string;
  evidenceSource?: string;
  reasoning: string;
  queriesRun: string[];
}

export interface VerificationLogEntry {
  findingIndex: number;
  title: string;
  originalAbsenceConfidence: string;
  verdict: VerificationVerdict;
  model: string;
}

export interface AbsenceVerificationResult {
  findings: MergedFinding[];
  verificationLog: VerificationLogEntry[];
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  model: z.string(),
  stop_reason: z.string().nullable(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

const ChunkHitSchema = z.object({
  file_name: z.string(),
  chunk_index: z.coerce.number(),
  content: z.string(),
  rank: z.coerce.number(),
});

const ExistingCheckpointSchema = z.object({
  finding_index: z.coerce.number(),
  verdict_json: z.any(),
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Max hits per query for retrieval */
const HITS_PER_QUERY = 3;

/** Max content chars per hit — enough to quote but not overwhelm the verdict call */
const CONTENT_CAP_PER_HIT = 1500;

/** Per-call timeout for LLM calls in this phase */
const PER_CALL_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Prompts (exact spec text — do not modify)
// ---------------------------------------------------------------------------

const CALL_A_SYSTEM = `You are reviewing a single finding from a private equity investment committee diligence report. This finding claims that specific information is absent from the deal's data room. Your job is NOT to agree or disagree — only to generate search queries that would surface the information IF it exists, using terminology a source document might use, which may differ from how the finding describes it.`;

function buildCallAUser(finding: MergedFinding): string {
  return `Finding:
Title: ${finding.title}
Detail: ${finding.detail}
Full Analysis: ${finding.full_analysis}

Generate 3 search queries suitable for full-text search (websearch_to_tsquery syntax — use OR between alternative terms, quote exact phrases). Each query must use DIFFERENT terminology than the finding's own wording — think about how the underlying business or deal team might actually label this concept in a slide, table, or memo (industry jargon, abbreviations, or alternate framings), not just a rephrasing of the finding's language.

Output ONLY valid JSON:
{
  "concept": "one-sentence description of what we're checking for",
  "queries": ["query1", "query2", "query3"]
}`;
}

const CALL_B_SYSTEM = `You are adversarially fact-checking a single finding from a private equity diligence report. The finding claims something is absent from the data room. You have been given ACTUAL search results retrieved from the deal's documents using queries designed to find contradicting evidence.`;

function buildCallBUser(
  finding: MergedFinding,
  absenceConfidence: string,
  queries: string[],
  retrievedEvidence: string
): string {
  return `Original Finding:
Title: ${finding.title}
Detail: ${finding.detail}
Full Analysis: ${finding.full_analysis}
Original absence_confidence: ${absenceConfidence}

Search Queries Run: ${JSON.stringify(queries)}

Retrieved Evidence:
${retrievedEvidence}

Does the retrieved evidence contradict, partially contradict, or fail to contradict the finding's claim of absence?

- If the evidence directly shows the claimed-absent information exists (a specific figure, table, methodology, or disclosure the finding says is missing): verdict = REVISED. Quote the exact contradicting text and name its source.
- If the evidence only partially addresses the claim (confirms a broader category exists but not the specific granularity claimed missing): verdict = REVISED, with the finding narrowed to the real remaining gap — do not delete a valid narrower concern just because a broader one didn't hold up.
- If the evidence is unrelated or tangential: verdict = UPHELD. Do not stretch to manufacture a connection.

Output ONLY valid JSON:
{
  "verdict": "REVISED" | "UPHELD",
  "revisedDetail": "..." (required if REVISED — the corrected finding text),
  "evidenceQuoted": "..." (required if REVISED — max 40 words, verbatim),
  "evidenceSource": "..." (required if REVISED — document name),
  "reasoning": "..." (1-2 sentences, required either way)
}`;
}

// ---------------------------------------------------------------------------
// Helper: call Anthropic with retry
// ---------------------------------------------------------------------------

async function callAnthropic(
  ctx: PipelineContext,
  body: Record<string, unknown>,
  label: string,
  retries = 3,
  perCallTimeoutMs = PER_CALL_TIMEOUT_MS
): Promise<z.infer<typeof MessageResponseSchema>> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await Promise.race([
        ctx.integrations.ai.apiRequest(
          { method: "POST", path: "/v1/messages", body },
          { response: MessageResponseSchema },
          { label }
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Anthropic call timed out after ${perCallTimeoutMs / 1000}s: ${label}`)), perCallTimeoutMs)
        ),
      ]);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = /503|429|rate.?limit|service.?unavailable|overloaded|timed out/i.test(msg);
      if (!isRetryable || attempt === retries) throw err;
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 15000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("Unreachable");
}

// ---------------------------------------------------------------------------
// Helper: retrieve chunks via FTS
// ---------------------------------------------------------------------------

async function retrieveChunks(
  ctx: PipelineContext,
  dealId: string,
  queries: string[]
): Promise<{ fileName: string; chunkIndex: number; content: string }[]> {
  const allHits: { fileName: string; chunkIndex: number; content: string; rank: number }[] = [];

  for (const query of queries) {
    try {
      const rows = await ctx.integrations.db.query(
        `SELECT
           file_name,
           chunk_index,
           content,
           ts_rank_cd(tsv, q) AS rank
         FROM document_chunks,
              websearch_to_tsquery('english', $2) q
         WHERE deal_id = $1
           AND tsv @@ q
         ORDER BY rank DESC
         LIMIT $3`,
        ChunkHitSchema,
        [dealId, query, HITS_PER_QUERY],
        { label: `Absence verify retrieve: "${query.slice(0, 60)}"` }
      );

      for (const row of rows) {
        allHits.push({
          fileName: row.file_name,
          chunkIndex: row.chunk_index,
          content: row.content.slice(0, CONTENT_CAP_PER_HIT),
          rank: row.rank,
        });
      }
    } catch (err) {
      console.warn(`[absence-verify] Query failed: "${query}"`, err);
    }
  }

  // Deduplicate by (fileName, chunkIndex) — keep highest rank instance
  const seen = new Map<string, typeof allHits[0]>();
  for (const hit of allHits) {
    const key = `${hit.fileName}:${hit.chunkIndex}`;
    const existing = seen.get(key);
    if (!existing || hit.rank > existing.rank) {
      seen.set(key, hit);
    }
  }

  // Sort by rank descending
  return [...seen.values()].sort((a, b) => b.rank - a.rank);
}

// ---------------------------------------------------------------------------
// Helper: format retrieved evidence for prompt
// ---------------------------------------------------------------------------

function formatRetrievedEvidence(
  hits: { fileName: string; chunkIndex: number; content: string }[]
): string {
  if (hits.length === 0) {
    return "No matching content was found across any of the queries above.";
  }

  return hits
    .map(hit => `[Document: ${hit.fileName}, chunk ${hit.chunkIndex}]\n${hit.content}`)
    .join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Runs the absence verification phase on findings that have absence_confidence set.
 * Checkpoints each verdict so resumed invocations skip completed verifications.
 */
export async function runAbsenceVerificationPhase(
  ctx: PipelineContext,
  dealId: string,
  runId: string,
  findings: MergedFinding[],
  moduleId: string,
  useOpus: boolean | null | undefined
): Promise<AbsenceVerificationResult> {
  const model = getModuleModel(moduleId, useOpus);
  const verificationLog: VerificationLogEntry[] = [];

  // Load existing checkpoints (for resume)
  const existingCheckpoints = await ctx.integrations.db.query(
    `SELECT finding_index, verdict_json
     FROM absence_verification_checkpoints
     WHERE module_run_id = $1
     ORDER BY finding_index`,
    ExistingCheckpointSchema,
    [runId],
    { label: "Load absence verification checkpoints" }
  );

  const completedIndices = new Map<number, VerificationVerdict>();
  for (const cp of existingCheckpoints) {
    completedIndices.set(cp.finding_index, cp.verdict_json as VerificationVerdict);
  }

  // Identify findings that need verification (have absence_confidence set)
  const findingsToVerify: { index: number; finding: MergedFinding; absenceConfidence: string }[] = [];
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    if (f.absence_confidence) {
      findingsToVerify.push({ index: i, finding: f, absenceConfidence: f.absence_confidence });
    }
  }

  console.log(`[absence-verify] ${findingsToVerify.length} findings with absence_confidence, ${completedIndices.size} already checkpointed`);

  // Process each finding sequentially (checkpoint after each)
  for (const { index, finding, absenceConfidence } of findingsToVerify) {
    // Skip if already checkpointed
    if (completedIndices.has(index)) {
      const existing = completedIndices.get(index)!;
      verificationLog.push({
        findingIndex: index,
        title: finding.title,
        originalAbsenceConfidence: absenceConfidence,
        verdict: existing,
        model,
      });
      continue;
    }

    try {
      // --- Call A: Query Generation ---
      const callAResult = await callAnthropic(
        ctx,
        {
          model,
          max_tokens: 1024,
          system: [{ type: "text", text: CALL_A_SYSTEM }],
          messages: [{ role: "user", content: buildCallAUser(finding) }],
        },
        `Absence verify CallA: "${finding.title.slice(0, 50)}"`
      );

      const callAText = callAResult.content.find((c: { type: string }) => c.type === "text");
      if (!callAText || callAText.type !== "text") {
        throw new Error("Call A returned no text content");
      }

      // Parse Call A output
      let callAOutput: { concept: string; queries: string[] };
      try {
        // Extract JSON from response (handle potential markdown fencing)
        let jsonStr = callAText.text.trim();
        const jsonMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (jsonMatch) jsonStr = jsonMatch[1].trim();
        callAOutput = JSON.parse(jsonStr);
        if (!callAOutput.queries || !Array.isArray(callAOutput.queries) || callAOutput.queries.length === 0) {
          throw new Error("Call A output missing or empty queries array");
        }
      } catch (parseErr) {
        throw new Error(`Call A JSON parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}\nRaw: ${callAText.text.slice(0, 500)}`);
      }

      // --- Retrieval: run queries against document_chunks ---
      const hits = await retrieveChunks(ctx, dealId, callAOutput.queries);
      const evidenceText = formatRetrievedEvidence(hits);

      console.log(`[absence-verify] "${finding.title.slice(0, 40)}": ${callAOutput.queries.length} queries → ${hits.length} unique hits`);

      // --- Call B: Verdict ---
      const callBResult = await callAnthropic(
        ctx,
        {
          model,
          max_tokens: 2048,
          system: [{ type: "text", text: CALL_B_SYSTEM }],
          messages: [{ role: "user", content: buildCallBUser(finding, absenceConfidence, callAOutput.queries, evidenceText) }],
        },
        `Absence verify CallB: "${finding.title.slice(0, 50)}"`
      );

      const callBText = callBResult.content.find((c: { type: string }) => c.type === "text");
      if (!callBText || callBText.type !== "text") {
        throw new Error("Call B returned no text content");
      }

      // Parse Call B output
      let verdictOutput: {
        verdict: "REVISED" | "UPHELD";
        revisedDetail?: string;
        evidenceQuoted?: string;
        evidenceSource?: string;
        reasoning: string;
      };
      try {
        let jsonStr = callBText.text.trim();
        const jsonMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (jsonMatch) jsonStr = jsonMatch[1].trim();
        verdictOutput = JSON.parse(jsonStr);
        if (!verdictOutput.verdict || !["REVISED", "UPHELD"].includes(verdictOutput.verdict)) {
          throw new Error(`Invalid verdict value: ${verdictOutput.verdict}`);
        }
        if (!verdictOutput.reasoning) {
          throw new Error("Missing reasoning field");
        }
      } catch (parseErr) {
        throw new Error(`Call B JSON parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}\nRaw: ${callBText.text.slice(0, 500)}`);
      }

      const verdict: VerificationVerdict = {
        verdict: verdictOutput.verdict,
        revisedDetail: verdictOutput.revisedDetail,
        evidenceQuoted: verdictOutput.evidenceQuoted,
        evidenceSource: verdictOutput.evidenceSource,
        reasoning: verdictOutput.reasoning,
        queriesRun: callAOutput.queries,
      };

      // --- Checkpoint the verdict ---
      await ctx.integrations.db.execute(
        `INSERT INTO absence_verification_checkpoints (module_run_id, finding_index, verdict_json, model_used)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (module_run_id, finding_index) DO UPDATE SET verdict_json = $3, model_used = $4`,
        [runId, index, JSON.stringify(verdict), model],
        { label: `Checkpoint absence verdict: finding ${index}` }
      );

      verificationLog.push({
        findingIndex: index,
        title: finding.title,
        originalAbsenceConfidence: absenceConfidence,
        verdict,
        model,
      });

      console.log(`[absence-verify] Finding ${index} "${finding.title.slice(0, 40)}": ${verdict.verdict}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[absence-verify] Failed on finding ${index} "${finding.title.slice(0, 40)}": ${msg}`);

      // On failure, UPHOLD the finding (conservative — don't drop findings due to infra errors)
      const fallbackVerdict: VerificationVerdict = {
        verdict: "UPHELD",
        reasoning: `Verification failed due to error: ${msg.slice(0, 200)}. Conservatively upheld.`,
        queriesRun: [],
      };

      await ctx.integrations.db.execute(
        `INSERT INTO absence_verification_checkpoints (module_run_id, finding_index, verdict_json, model_used)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (module_run_id, finding_index) DO UPDATE SET verdict_json = $3, model_used = $4`,
        [runId, index, JSON.stringify(fallbackVerdict), model],
        { label: `Checkpoint absence fallback verdict: finding ${index}` }
      );

      verificationLog.push({
        findingIndex: index,
        title: finding.title,
        originalAbsenceConfidence: absenceConfidence,
        verdict: fallbackVerdict,
        model,
      });
    }
  }

  // --- Apply verdicts to findings ---
  const updatedFindings = findings.map((f, i) => {
    const logEntry = verificationLog.find(v => v.findingIndex === i);
    if (!logEntry) return f; // Not an absence finding — pass through untouched

    const v = logEntry.verdict;
    if (v.verdict === "REVISED") {
      return {
        ...f,
        detail: v.revisedDetail || f.detail,
        verification: {
          status: "revised" as const,
          evidenceQuoted: v.evidenceQuoted,
          evidenceSource: v.evidenceSource,
          queriesRun: v.queriesRun,
        },
      };
    } else {
      return {
        ...f,
        verification: {
          status: "upheld" as const,
          queriesRun: v.queriesRun,
        },
      };
    }
  });

  return {
    findings: updatedFindings,
    verificationLog,
  };
}
