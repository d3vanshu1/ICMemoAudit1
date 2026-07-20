/**
 * Absence Verification Phase — Prompt Constants
 *
 * Shared between absence-verification-phase.ts (execution) and
 * pipeline-version.ts (hash computation). Extracting here ensures:
 * 1. No duplication of prompt strings
 * 2. The version hash covers ALL instructional content in the verification phase,
 *    including the user-message templates (not just system prompts)
 *
 * IMPORTANT: Any change to these constants will change the pipeline version hash,
 * correctly invalidating stale checkpoints.
 */

export const CALL_A_SYSTEM = `You are reviewing a single finding from a private equity investment committee diligence report. This finding claims that specific information is absent from the deal's data room. Your job is NOT to agree or disagree — only to generate search queries that would surface the information IF it exists, using terminology a source document might use, which may differ from how the finding describes it.`;

export const CALL_B_SYSTEM = `You are adversarially fact-checking a single finding from a private equity diligence report. The finding claims something is absent from the data room. You have been given ACTUAL search results retrieved from the deal's documents using queries designed to find contradicting evidence.`;

/**
 * Static instructions in Call A's user message.
 * Interpolated after the dynamic finding content.
 */
export const CALL_A_USER_INSTRUCTIONS = `Generate 3 search queries suitable for full-text search (websearch_to_tsquery syntax — use OR between alternative terms, quote exact phrases). Each query must use DIFFERENT terminology than the finding's own wording — think about how the underlying business or deal team might actually label this concept in a slide, table, or memo (industry jargon, abbreviations, or alternate framings), not just a rephrasing of the finding's language.

Output ONLY valid JSON:
{
  "concept": "one-sentence description of what we're checking for",
  "queries": ["query1", "query2", "query3"]
}`;

/**
 * Static instructions in Call B's user message.
 * Interpolated after the dynamic finding/evidence content and scope boundary.
 */
export const CALL_B_USER_INSTRUCTIONS = `Does the retrieved evidence contradict, partially contradict, or fail to contradict the finding's claim of absence?

TEMPORAL SUPERSESSION RULE (CRITICAL):
- If a finding claims information is "absent" or "deferred" based on an EARLIER document (e.g. a 2nd IC Memo), but retrieved evidence from a LATER document (e.g. a 3rd IC Memo or IC Update) shows the information was subsequently provided, the finding MUST be REVISED to reflect that the gap was resolved.
- A "Document Timeline" section is included below the evidence listing all documents in the deal room with their dates. Use this to identify whether a later-dated document exists that supersedes the source of the finding's claim.
- Never uphold a finding that says "X was deferred to next IC" or "X was not presented at IC" without checking whether a subsequent IC document already contains X.
- When revising for temporal supersession, reframe the finding as a timing/sequencing concern (e.g. "absent at 2nd IC date but presented by 3rd IC") rather than an ongoing gap.

EVIDENCE ASSESSMENT:
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
