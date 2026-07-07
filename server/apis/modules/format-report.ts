import { api, z, anthropic } from "@superblocksteam/sdk-api";
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
const REPORT_MAX_TOKENS = 16000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const FindingSchema = z.object({
  severity: z.enum(["critical", "warning", "info"]),
  title: z.string(),
  detail: z.string(),
  full_analysis: z.string(),
  source_docs: z.array(z.string()),
  claim_ids: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Report Prompts — one per module
// ---------------------------------------------------------------------------
const REPORT_PREAMBLE = `You are a senior investment committee advisor. You have already identified and prioritized findings. Now write the DETAILED MARKDOWN REPORT based on the structured findings provided.

## Your Input

You will receive:
1. An executive header (already written — do not rewrite it)
2. A JSON array of prioritized findings with severity, title, detail, full_analysis, and source_docs

## Critical Rule — Full Treatment for Every Finding

You receive N findings in the JSON array. Your report MUST contain exactly N fully detailed write-ups — one per finding. No finding may be omitted, compressed into a brief one-liner, folded into a bullet point, or split across multiple sections.

Treatment depth is proportional to severity:

**Critical findings** — full treatment (all 5 elements):
1. A **heading** with the finding title and severity tag (e.g. "#### Finding Title [CRITICAL]")
2. The **detail** paragraph
3. The **full_analysis** paragraph (the full reasoning and evidence)
4. **Source documents** cited
5. A **recommended action** specific to this finding

**Warning findings** — standard treatment (4 elements):
1. A **heading** with the finding title and severity tag (e.g. "#### Finding Title [WARNING]")
2. The **detail** paragraph
3. A **condensed analysis** (2-3 sentences capturing the key reasoning — do NOT reproduce the full_analysis verbatim, summarize it)
4. **Source documents** cited

**Info findings** — brief treatment (3 elements):
1. A **heading** with the finding title and severity tag (e.g. "#### Finding Title [INFO]")
2. A **single paragraph** combining the detail and key takeaway
3. **Source documents** cited

The report sections below group findings by severity. Place each finding in the section matching its severity. If a section has zero findings of that severity, write "None identified in this analysis." — do NOT fill it with findings from another severity level.

## Self-Check Before Responding

Before returning your report, count the fully detailed write-ups. If the count does not equal N (the number of findings in the input JSON), you have dropped or compressed a finding. Go back and fix it.

## Output Format

Output ONLY the markdown report content. Do NOT wrap it in XML tags. Start directly with the markdown.`;

const REPORT_PROMPTS: Record<string, string> = {
  omission_audit: `${REPORT_PREAMBLE}

Structure your report as:

## Omission Audit Report

### Critical Omissions
[For each critical finding: heading, detailed explanation, recommended action]

### Elevated Omissions
[For each warning finding: heading, detailed explanation]

### Watch Items
[For each info finding: heading, detailed explanation, what to monitor]

### Recommended Actions
[Numbered priority list of next steps for the deal team, with timelines]`,

  contradiction_check: `${REPORT_PREAMBLE}

## NUMERIC VERIFICATION REQUIREMENT
A "## Numeric Verification Report" section in your input contains code-verified arithmetic results. You MUST:
- Present all numeric discrepancies and cross-doc figure mismatches as **Confirmed Contradictions** with the highest priority
- Cite the recomputed_value as the authoritative figure
- State "[Code-Verified: X]" next to any figure drawn from the Numeric Verification Report
- Label these findings as: **SOURCE: Deterministic Arithmetic Verification**

Structure your report as:

## Narrative vs. Data Contradiction Report

### Critical Findings
[Place ALL findings with severity="critical" here. For EACH one: heading with title, the narrative claim, the contradicting data point, which document each comes from, why the discrepancy matters, and recommended action. Full paragraphs — no compression.]

### Elevated Findings
[Place ALL findings with severity="warning" here. Standard treatment: heading with [WARNING] tag, detail paragraph, condensed analysis (2-3 sentences), source docs. No recommended action needed per finding.]

### Informational Findings
[Place ALL findings with severity="info" here. Brief treatment: heading with [INFO] tag, single paragraph combining detail and takeaway, source docs.]

### Recommended Actions Summary
[Consolidated numbered list of next steps drawn from the Critical and Elevated findings above.]`,

  blind_spot_scanner: `${REPORT_PREAMBLE}

Structure your report as:

## Blind Spot Scanner Report

### Investment Thesis Summary
[Reconstructed thesis from all documents]

### Critical Blind Spots
[Each with: the implicit assumption, why it matters, what breaks if wrong, suggested diligence question]

### Elevated Blind Spots
[Same structure, lower severity]

### Watch Items
[For each info finding: heading, detailed explanation, what to monitor]

### Recommended Diligence Actions
[Numbered priority list of questions and next steps]`,

  external_risk_overlay: `${REPORT_PREAMBLE}

IMPORTANT: This report is based on EXTERNAL web research, not internal document review.
Every finding should include its source (URL or search query). Do not present deal document content as external findings.

Structure your report as:

## External Risk Overlay Report

### Research Confidence Assessment
[High/Medium/Low rating with explanation of: how much public information exists for this company, what research categories were covered (regulatory, competitive, customer/market, technology, macro, management, and any OTHER categories discovered), and any gaps in coverage]

### Risk Categories Discovered
[For EACH category that has findings (do NOT include empty categories), create a subsection:

#### [Category Name]
For each finding in this category, provide the full write-up: heading with title and severity tag, detail paragraph, full_analysis paragraph, source documents, and recommended action. Do NOT compress any finding into a brief bullet. Group by severity within each category (Critical first, then Warning, then Info).

Use the categories the research actually found (REGULATORY, COMPETITIVE, CUSTOMER_MARKET, TECHNOLOGY, MACRO, MANAGEMENT, OTHER, or any custom categories). Do NOT force findings into categories they don't belong to.]

### Cross-Reference Summary
| Finding | In Deal Docs? | Deal Team Assessment | External Evidence | Gap |
|---------|---------------|---------------------|-------------------|-----|
[One row per material finding, showing whether the deal team knew about it and how their assessment compares to external evidence]

### Unknown to Deal Team
[Risks found externally with no mention in any uploaded document — the most valuable section]

### Mentioned but Understated
[Risks in the materials where external research suggests greater severity]

### Thesis Dependents
[External factors that must remain true for the investment thesis to hold]

### Monitor List
[Early-stage risks not yet material but worth tracking post-close]

### Recommended Actions
[Numbered list with specific diligence actions for each critical risk, including what to search for and who to ask]`,

  social_reputation: `${REPORT_PREAMBLE}

Every finding MUST reference specific public sources. Do NOT produce findings based only on internal document comparisons.

Structure your report as:

## Social & Reputation Intelligence Report

### Research Confidence Assessment
[High/Medium/Low rating with explanation of data availability across platforms]

### Employee Sentiment & Culture
[Place ALL findings related to employee sentiment here. For each finding: heading with title and severity tag, detail paragraph, full_analysis paragraph, source documents, and recommended action. Group by severity within this category (Critical first, then Warning, then Info). Do NOT compress any finding into a brief bullet.]

### Customer Perception
[Place ALL findings related to customer perception here. Same full per-finding treatment as above.]

### Brand & Social Media Presence
[Place ALL findings related to brand/social media here. Same full per-finding treatment.]

### Leadership & C-Suite Reputation
[Place ALL findings related to leadership here. Same full per-finding treatment.]

### News & Public Record
[Place ALL findings related to news/public record here. Same full per-finding treatment.]

### Deal Narrative vs. Reality Scorecard
| Category | Deal Team Claim | Public Signal | Alignment |
|----------|----------------|---------------|-----------|
[One row per finding — this table is a summary index, not a substitute for the full write-ups above. Every finding must appear both in its category section AND in this table.]

### Recommended Diligence Actions
[Consolidated numbered list drawn from findings above]`,

  ic_challenge_mode: `${REPORT_PREAMBLE}

Structure your report as:

## IC Challenge Questions

### Question 1 (Most Critical)
**Question**: [The question]
**Why It Matters**: [Context]
**Strong Answer Looks Like**: [What a good response contains]
**Weak Answer Looks Like**: [What an evasive response contains]
**Source**: [Which documents prompted this]

[Continue for all 8 questions, numbered by decreasing criticality]

### Overall Assessment
[Summary of deal team preparedness based on the materials]`,

  model_assumptions_stress: `${REPORT_PREAMBLE}

## NUMERIC VERIFICATION REQUIREMENT
A "## Numeric Verification Report" section in your input contains code-verified arithmetic results. You MUST:
- Present numeric discrepancies as dedicated findings (critical discrepancies = Critical Findings section)
- Cite the recomputed_value as the authoritative figure for any number you reference
- Never paraphrase or re-derive a code-verified figure from text
- State "[Code-Verified: X]" next to any figure drawn from the Numeric Verification Report

Structure your report as:

## Model Assumptions Stress Test

### Deal Team Model Overview
[Brief description of key model outputs: entry multiple, exit multiple, projected IRR/MOIC, holding period]

### Assumption Scorecard Summary
| Assumption | Deal Team Value | Historical / Benchmark | Rating | Impact if 20% Worse |
|------------|----------------|------------------------|--------|----------------------|
[One row per key assumption — one row per finding, not a subset]

### Critical Findings
[Place ALL findings with severity="critical" here. For EACH one: heading with title, the assumption being challenged, the benchmark/evidence contradicting it, quantified downside impact, and recommended action. Full paragraphs — no compression.]

### Elevated Findings
[Place ALL findings with severity="warning" here. Standard treatment: heading with [WARNING] tag, detail paragraph, condensed analysis (2-3 sentences), source docs.]

### Informational Findings
[Place ALL findings with severity="info" here. Brief treatment: heading with [INFO] tag, single paragraph combining detail and takeaway, source docs.]

### Key Sensitivities
[Which single assumption, if wrong, has the most impact on returns — drawn from the critical findings above]

### Recommended IC Questions
[Numbered list drawn from findings above]`,

  diligence_completeness: `${REPORT_PREAMBLE}

CRITICAL COVERAGE CAVEAT: Your scores must reflect ONLY the documents that were actually ingested and analyzed. If the "Data Room Coverage" section indicates that some documents were excluded (unsupported type, parse failure, or superseded), you MUST:
1. State explicitly which document categories MAY be underrepresented due to exclusions.
2. Note that the completeness score applies ONLY to the ingested subset, NOT to the full data room.
3. If excluded documents likely contained material for a dimension (e.g. a legal PDF that failed to parse), score that dimension lower and explain why.
Never claim or imply completeness over documents you did not ingest.

Structure your report as:

## Diligence Completeness Scorecard

### Coverage Basis
[State exactly how many documents were ingested vs. total in the data room. If any were excluded, list them here with reasons. This section is MANDATORY.]

### Overall Grade: [Letter] ([Average]/5.0)
*Note: This grade reflects coverage of ingested documents only.*

| Dimension | Score | Coverage Summary |
|-----------|-------|-----------------|
| Commercial | X/5 | ... |
| Financial/QoE | X/5 | ... |
| Management | X/5 | ... |
| Technology/Product | X/5 | ... |
| Legal/Regulatory | X/5 | ... |
| Competitive | X/5 | ... |
| Customer | X/5 | ... |
| Operational | X/5 | ... |
| Exit | X/5 | ... |
| ESG/Reputational | X/5 | ... |

### Critical Gaps (Score 1-2)
[Detailed analysis of each poorly-covered dimension — include whether excluded documents might have improved coverage]

### Adequate Coverage (Score 3-4)
[For each dimension scoring 3-4: heading, what evidence exists, what gaps remain]

### Strong Coverage (Score 5)
[For each dimension scoring 5: heading, what evidence confirms full coverage]

### What IC Is Approving Without Adequate Information
[Numbered list of blind spots — include gaps that may exist due to excluded documents]

### Recommended Pre-IC Actions
[Numbered list]`,

  executive_summary: `${REPORT_PREAMBLE}

This should read like a 1-page briefing suitable for printing. Be concise, direct, actionable.

Structure your report as:

## Executive Summary for IC

### Overall Assessment
[2-3 sentences on deal risk posture]

### Top Reasons to Invest
1. ...
2. ...
3. ...

### Top Risks
1. ...
2. ...
3. ...

### Finding Summary by Severity

#### Critical Findings (severity="critical")
[For each critical finding: one paragraph with title, key detail, and source. Do NOT omit any.]

#### Elevated Findings (severity="warning")
[For each warning finding: one paragraph with title, key detail, and source. Do NOT omit any.]

#### Informational Findings (severity="info")
[For each info finding: one paragraph with title and key detail. Do NOT omit any.]

### Cross-Module Patterns
[Themes that emerged across multiple analyses]

### IC Readiness Checklist
- [ ] [Item 1]
- [ ] [Item 2]
...

### Recommended IC Posture
[Approve / Approve with conditions / Defer / Decline, with reasoning]`,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeBraces(text: string): string {
  if (!text) return text;
  return text.replace(/\{/g, "\uFE5B").replace(/\}/g, "\uFE5C");
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
// API — Format the final markdown report (Step 2 of synthesis)
// ---------------------------------------------------------------------------
export default api({
  name: "FormatReport",
  description: "Formats prioritized findings into detailed IC markdown report via Opus",

  integrations: {
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    moduleId: z.string(),
    executiveHeader: z.string(),
    findings: z.array(FindingSchema),
    useOpus: z.boolean().optional(),
    coverageLine: z.string().nullable().optional(),
    numericReport: z.object({
      figures: z.array(z.any()),
      discrepancies: z.array(z.any()),
    }).nullable().optional(),
  }),

  output: z.object({
    fullReport: z.string(),
  }),

  async run(ctx, { moduleId, executiveHeader, findings, useOpus, coverageLine, numericReport }) {
    const reportPrompt = REPORT_PROMPTS[moduleId];
    if (!reportPrompt) {
      throw new Error(`Module "${moduleId}" report prompt not configured.`);
    }

    // Numeric report block for numeric-eligible modules
    let numericBlock = "";
    if (numericReport && NUMERIC_MODULES.has(moduleId) &&
        (numericReport.figures.length > 0 || numericReport.discrepancies.length > 0)) {
      const criticalDisc = numericReport.discrepancies.filter(
        (d: Record<string, unknown>) => d.severity === "critical"
      );
      const otherDisc = numericReport.discrepancies.filter(
        (d: Record<string, unknown>) => d.severity !== "critical"
      );

      numericBlock = `\n\n## Numeric Verification Report\n*Source: deterministic arithmetic engine — treat all values here as ground truth*\n\n`;

      if (numericReport.discrepancies.length > 0) {
        numericBlock += `### Flagged Discrepancies (${numericReport.discrepancies.length} total, ${criticalDisc.length} critical)\n`;
        for (const d of [...criticalDisc, ...otherDisc]) {
          const disc = d as Record<string, unknown>;
          numericBlock += `- **[${String(disc.severity).toUpperCase()}]** [check: ${String(disc.check_type)}] ${String(disc.description)}`;
          if (disc.expected != null && disc.actual != null) {
            numericBlock += ` (code-verified value: ${disc.expected}, reported: ${disc.actual})`;
          }
          numericBlock += `\n`;
        }
        numericBlock += `\n`;
      }

      if (numericReport.figures.length > 0) {
        numericBlock += `### Verified Figures (code-recomputed)\n`;
        for (const f of numericReport.figures.slice(0, 30)) {
          const fig = f as Record<string, unknown>;
          numericBlock += `- **${String(fig.name)}**: ${fig.recomputed_value} @ ${String(fig.source_cell)}`;
          if (fig.formula) numericBlock += ` [=${String(fig.formula)}]`;
          numericBlock += `\n`;
        }
      }
    }

    // Build the input for the report writer
    const findingsJson = sanitizeBraces(JSON.stringify(findings, null, 2));
    // Build coverage block if provided
    const coverageBlock = coverageLine
      ? `\n\n> **Coverage:** ${sanitizeBraces(coverageLine)}\n`
      : "";

    // If exclusions exist, prepend a note to the executive header
    const exclusionNote = coverageLine && coverageLine.includes("Excluded:")
      ? `\n\n**⚠ Note:** Not all documents in the data room were ingested. ${sanitizeBraces(coverageLine)}`
      : "";

    const criticalCount = findings.filter(f => f.severity === "critical").length;
    const warningCount = findings.filter(f => f.severity === "warning").length;
    const infoCount = findings.filter(f => f.severity === "info").length;

    const reportInput =
      `## Executive Header\n\n${sanitizeBraces(executiveHeader)}${exclusionNote}\n\n` +
      `## Data Room Coverage${coverageBlock}\n\n` +
      `## Findings (${findings.length} total: ${criticalCount} critical, ${warningCount} warning, ${infoCount} info)\n` +
      `**REMINDER: Your report must contain exactly ${findings.length} fully detailed write-ups — one per finding.**\n\n` +
      `${findingsJson}${sanitizeBraces(numericBlock)}`;

    const result = await ctx.integrations.ai.apiRequest(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: useOpus ? OPUS_MODEL : SONNET_MODEL,
          max_tokens: REPORT_MAX_TOKENS,
          system: [
            {
              type: "text",
              text: reportPrompt,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: reportInput }],
        },
      },
      { response: MessageResponseSchema },
      { label: "Coordinator Step 2: format detailed report" }
    );

    const textBlock = result.content.find(
      (c: { type: string }) => c.type === "text"
    );
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text content in report response");
    }

    // Prepend coverage line to the final report output
    let fullReport = textBlock.text;
    if (coverageLine) {
      fullReport = `> **Coverage:** ${coverageLine}\n\n${fullReport}`;
    }

    return { fullReport };
  },
});
