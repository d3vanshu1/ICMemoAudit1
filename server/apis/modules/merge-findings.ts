import { api, z, anthropic } from "@superblocksteam/sdk-api";
import { buildMergedText } from "./build-merged-text.js";
import { NUMERIC_MODULES } from "./constants.js";

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
const SONNET_MODEL = "claude-sonnet-4-6";
const OPUS_MODEL = "claude-opus-4-7";
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
  }),

  output: z.object({
    executiveHeader: z.string(),
    findings: z.array(FindingSchema),
    mergedText: z.string(),
  }),

  async run(ctx, { moduleId, batches, roundLabel, isFinalRound, useOpus, numericReport }) {
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
- A figure that appears in the Numeric Verification Report overrides any number read from text`;
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
          model: useOpus ? OPUS_MODEL : SONNET_MODEL,
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
