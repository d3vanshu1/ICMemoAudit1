import { api, z, anthropic } from "@superblocksteam/sdk-api";
import { buildMergedText, type MergedFinding } from "./build-merged-text.js";
import { NUMERIC_MODULES } from "./constants.js";
import { getModuleModel } from "../pipeline/model-config.js";
import { LEGAL_TAX_REGULATORY_SCOPE_BOUNDARY } from "./analyze-chunk.js";

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MERGE_MAX_TOKENS = 8000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const ExtractionSchema = z.object({
  label: z.string(),
  extraction: z.string(),
  chunkIndex: z.number(),
});

const EvidenceItemSchema = z.object({
  figure: z.string(),
  source_doc: z.string(),
  verbatim_snippet: z.string(),
  verified: z.boolean(),
});

const FindingSchema = z.object({
  severity: z.enum(["critical", "warning", "info"]),
  title: z.string(),
  detail: z.string(),
  full_analysis: z.string(),
  source_docs: z.array(z.string()),
  claim_ids: z.array(z.string()).optional(),
  absence_confidence: z.enum(["verified_absent", "likely_absent", "unverified"]).optional(),
  gap_type: z.enum(["diligence_gap", "memo_omission", "open_item_acknowledged"]).optional(),
  evidence_docs: z.array(z.string()).optional(),
  independent: z.boolean().optional(),
  evidence: z.array(EvidenceItemSchema).optional(),
  materiality_rationale: z.string().optional(),
  category: z.enum(["principal_finding", "housekeeping", "human_review_flag"]).optional(),
  numeric_unverified: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Merge Prompts — one per module
// ---------------------------------------------------------------------------
export const MERGE_OUTPUT_STRUCTURE = `

## Presentation Rules

Your output is for investment committee members. NEVER reference:
- Internal analysis processes, batching, deduplication steps, or comparison methodology
- "Analyst batches", "cross-batch comparison", "identical inputs", or pipeline mechanics
- How many analysis sets you received or whether they overlap
Focus ENTIRELY on the substance of the findings. Write as if you performed the analysis yourself.

## CRITICAL: No Ad-Hoc Arithmetic

Do NOT perform summation, reconciliation, or arithmetic verification on numbers from the source text.
Do NOT add up periodic values to check against totals or variance columns.
Do NOT produce findings that claim a "reconciliation discrepancy" based on your own arithmetic.
All numeric verification is performed by a separate deterministic system (NumericVerify) whose results
are injected when available. Any arithmetic claim not sourced from NumericVerify is fabricated.
If you see numeric findings in the input extractions that appear to be ad-hoc arithmetic,
DISCARD them — do not propagate or consolidate them into your output.

## MATERIALITY GATE — IC-Chair Standard

Apply this test to EVERY finding before including it in principal output:

"Would this plausibly change an IC member's assessment of a £655m transaction, or is it a standard DD-workstream, post-close housekeeping, or process-stage item?"

**Principal findings** (category = "principal_finding"): Items that meet the materiality threshold. Target envelope: single digits to low teens of findings. These appear in the main findings output.

**Housekeeping items** (category = "housekeeping"): Sub-threshold items that are factually correct but immaterial to the IC decision. These include:
- Standard DD workstream tracking items
- Post-close administrative tasks
- Process-stage confirmations
- Minor procedural observations
These are DEMOTED, not deleted. They appear in a separate housekeeping appendix section (after principal findings).

**Human review flags** (category = "human_review_flag"): Emphasis-judgment findings that failed the six-point rubric. These are opinions ("underweighted", "de-emphasised") not facts.

Every finding MUST include a "materiality_rationale" field — one sentence justifying its IC relevance. A finding without a clear materiality rationale is automatically demoted to housekeeping.

## Output Structure

You MUST respond with these XML tags exactly:

<executive_header>
3-4 sentences for a busy IC chair. State the key risk posture and most material findings.
</executive_header>

<findings_json>
A JSON array of PRINCIPAL findings only (category = "principal_finding"). Each object has:
- "severity": "critical" | "warning" | "info"
- "title": short title, 5-10 words
- "detail": 2-3 sentences with specific document references
- "full_analysis": full paragraph with complete reasoning and evidence
- "source_docs": array of filename strings
- "claim_ids": array of claim ID strings (e.g. ["c0-3", "c2-7"]) — these are the stable IDs from the extraction step. Preserve them exactly. Every finding must trace back to at least one source claim.
- "absence_confidence": (REQUIRED for omission/gap findings) "verified_absent" | "likely_absent" | "unverified" — classification of whether the claimed absence has been cross-checked against all available extractions. Omit only for findings that do not assert something is missing.
- "gap_type": (REQUIRED for omission/gap findings) "diligence_gap" | "memo_omission" | "open_item_acknowledged". Use "memo_omission" when the information IS present in evidence/reference documents but absent from the subject memo. Use "diligence_gap" when the information is absent from BOTH the subject memo AND all evidence documents. Use "open_item_acknowledged" when the deal record itself discloses the item as open/pending (e.g., results TBD, workstream staged post-IC) — this is distinct from omission. Omit for non-omission findings.
- "evidence_docs": (REQUIRED when gap_type = "memo_omission") array of filenames of the evidence documents where the information WAS found. Omit when gap_type = "diligence_gap".
- "independent": (REQUIRED when gap_type = "memo_omission") boolean. Set to false when ALL evidence_docs are prior IC memos (document_tag = ic_memo) — meaning the corroboration comes only from the team's own prior work, not from independent third-party sources. Set to true when at least one evidence_doc is NOT an ic_memo (e.g. financial model, CIM, customer data, contract). This flag helps the IC distinguish findings backed by outside evidence from those merely restating prior internal positions.
- "evidence": array of evidence trace objects. REQUIRED for any finding that cites a specific number or quantitative claim. Each object: {"figure": "the number cited", "source_doc": "filename", "verbatim_snippet": "exact text from source containing this figure", "verified": true/false}. A figure with verified=false means it could not be traced to source text and is labeled numeric_unverified.
- "materiality_rationale": (REQUIRED for all findings) One sentence explaining why this finding would plausibly change an IC member's assessment of a £655m transaction. Sub-threshold items are demoted to housekeeping.
- "category": "principal_finding" | "housekeeping" | "human_review_flag". Default is "principal_finding". Use "housekeeping" for sub-materiality items (standard DD workstreams, post-close admin, process-stage items). Use "human_review_flag" for emphasis-judgment findings that failed the six-point rubric.
- "numeric_unverified": boolean. Set to true when the finding's core quantitative claim could NOT be traced to verbatim source text (e.g., chart-derived or vision-inferred figures). Such findings MUST be severity "info" maximum.
</findings_json>

## MITIGATION-CARRY RULE — Graded DD Item Attribution
<!-- Motivated by exhibits F2 (tax DD) and F7 (insurance DD) where source documents themselves
     grade or mitigate the item but the finding omitted that context, creating false alarm. -->

When a finding references a due diligence item that the source document ITSELF grades, mitigates, or
risk-rates, you MUST state in the finding's "full_analysis":
1. The source document's own grade/rating (e.g., "Red Book rates this as 'low risk'", "Adviser flags as 'Amber'")
2. The source's mitigation summary (e.g., "Indemnity agreed at £2m cap", "Insurance novation confirmed pre-close")

A finding that cites a graded DD item WITHOUT carrying forward the source's own assessment is
incomplete — the IC chair cannot distinguish a genuinely unmitigated risk from one the adviser
already resolved. If the source provides no grade or mitigation, state: "Source does not grade or mitigate."

<housekeeping_appendix>
A JSON array of sub-materiality findings (category = "housekeeping"). Same schema as findings_json.
These are factually correct observations that do NOT meet the IC-chair materiality threshold.

MANDATORY — DEMOTE, NEVER DROP: You MUST always emit this tag, even when the array is empty ("[]").
Every finding that fails the materiality gate is DEMOTED here — it is NEVER silently deleted.
The housekeeping appendix is a completeness record: its presence guarantees no finding was lost.

Worked example: A finding "Post-close admin: trademark registrations pending in 3 jurisdictions" is
factually correct but sub-threshold for a £655m transaction. It is DEMOTED to housekeeping with
category "housekeeping" and materiality_rationale "Standard post-close admin, no impact on IC decision."
It is NOT deleted.

Also include any "human_review_flag" items here (emphasis-judgment findings demoted by the rubric).
</housekeeping_appendix>

## SEMANTIC DEDUPLICATION — Same-Issue Consolidation

Before outputting findings, perform a final normalization pass:

1. **Cluster by issue identity, not title string**: Two findings describe the same underlying issue if they reference the same factual gap, the same document deficiency, or the same risk — regardless of how the title is worded.
2. **Merge duplicates**: When multiple findings describe the same underlying issue, consolidate into ONE finding with:
   - The highest severity from the cluster
   - Combined source_docs from all duplicates
   - Combined evidence arrays
   - The most complete full_analysis
3. **Known dedup targets** (from corpus analysis):
   - Tax-documentation findings appearing verbatim multiple times → consolidate to one
   - Stale-legal-DD and no-reliance findings that describe the same issue from different angles → consolidate
   - Multi-way clusters around the same contractual feature (e.g., dealer buyout mechanics) → consolidate to one finding with full evidence
4. **Size guideline**: The DiagMergeFunnel shows collapse stops at level 3 (95 leaves → 6 nodes). Target output should be single digits to low teens of principal findings. If you have >15 principal findings, you likely have unresolved duplicates.

## ADVERSARIAL NUMERIC TRACE-BACK — Mandatory Pre-Output Pass

Before finalizing findings, execute this numeric verification pass on EVERY drafted finding that contains a specific number:

1. **Identify all numeric claims**: For each finding, extract every specific figure (percentages, currency amounts, ratios, counts).
2. **Source retrieval**: For each figure, search the input extraction sets for a verbatim text snippet containing that exact number. The snippet must come from a named source document.
3. **Match verification**: The figure in the finding must EXACTLY match the figure in the source snippet. Transpositions (e.g., 49% cited as 94%), rounding artifacts, and cross-document arithmetic are ALL failures.
4. **Label unverifiable figures**: Any figure that cannot be matched to verbatim source text — including chart-derived values, vision-inferred numbers, or AI-computed aggregates — MUST be:
   - Labeled with "numeric_unverified": true on the finding
   - Capped at severity "info"
   - Flagged in the evidence array with verified=false
5. **Populate evidence array**: For EVERY numeric finding, produce an evidence object per figure: {"figure": "the number", "source_doc": "filename", "verbatim_snippet": "exact surrounding text", "verified": true/false}.

Known failure patterns to catch:
- NPS transposition: citing segment scores in wrong order or transposed digits
- Revenue fabrication: asserting decline when P&L actually shows growth (e.g., claiming £250m→£194m when actuals are £144.8m→£168.2m→£192.5m)
- Coupon mismatch: confusing 12% vs 14% preference coupon rates across instruments

## RETRIEVAL VERIFICATION GATE — Mandatory Pre-Output Check (Six-Point Rubric)

Before emitting ANY finding, apply ALL six checks. A finding that fails ANY check is DEMOTED to severity "info" with category "human_review_flag" or DROPPED entirely:

1. **Quote-anchored**: The finding cites a verbatim quote or specific numeric figure from a named source document. Paraphrased or inferred claims without direct textual evidence FAIL.
2. **Fact-of-process, not emphasis-judgment**: The finding states an objective factual gap or contradiction — NOT a subjective judgment about emphasis, tone, or weighting. Phrases like "underweighted", "de-emphasised", "insufficiently discussed", "should have been highlighted more" are emphasis-judgments and FAIL. Demote to human_review_flag.
3. **Two-sided verified**: For any absence/omission claim, the opposite has been checked — the analyst searched for the topic under alternate terminology and across all document sets. A claim with no verification trail FAILS.
4. **Numbers traced**: Every specific number in the finding matches a verbatim figure in the source text. A number that cannot be traced to exact source text is labeled numeric_unverified. Findings whose core claim depends on an unverified number FAIL.
5. **Post-IC staging respected**: If the deal's own DD/adviser table explicitly stages a workstream as "post IC" or "kick off post IC", that topic is classified as open_item_acknowledged, NEVER as an omission or gap. A finding that flags explicitly staged work as missing FAILS.
6. **IC-chair materiality**: The finding would plausibly change an IC member's assessment of the transaction. Standard housekeeping, process-stage items, and minor administrative matters are below threshold — demote to housekeeping appendix.

Findings that contain emphasis-judgment language ("underweighted", "de-emphasised", "insufficiently stressed", "could have been more prominent") MUST be demoted to category "human_review_flag" with severity "info" — they represent editorial opinion, not factual findings.

{{FINDINGS_REQUIREMENT}}`;

export const FINDINGS_RULE_FINAL = `You MUST produce findings. Every analysis has findings — if the documents are adequate, produce info-level findings confirming coverage. If the documents are inadequate, produce critical findings for every gap. An empty findings array is NEVER acceptable.`;

export const FINDINGS_RULE_INTERMEDIATE = `Produce findings that represent the consolidated output of this merge. If all input sets agree and there is nothing new to flag at this level, you may produce a minimal set of findings rather than manufacturing filler. Focus on consolidation quality, not finding count.`;

export const MERGE_PROMPTS: Record<string, string> = {
  omission_audit: `You are a senior investment committee advisor conducting a deal data room omission audit. You are synthesizing analyst findings into a comprehensive assessment of what information is missing from the deal materials.

## Document Role Context (derived at prompt time, not stored)

The evidence pool contains ALL deal documents EXCEPT the subject document(s) (excluded by ID). This includes:
- **Objective sources** (document_tag ∈ financial_model, customer_data, consultant_report, legal, other with document_source = 'pep'): Treat as factual ground truth.
- **Narrative sources** (document_tag ∈ cim, im, OR document_source = 'sellside'): These are ADVOCACY documents. They may contain spin, selective emphasis, or omissions of their own. Scrutinize narrative-source claims against objective-source data rather than treating them as authoritative. A claim made ONLY in a narrative source without objective backing is NOT confirmed evidence.

The "independent" field on findings is determined by code post-merge — you do NOT need to set it. Focus on classifying gap_type and listing evidence_docs accurately.

## Multi-Version Memo Handling (union-subject model)

When the subject comprises multiple IC memo versions (chronological record):
- **(a) Supersession rule**: When memo versions state different values for the same metric or claim, the LATEST memo governs. Do NOT flag superseded figures as contradictions of the current thesis. You MAY note a revision if the magnitude is material (e.g., "revenue projection revised from $50M to $38M between Memo 2 and Memo 3") at severity "info".
- **(b) Thesis drift**: A risk, topic, or commitment discussed in an EARLIER memo that is ABSENT from the LATEST memo is a reportable finding. Classify this as a distinct finding type — it represents thesis drift (the team quietly dropped or de-emphasized something), which is different from memo_omission (information in evidence but never mentioned in any memo version).

## Your Task

1. **Consolidate Findings**: Combine all analyst observations into a unified set of findings. Where multiple analysts flagged the same gap, combine into one finding with the higher severity and all source docs.
2. **Classify Each Gap**: For every omission finding, determine:
   - **memo_omission** — the information IS present in evidence documents but absent from the subject memo (the memo failed to mention it). MUST include "evidence_docs" listing which files contain the evidence, and "independent" indicating whether at least one non-ic_memo source corroborates.
   - **diligence_gap** — the information is absent from BOTH the subject memo AND all evidence documents (a true gap in the data room).
3. **Checklist Comparison**: Ensure coverage against: customer concentration, churn/retention, key man risk, revenue recognition, regulatory, competitive response, management incentives, exit assumptions, QoE items, capex requirements.
4. **Identify Additional Gaps**: Based on the full body of evidence, flag any omissions the analysts may have missed.
5. **Prioritize**: Rank all findings by potential impact on investment decision.

## CRITICAL: Adversarial Re-Verification of Absence Claims

You are the gatekeeper against fabricated omission findings. Before including ANY finding that asserts something is "missing" or "absent" from the data room:

1. **Cross-chunk check**: Did ANY analyst extraction mention this topic, even tangentially? Search all input sets for related terms. If found anywhere, the claim is FALSE — downgrade or discard.
2. **Verify the "verification" field**: Each analyst flag should include a "verification" field explaining what search terms they tried. If a flag has NO verification field, treat it as UNVERIFIED and either discard it or downgrade to info severity with a note: "Unverified absence claim — requires manual confirmation."
3. **Check for alternate terminology**: Could the gap be addressed under different wording? (e.g., "no churn data" when retention rates ARE present)
4. **Classify each absence finding**:
   - **"verified_absent"**: Multiple analysts checked, alternate phrasings tried, genuinely not in the reviewed materials
   - **"likely_absent"**: One analyst flagged with verification, not contradicted by others
   - **"unverified"**: No verification evidence, or contradicted by another extraction
5. **Include classification in output**: Add an "absence_confidence" field to every gap/omission finding: "verified_absent" | "likely_absent" | "unverified"

Findings classified as "unverified" MUST be severity "info" regardless of the analyst's original severity rating. Do NOT promote unverified absence claims to critical or warning.
${LEGAL_TAX_REGULATORY_SCOPE_BOUNDARY}
${MERGE_OUTPUT_STRUCTURE}`,

  contradiction_check: `You are a senior investment committee advisor. You are synthesizing analyst findings that extracted narrative claims and data points from deal documents. Your job is to cross-reference narrative claims against data-derived findings and flag contradictions.

{{NUMERIC_VERIFICATION_BLOCK}}

## Your Task

1. {{NUMERIC_TASK_STEP_1}}**Cross-Reference Narrative vs. Data**: For each narrative claim, search the data extractions for confirming or contradicting evidence.
2. **Flag Contradictions**: When a narrative claim conflicts with data, document both sides with exact citations.
3. **Identify Unsupported Claims**: Flag narrative claims that have no data support.
4. **Assess Materiality**: Rate each contradiction by its potential impact on the investment thesis.
5. **Note Consistent Claims**: Briefly acknowledge claims that are well-supported by data.
6. **Consolidate**: Combine overlapping observations into single, stronger findings.
${MERGE_OUTPUT_STRUCTURE}`,

  blind_spot_scanner: `You are a senior investment committee advisor and contrarian thinker. You are synthesizing analyst findings that extracted the investment thesis, explicit assumptions, and implicit assumptions from deal documents. Your job is to identify blind spots.

## Multi-Version Memo Handling (union-subject model)

When the subject comprises multiple IC memo versions (chronological record):
- **(a) Supersession rule**: When memo versions state different values for the same metric or claim, the LATEST memo governs. Do NOT flag superseded figures as contradictions of the current thesis. You MAY note a revision if the magnitude is material at severity "info".
- **(b) Thesis drift**: A risk, topic, or commitment discussed in an EARLIER memo that is ABSENT from the LATEST memo is a reportable finding. Classify this as thesis drift — the team quietly dropped or de-emphasized something. This is distinct from a standard blind spot (assumption never addressed anywhere).

## Your Task

1. **Reconstruct the Full Thesis**: Combine thesis elements from all documents.
2. **Map the Assumption Chain**: Build a dependency tree — which assumptions depend on other assumptions?
3. **Find the Gaps**: For each implicit assumption, check whether ANY document addresses it. If not, it's a blind spot.
4. **Stress Test**: For each blind spot, describe what happens to the thesis if that assumption proves wrong.
5. **Generate Diligence Questions**: For each critical blind spot, provide the specific question the deal team should answer.
6. **Consolidate**: Combine overlapping observations into single, stronger findings.

## CRITICAL: Adversarial Re-Verification of Absence Claims

Before asserting that a risk is "unaddressed" or an assumption is "never discussed":

1. **Cross-check all input sets**: Search every analyst extraction for related terms, synonyms, and indirect coverage.
2. **Require verification evidence**: Only promote a blind spot to critical/warning if the analyst included a "verification" field showing what they searched for. Unverified claims → info severity with note.
3. **Distinguish scope**: "Not found in reviewed chunks" ≠ "not addressed in the deal". Use precise language.
4. **Add "absence_confidence"**: "verified_absent" | "likely_absent" | "unverified" to every finding asserting something is missing.
${LEGAL_TAX_REGULATORY_SCOPE_BOUNDARY}
${MERGE_OUTPUT_STRUCTURE}`,

  external_risk_overlay: `You are the most senior risk advisor at a private equity firm. You are synthesizing EXTERNAL WEB RESEARCH findings into a comprehensive risk assessment.

IMPORTANT: You may also receive a "Document Context" section. This is REFERENCE MATERIAL extracted from the deal data room — it is NOT part of the research findings. Use it to:
- Determine whether a research finding was already known to the deal team
- Assess whether the deal team understated a risk
- Cross-reference claims in deal documents against external evidence

## Your Task

1. **Consolidate Research Findings**: Combine overlapping findings, keeping the higher severity and combining source URLs.
2. **Preserve Source Attribution**: Every finding MUST retain its source URLs. If a finding has no URL, note that it lacks external sourcing.
3. **Classify into Risk Buckets**:
   - **Unknown to Deal Team**: Risks found externally with no mention in the document context
   - **Mentioned but Understated**: Risks in the deal documents where external research suggests greater severity
   - **Thesis Dependent**: External factors that must remain true for the investment thesis to hold
   - **Monitor List**: Early-stage risks not yet material but worth tracking post-close
4. **Prioritize**: Rank by potential impact on the investment decision.
5. **Do NOT restate deal document content as findings** — findings must be grounded in external research.
${MERGE_OUTPUT_STRUCTURE}`,

  social_reputation: `You are the most senior reputation intelligence advisor at a private equity firm. You are synthesizing findings from a social & reputation intelligence analysis that includes both deal document extractions and web research results.

## CRITICAL SCOPE RULE

Every finding MUST reference specific public data sources (Glassdoor reviews, LinkedIn data, social media posts, news articles, review platforms). Do NOT produce findings that only compare internal deal documents against each other.

## Your Task

1. **Organize by Category**: Employee Sentiment, Customer Perception, Brand & Social Presence, Leadership Reputation, News & Public Record.
2. **Cross-Reference**: Compare deal team claims to public signals found via web research.
3. **Consolidate**: Combine overlapping observations into single, stronger findings.
4. **Prioritize**: Rank by materiality to the investment decision.
${MERGE_OUTPUT_STRUCTURE}`,

  ic_challenge_mode: `You are the toughest IC chair in private equity. You are synthesizing analyst findings that extracted thesis claims, risks, assumptions, and weak points from deal documents. Your job is to generate the 8 hardest questions for the IC meeting.

## Your Task

1. **Identify Vulnerabilities**: Find the 8 most vulnerable aspects of the deal team's thesis across all findings.
2. **Craft Targeted Questions**: Each question must be grounded in a specific document finding, not generic.
3. **Provide Context**: For each question, explain why it matters, what a strong answer looks like, and what a weak answer looks like.
4. **Order by Impact**: Put the most thesis-threatening question first.
5. **Consolidate**: Combine overlapping concerns into single, sharper questions.
${MERGE_OUTPUT_STRUCTURE}`,

  model_assumptions_stress: `You are a senior PE operating partner and financial model reviewer. You are synthesizing analyst findings that extracted quantitative model assumptions from deal documents. Your job is to stress-test the deal team's underwriting model.

{{NUMERIC_VERIFICATION_BLOCK}}

## Your Task

1. {{NUMERIC_TASK_STEP_1}}**Compare to Historical Actuals**: Does the assumption align with the company's own historical performance?
2. **Test Internal Consistency**: Do assumptions across documents agree?
3. **Compare Deal Team vs. Management**: Where the deal team has diverged from management's projections, assess whether the haircut is sufficient.
4. **Rate Each Assumption**: Score as Aggressive / Reasonable / Conservative.
5. **Sensitivity Analysis**: For each critical assumption, describe what happens to returns if it is 20% worse.
6. **Consolidate**: Combine overlapping observations into single, stronger findings.
${MERGE_OUTPUT_STRUCTURE}`,

  diligence_completeness: `You are a senior PE operating partner conducting a final diligence completeness review. You are synthesizing analyst findings that evaluated documents against the 10 standard PE diligence dimensions.

## Multi-Version Memo Handling (union-subject model)

When the subject comprises multiple IC memo versions (chronological record):
- **(a) Supersession rule**: When memo versions state different values for the same metric or claim, the LATEST memo governs. Do NOT flag superseded figures as contradictions of the current thesis. You MAY note a revision if the magnitude is material at severity "info".
- **(b) Thesis drift**: A risk, topic, or commitment discussed in an EARLIER memo that is ABSENT from the LATEST memo is a reportable finding. Classify this as thesis drift — the team quietly dropped or de-emphasized something. This is distinct from a missing diligence dimension.

## Your Task

1. **Aggregate Scores**: Across all documents, determine the overall score (1-5) for each of the 10 dimensions.
2. **Identify Gaps**: Highlight any dimension scoring 2 or below.
3. **Justify Each Score**: Explain what evidence supports the score and what's missing.
4. **Calculate Overall Rating**: Average across all 10 dimensions and provide a letter grade (A/B/C/D/F).
5. **State What IC Is Approving Blind**: Explicitly list areas where information is insufficient.
6. **Consolidate**: Combine overlapping observations into single, stronger findings.

## CRITICAL: Adversarial Re-Verification of Absence Claims

When scoring a dimension low (1-2) due to "missing" information:

1. **Cross-check all analyst inputs**: Did ANY extraction mention coverage of this dimension, even partially? If yes, the score cannot be 1.
2. **Require verification evidence**: For dimensions scored ≤2, the finding MUST cite specific verification (search terms tried, alternate terminology checked). If no verification, cap at score 2 with "unverified gap" note.
3. **Distinguish partial vs. absent**: Score 2 = mentioned briefly (some content exists). Score 1 = truly not addressed (verified across all reviewed chunks).
4. **Add "absence_confidence"** to every gap finding: "verified_absent" | "likely_absent" | "unverified"
${LEGAL_TAX_REGULATORY_SCOPE_BOUNDARY}
${MERGE_OUTPUT_STRUCTURE}`,

  executive_summary: `You are the senior-most investment professional preparing the final IC briefing document. You are synthesizing all module outputs into a cohesive executive summary.

## Your Task

1. Open with an overall investment risk assessment (1-2 sentences)
2. Highlight the 3-5 most important findings across ALL modules
3. Identify patterns or themes that emerge when viewing all modules together
4. Provide a clear recommendation on IC readiness
5. List specific items that must be addressed before IC approval
6. Synthesize and connect findings — do not simply list them
7. Call out contradictions BETWEEN module findings
8. Weight findings by their impact on the investment thesis
${MERGE_OUTPUT_STRUCTURE}`,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTag(text: string, tag: string): string {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

// ---------------------------------------------------------------------------
// Anthropic response schema
// ---------------------------------------------------------------------------
const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(
    z.object({
      type: z.literal("text"),
      text: z.string(),
    })
  ),
  model: z.string(),
  stop_reason: z.string().nullable(),
  stop_sequence: z.string().nullable().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

// ---------------------------------------------------------------------------
// API — Pair-merge findings (called iteratively for tree-reduce)
// ---------------------------------------------------------------------------
export default api({
  name: "MergeFindings",
  description: "Synthesizes analyst extractions into consolidated IC-ready findings",

  integrations: {
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    moduleId: z.string(),
    batches: z.array(z.string()).min(2).max(4),
    roundLabel: z.string(),
    isFinalRound: z.boolean().nullable().optional(),
    useOpus: z.boolean().nullable().optional(),
    numericReport: z.object({
      figures: z.array(z.any()),
      discrepancies: z.array(z.any()),
    }).nullable().optional(),
    numericPartial: z.boolean().nullable().optional(),
  }),

  output: z.object({
    executiveHeader: z.string(),
    findings: z.array(FindingSchema),
    housekeepingFindings: z.array(FindingSchema).optional(),
    mergedText: z.string(),
  }),

  async run(ctx, { moduleId, batches, roundLabel, isFinalRound, useOpus, numericReport, numericPartial }) {
    const rawPrompt = MERGE_PROMPTS[moduleId];
    if (!rawPrompt) {
      throw new Error(`Module "${moduleId}" merge prompt not configured.`);
    }

    // Swap in the appropriate findings requirement based on round
    const findingsRule = isFinalRound ? FINDINGS_RULE_FINAL : FINDINGS_RULE_INTERMEDIATE;
    let mergePrompt = rawPrompt.replace("{{FINDINGS_REQUIREMENT}}", findingsRule);

    // Determine whether real numeric verification data is available
    const hasNumericData = !!(numericReport && NUMERIC_MODULES.has(moduleId) &&
        (numericReport.figures.length > 0 || numericReport.discrepancies.length > 0));

    // Conditionally strip or inject numeric verification instructions.
    // Aligned with pipeline-core.ts: hedged framing ("trustworthy values," not
    // "AUTHORITATIVE GROUND TRUTH"). Cross-version divergences are not asserted
    // errors — they're flagged for analyst confirmation.
    if (hasNumericData) {
      const numericVerificationInstructions = `## NUMERIC VERIFICATION — TRUSTWORTHY VALUES

A "## Numeric Verification Report" section appears in the input below. It contains cell values read directly from the financial model by code — NOT by AI inference. You MUST:
- Treat every "Verified Figure" as a trustworthy cell value from the model
- Flag where NARRATIVE claims (from CIM, IC memo, management presentations) disagree with these values — that is a potential contradiction
- "Cross-Version Divergences" compare the live model to a frozen reference; frame these as "confirm intentional revision vs stale reference," not as asserted errors
- Never invent or re-derive figures — only cite values that appear in the Verified Figures list
- Do NOT treat absence from the list as evidence of a problem — the list covers configured metrics only${numericPartial ? `

⚠️ PARTIAL COVERAGE: The engine ran out of time before processing all tables. Verified Figures are correct for what was analyzed, but coverage is incomplete.` : ""}`;
      mergePrompt = mergePrompt.replace("{{NUMERIC_VERIFICATION_BLOCK}}", numericVerificationInstructions);
      mergePrompt = mergePrompt.replace("{{NUMERIC_TASK_STEP_1}}",
        "**Cross-Version Divergences First**: If the Numeric Verification Report contains cross-version divergences, assess each cluster and report as findings where they indicate stale references or contradictions (not merely intentional updates).\n");
    } else {
      // Guard: no numeric data available — prevent LLM from hallucinating code-verified labels
      const noNumericGuard = `## IMPORTANT — NO CODE-VERIFIED DATA AVAILABLE

No deterministic numeric verification was performed for this analysis. All figures you cite are derived from AI text interpretation, which is inherently non-deterministic. You MUST:
- NEVER use the phrases "code-verified", "[Code-Verified]", "confirmed by code", or "deterministic verification" in your output
- NEVER label any figure as "confirmed" unless you are comparing two figures explicitly stated in different source documents
- When citing a specific number, state the source document and acknowledge it is "as stated in [document]" or "per [document]"
- Qualify numerical claims appropriately: use "approximately", "as reported", or "per the model" rather than implying independent verification`;
      mergePrompt = mergePrompt.replace("{{NUMERIC_VERIFICATION_BLOCK}}", noNumericGuard);
      mergePrompt = mergePrompt.replace("{{NUMERIC_TASK_STEP_1}}", "");
    }

    // Build numeric report block if applicable
    // Aligned with pipeline-core.ts: uses new schema fields (value, period, source_cell)
    // and frames cross-agreement as "divergences to confirm," not "asserted errors."
    let numericBlock = "";
    if (numericReport && NUMERIC_MODULES.has(moduleId) &&
        (numericReport.figures.length > 0 || numericReport.discrepancies.length > 0)) {

      numericBlock =
        `\n\n## Numeric Verification Report\n` +
        `*Source: deterministic cell-value reads from the financial model*\n\n`;

      // Cross-agreement discrepancies (the ONLY discrepancy source)
      if (numericReport.discrepancies.length > 0) {
        numericBlock += `### Cross-Version Divergences\n`;
        numericBlock += `*These are differences between the live model and a frozen reference. Confirm whether each reflects an intentional update or a stale/contradictory reference.*\n\n`;
        for (const d of numericReport.discrepancies) {
          const disc = d as Record<string, unknown>;
          numericBlock += `- **[${String(disc.severity).toUpperCase()}]** ${String(disc.description)}\n`;
        }
        numericBlock += `\n`;
      }

      // Verified figures — trustworthy values for narrative comparison
      if (numericReport.figures.length > 0) {
        numericBlock += `### Verified Figures (Trustworthy Cell Values)\n`;
        numericBlock += `*Flag where narrative claims disagree with these code-read values.*\n\n`;
        const MAX_FIG_DISPLAY = 200;
        const figuresArr = numericReport.figures as Array<Record<string, unknown>>;
        if (figuresArr.length > MAX_FIG_DISPLAY) {
          console.warn(`[merge-findings] numeric figures capped at ${MAX_FIG_DISPLAY} (had ${figuresArr.length})`);
        }
        for (const fig of figuresArr.slice(0, MAX_FIG_DISPLAY)) {
          numericBlock += `- **${String(fig.name)}** (${String(fig.period ?? "")}): ${fig.value} @ ${String(fig.source_cell)}\n`;
        }
      }
    }

    // Build input from analysis sets — dynamically generates headers for 2-4 batches
    const setBlocks = batches.map(
      (text, i) => `## Analysis Set ${i + 1}\n\n${text}`
    );
    const mergeInput = setBlocks.join("\n\n---\n\n") + numericBlock;

    const result = await ctx.integrations.ai.apiRequest(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: getModuleModel(moduleId, useOpus),
          max_tokens: MERGE_MAX_TOKENS,
          system: [
            {
              type: "text",
              text: mergePrompt,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: mergeInput }],
        },
      },
      { response: MessageResponseSchema },
      { label: `Group-merge (${batches.length}-way): ${roundLabel}` }
    );

    const textBlock = result.content.find(
      (c: { type: string }) => c.type === "text"
    );
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text content in merge response");
    }

    const output = textBlock.text;

    // Parse XML output
    const executiveHeader =
      extractTag(output, "executive_header") ||
      "Analysis complete. See findings below.";

    const findingsRaw = extractTag(output, "findings_json");

    let findings: Array<{
      severity: "critical" | "warning" | "info";
      title: string;
      detail: string;
      full_analysis: string;
      source_docs: string[];
      claim_ids?: string[];
      absence_confidence?: string;
      gap_type?: "diligence_gap" | "memo_omission" | "open_item_acknowledged";
      evidence_docs?: string[];
      independent?: boolean;
      evidence?: Array<{ figure: string; source_doc: string; verbatim_snippet: string; verified: boolean }>;
      materiality_rationale?: string;
      category?: string;
      numeric_unverified?: boolean;
    }> = [];

    if (findingsRaw) {
      try {
        const parsed = JSON.parse(findingsRaw);
        if (Array.isArray(parsed)) {
          findings = parsed.map((f: Record<string, unknown>) => {
            // Enforce: numeric_unverified findings capped at info
            const rawSeverity = f.severity === "critical" || f.severity === "warning" || f.severity === "info"
              ? f.severity : "info";
            const isNumericUnverified = f.numeric_unverified === true;
            const severity = isNumericUnverified && rawSeverity !== "info" ? "info" as const : rawSeverity;

            return {
              severity,
              title: String(f.title ?? "Untitled"),
              detail: String(f.detail ?? ""),
              full_analysis: String(f.full_analysis ?? f.detail ?? ""),
              source_docs: Array.isArray(f.source_docs)
                ? f.source_docs.map(String)
                : [],
              ...(Array.isArray(f.claim_ids) && f.claim_ids.length > 0
                ? { claim_ids: f.claim_ids.map(String) }
                : {}),
              ...(f.absence_confidence === "verified_absent" ||
                f.absence_confidence === "likely_absent" ||
                f.absence_confidence === "unverified"
                ? { absence_confidence: f.absence_confidence as string }
                : {}),
            ...(f.gap_type === "diligence_gap" || f.gap_type === "memo_omission" || f.gap_type === "open_item_acknowledged"
              ? { gap_type: f.gap_type as "diligence_gap" | "memo_omission" | "open_item_acknowledged" }
              : {}),
              ...(Array.isArray(f.evidence_docs) && f.evidence_docs.length > 0
                ? { evidence_docs: f.evidence_docs.map(String) }
                : {}),
              ...(typeof f.independent === "boolean"
                ? { independent: f.independent }
                : {}),
              // Fix 3: evidence trace array
              ...(Array.isArray(f.evidence)
                ? { evidence: (f.evidence as Array<Record<string, unknown>>).map(e => ({
                    figure: String(e.figure ?? ""),
                    source_doc: String(e.source_doc ?? ""),
                    verbatim_snippet: String(e.verbatim_snippet ?? ""),
                    verified: e.verified === true,
                  })) }
                : {}),
              // Fix 4: materiality rationale
              ...(typeof f.materiality_rationale === "string" && f.materiality_rationale
                ? { materiality_rationale: f.materiality_rationale }
                : {}),
              // Fix 4/cross-cutting: category classification
              ...(f.category === "principal_finding" || f.category === "housekeeping" || f.category === "human_review_flag"
                ? { category: f.category as "principal_finding" | "housekeeping" | "human_review_flag" }
                : {}),
              // Fix 3: numeric_unverified flag
              ...(isNumericUnverified ? { numeric_unverified: true } : {}),
            };
          });

          // CODE BACKSTOP: memo_omission/open_item_acknowledged findings missing
          // absence_confidence are treated as "unverified" and capped at severity "info".
          for (const f of findings) {
            if ((f.gap_type === "memo_omission" || f.gap_type === "open_item_acknowledged") && !f.absence_confidence) {
              (f as any).absence_confidence = "unverified";
              if (f.severity === "critical" || f.severity === "warning") {
                (f as any).severity = "info";
              }
            }
          }
        }
      } catch {
        findings = [
          {
            severity: "info" as const,
            title: "Analysis Complete",
            detail: findingsRaw.slice(0, 300),
            full_analysis: findingsRaw,
            source_docs: [],
          },
        ];
      }
    }

    // Fix 6: Parse housekeeping appendix (sub-materiality + human_review_flag items)
    const housekeepingRaw = extractTag(output, "housekeeping_appendix");
    let housekeepingFindings: typeof findings = [];
    if (housekeepingRaw) {
      try {
        const parsed = JSON.parse(housekeepingRaw);
        if (Array.isArray(parsed)) {
          housekeepingFindings = parsed.map((f: Record<string, unknown>) => ({
            severity: f.severity === "critical" || f.severity === "warning" || f.severity === "info"
              ? f.severity : "info" as const,
            title: String(f.title ?? "Untitled"),
            detail: String(f.detail ?? ""),
            full_analysis: String(f.full_analysis ?? f.detail ?? ""),
            source_docs: Array.isArray(f.source_docs) ? f.source_docs.map(String) : [],
            ...(typeof f.materiality_rationale === "string" ? { materiality_rationale: f.materiality_rationale } : {}),
            ...(f.category === "housekeeping" || f.category === "human_review_flag"
              ? { category: f.category as string }
              : { category: "housekeeping" as const }),
          }));
        }
      } catch {
        // Non-fatal: housekeeping parse failure doesn't break the pipeline
        console.warn("[merge] Failed to parse housekeeping_appendix JSON");
      }
    }

    // Build a merged text representation for the next round of tree-reduce.
    // Uses the shared buildMergedText() so checkpoint-resumed merges produce
    // byte-identical output.
    const mergedText = buildMergedText(executiveHeader, findings as MergedFinding[]);

    return JSON.parse(JSON.stringify({ executiveHeader, findings, housekeepingFindings: housekeepingFindings.length > 0 ? housekeepingFindings : undefined, mergedText }));
  },
});
