import { api, z, anthropic } from "@superblocksteam/sdk-api";
import { buildMergedText } from "./build-merged-text.js";
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

const FindingSchema = z.object({
  severity: z.enum(["critical", "warning", "info"]),
  title: z.string(),
  detail: z.string(),
  full_analysis: z.string(),
  source_docs: z.array(z.string()),
  claim_ids: z.array(z.string()).optional(),
  absence_confidence: z.enum(["verified_absent", "likely_absent", "unverified"]).optional(),
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

## Output Structure

You MUST respond with these XML tags exactly:

<executive_header>
3-4 sentences for a busy IC chair. State the key risk posture and most material findings.
</executive_header>

<findings_json>
A JSON array. Each object has:
- "severity": "critical" | "warning" | "info"
- "title": short title, 5-10 words
- "detail": 2-3 sentences with specific document references
- "full_analysis": full paragraph with complete reasoning and evidence
- "source_docs": array of filename strings
- "claim_ids": array of claim ID strings (e.g. ["c0-3", "c2-7"]) — these are the stable IDs from the extraction step. Preserve them exactly. Every finding must trace back to at least one source claim.
- "absence_confidence": (REQUIRED for omission/gap findings) "verified_absent" | "likely_absent" | "unverified" — classification of whether the claimed absence has been cross-checked against all available extractions. Omit only for findings that do not assert something is missing.
</findings_json>

{{FINDINGS_REQUIREMENT}}`;

export const FINDINGS_RULE_FINAL = `You MUST produce findings. Every analysis has findings — if the documents are adequate, produce info-level findings confirming coverage. If the documents are inadequate, produce critical findings for every gap. An empty findings array is NEVER acceptable.`;

export const FINDINGS_RULE_INTERMEDIATE = `Produce findings that represent the consolidated output of this merge. If all input sets agree and there is nothing new to flag at this level, you may produce a minimal set of findings rather than manufacturing filler. Focus on consolidation quality, not finding count.`;

export const MERGE_PROMPTS: Record<string, string> = {
  omission_audit: `You are a senior investment committee advisor conducting a deal data room omission audit. You are synthesizing analyst findings into a comprehensive assessment of what information is missing from the deal materials.

## Your Task

1. **Consolidate Findings**: Combine all analyst observations into a unified set of findings. Where multiple analysts flagged the same gap, combine into one finding with the higher severity and all source docs.
2. **Checklist Comparison**: Ensure coverage against: customer concentration, churn/retention, key man risk, revenue recognition, regulatory, competitive response, management incentives, exit assumptions, QoE items, capex requirements.
3. **Identify Additional Gaps**: Based on the full body of evidence, flag any omissions the analysts may have missed.
4. **Prioritize**: Rank all findings by potential impact on investment decision.

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
    isFinalRound: z.boolean().optional(),
    useOpus: z.boolean().optional(),
    numericReport: z.object({
      figures: z.array(z.any()),
      discrepancies: z.array(z.any()),
    }).nullable().optional(),
    numericPartial: z.boolean().nullable().optional(),
  }),

  output: z.object({
    executiveHeader: z.string(),
    findings: z.array(FindingSchema),
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

    // Fix #3: Conditionally strip or inject numeric verification instructions.
    // When no numeric data exists, remove the numeric verification block entirely
    // and inject a guard that prevents the LLM from hallucinating [Code-Verified] labels.
    if (hasNumericData) {
      const numericVerificationInstructions = `## NUMERIC VERIFICATION — AUTHORITATIVE GROUND TRUTH

A "## Numeric Verification Report" section appears in the input below. It contains deterministic arithmetic results produced by code — NOT by AI inference. You MUST:
- Treat every figure and discrepancy in that section as factual ground truth
- Any narrative claim that contradicts a code-verified figure is a CONFIRMED contradiction — cite the exact recomputed_value
- Cross-doc agreement discrepancies are pre-verified contradictions — report them directly as findings
- Never re-derive or contradict a code-verified figure based on text reading
- A figure that appears in the Numeric Verification Report overrides any number read from text${numericPartial ? `

⚠️ PARTIAL COVERAGE WARNING: The numeric verification engine ran out of time and could NOT process all documents/tables in this deal. The figures and discrepancies below are correct for the tables that WERE analyzed, but ABSENCE of a discrepancy does NOT prove correctness — unverified tables may contain additional arithmetic errors. Do NOT claim "code-verified" status for any figure that does not explicitly appear in the Numeric Verification Report below.` : ""}`;
      mergePrompt = mergePrompt.replace("{{NUMERIC_VERIFICATION_BLOCK}}", numericVerificationInstructions);
      mergePrompt = mergePrompt.replace("{{NUMERIC_TASK_STEP_1}}",
        "**Numeric Contradictions First**: Convert every discrepancy from the Numeric Verification Report into a finding. These are confirmed contradictions. Use the recomputed_value as the authoritative figure.\n");
    } else {
      // Fix #1: Belt-and-suspenders guard language
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
    let numericBlock = "";
    if (numericReport && NUMERIC_MODULES.has(moduleId) &&
        (numericReport.figures.length > 0 || numericReport.discrepancies.length > 0)) {
      const criticalDisc = numericReport.discrepancies.filter(
        (d: Record<string, unknown>) => d.severity === "critical"
      );
      const otherDisc = numericReport.discrepancies.filter(
        (d: Record<string, unknown>) => d.severity !== "critical"
      );

      numericBlock =
        `\n\n## Numeric Verification Report\n` +
        `*Source: deterministic arithmetic engine — treat all values here as ground truth*\n\n`;

      if (numericReport.discrepancies.length > 0) {
        numericBlock += `### Flagged Discrepancies (${numericReport.discrepancies.length} total, ${criticalDisc.length} critical)\n`;
        for (const d of [...criticalDisc, ...otherDisc]) {
          const disc = d as Record<string, unknown>;
          numericBlock += `- **[${String(disc.severity).toUpperCase()}]** ${String(disc.description)}`;
          if (disc.expected != null && disc.actual != null) {
            numericBlock += ` (expected: ${disc.expected}, reported: ${disc.actual})`;
          }
          numericBlock += `\n`;
        }
        numericBlock += `\n`;
      }

      if (numericReport.figures.length > 0) {
        numericBlock += `### Verified Figures (code-recomputed)\n`;
        for (const f of numericReport.figures.slice(0, 30)) { // cap at 30 to stay in context
          const fig = f as Record<string, unknown>;
          numericBlock += `- **${String(fig.name)}**: recomputed = ${fig.recomputed_value} (cell: ${String(fig.source_cell)})`;
          if (fig.formula) numericBlock += ` [formula: ${String(fig.formula)}]`;
          numericBlock += `\n`;
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
    }> = [];

    if (findingsRaw) {
      try {
        const parsed = JSON.parse(findingsRaw);
        if (Array.isArray(parsed)) {
          findings = parsed.map((f: Record<string, unknown>) => ({
            severity:
              f.severity === "critical" ||
              f.severity === "warning" ||
              f.severity === "info"
                ? f.severity
                : "info",
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
          }));
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

    // Build a merged text representation for the next round of tree-reduce.
    // Uses the shared buildMergedText() so checkpoint-resumed merges produce
    // byte-identical output.
    const mergedText = buildMergedText(executiveHeader, findings);

    return JSON.parse(JSON.stringify({ executiveHeader, findings, mergedText }));
  },
});
