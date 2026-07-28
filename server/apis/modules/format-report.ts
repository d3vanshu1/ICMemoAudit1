import { api, z, anthropic } from "@superblocksteam/sdk-api";
import { NUMERIC_MODULES } from "./constants.js";
import { EFFECTIVE_CAP_MS } from "../pipeline/pipeline-config.js";

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
const SONNET_MODEL = "claude-sonnet-4-6";
const OPUS_MODEL = "claude-opus-4-7";
const REPORT_MAX_TOKENS = 12000;

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

{{FORMAT_NUMERIC_VERIFICATION_BLOCK}}

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

{{FORMAT_NUMERIC_VERIFICATION_BLOCK}}

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
// Bug 1 fix: Sanitize confidence language in findings against NumericVerify
// ---------------------------------------------------------------------------

/**
 * Confidence-language patterns that imply deterministic verification.
 * When a finding contains these but has no matching NumericVerify discrepancy,
 * the language must be hedged.
 */
const CONFIDENCE_PATTERNS = [
  /code-verified\s+(?:analysis|arithmetic\s+analysis)\s+(?:confirms?|identifies|reveals?|shows?|detects?|finds?)/gi,
  /code-verified\s+analysis/gi,
  /confirmed\s+(model\s+integrity|arithmetic|by\s+code|contradiction)/gi,
  /deterministic\s+(arithmetic|verification)/gi,
  /\[Code-Verified[^\]]*\]/gi,
  /code-recomputed/gi,
  /independently\s+verified/gi,
  /arithmetic\s+engine\s+confirms?/gi,
];

const CONFIDENCE_HEDGING_MAP: Array<{ pattern: RegExp; replacement: string }> = [
  // Broad "code-verified [qualifier] [verb]" — catches all LLM rephrasings
  { pattern: /code-verified\s+(?:arithmetic\s+)?analysis\s+(?:confirms?|identifies|reveals?|shows?|detects?|finds?)/gi, replacement: "analysis indicates" },
  // Standalone "code-verified analysis" without a following verb
  { pattern: /code-verified\s+analysis/gi, replacement: "document analysis" },
  { pattern: /confirmed\s+model\s+integrity\s+(?:failures?|issues?)/gi, replacement: "potential model integrity issues" },
  { pattern: /confirmed\s+arithmetic\s+(?:failures?|discrepancies?|errors?)/gi, replacement: "potential arithmetic discrepancies" },
  { pattern: /confirmed\s+by\s+code/gi, replacement: "flagged by analysis" },
  { pattern: /confirmed\s+(?:double-count|double\s+count)(?:ing)?/gi, replacement: "reported potential double-count" },
  { pattern: /confirmed\s+contradiction/gi, replacement: "potential contradiction" },
  { pattern: /\[Code-Verified:\s*[^\]]+\]/gi, replacement: "" },
  { pattern: /\[Code-Verified\]/gi, replacement: "" },
  { pattern: /code-recomputed/gi, replacement: "as reported" },
  { pattern: /deterministic\s+arithmetic\s+verification/gi, replacement: "document analysis" },
  { pattern: /deterministic\s+verification/gi, replacement: "analysis" },
  { pattern: /independently\s+verified/gi, replacement: "reported" },
  { pattern: /arithmetic\s+engine\s+confirms?/gi, replacement: "analysis flags" },
];

/**
 * Extract dollar amounts and percentages from a text string.
 * Returns normalized strings like "72000", "341004", "31.1".
 */
function extractNumericValues(text: string): Set<string> {
  const values = new Set<string>();
  // Dollar amounts: $72,000 or $341,004 or $144K
  const dollarRegex = /\$([\d,]+(?:\.\d+)?)[KkMmBb]?/g;
  let m;
  while ((m = dollarRegex.exec(text)) !== null) {
    values.add(m[1].replace(/,/g, ""));
  }
  // Plain numbers with commas: 72,000 or 8,194,662
  const numRegex = /\b([\d,]{4,})\b/g;
  while ((m = numRegex.exec(text)) !== null) {
    values.add(m[1].replace(/,/g, ""));
  }
  // Percentages: 31.1% or 617.43%
  const pctRegex = /([\d.]+)\s*%/g;
  while ((m = pctRegex.exec(text)) !== null) {
    values.add(m[1]);
  }
  return values;
}

/**
 * Check if a finding's numeric claims have backing in the NumericVerify output.
 * Returns true if at least one key numeric value from the finding appears in
 * the discrepancy descriptions, expected, or actual values.
 */
function findingHasNumericBacking(
  finding: { title: string; detail: string; full_analysis: string },
  discrepancies: Array<Record<string, unknown>>
): boolean {
  const findingValues = extractNumericValues(
    `${finding.title} ${finding.detail} ${finding.full_analysis}`
  );
  if (findingValues.size === 0) return false;

  // Build a set of all numeric values from discrepancies
  const discValues = new Set<string>();
  for (const d of discrepancies) {
    const desc = String(d.description || "");
    for (const v of extractNumericValues(desc)) discValues.add(v);
    if (d.expected != null) discValues.add(String(d.expected).replace(/,/g, ""));
    if (d.actual != null) discValues.add(String(d.actual).replace(/,/g, ""));
  }

  // Check if any finding numeric value appears in discrepancy values
  for (const v of findingValues) {
    if (discValues.has(v)) return true;
  }
  return false;
}

/**
 * Check if a text contains confidence language patterns.
 */
function hasConfidenceLanguage(text: string): boolean {
  return CONFIDENCE_PATTERNS.some(p => {
    p.lastIndex = 0;
    return p.test(text);
  });
}

/**
 * Rewrite confidence language in a string with hedged alternatives.
 */
function hedgeConfidenceLanguage(text: string): string {
  let result = text;
  for (const { pattern, replacement } of CONFIDENCE_HEDGING_MAP) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  // Clean up doubled spaces from removed tags
  result = result.replace(/  +/g, " ").trim();
  return result;
}

/**
 * Sanitize a finding's confidence language if it lacks NumericVerify backing.
 * Rewrites title, detail, and full_analysis with hedged language.
 * Also strips "Confirmed" from titles when unbacked.
 */
function sanitizeFinding(
  finding: { severity: string; title: string; detail: string; full_analysis: string; source_docs: string[]; claim_ids?: string[] },
  discrepancies: Array<Record<string, unknown>>
): typeof finding {
  const combined = `${finding.title} ${finding.detail} ${finding.full_analysis}`;
  if (!hasConfidenceLanguage(combined)) return finding;
  if (findingHasNumericBacking(finding, discrepancies)) return finding;

  // This finding uses confidence language but has no NumericVerify backing — hedge it
  let newTitle = hedgeConfidenceLanguage(finding.title);
  // Also replace "Confirmed" at the start of titles
  newTitle = newTitle.replace(/^Confirmed\s+/i, "Reported ");
  newTitle = newTitle.replace(/\bConfirmed\b/gi, "Reported");

  return {
    ...finding,
    title: newTitle,
    detail: hedgeConfidenceLanguage(finding.detail),
    full_analysis: hedgeConfidenceLanguage(finding.full_analysis),
  };
}

// ---------------------------------------------------------------------------
// Bug 1 fix (post-LLM pass): Sanitize LLM output for unbacked confidence
// ---------------------------------------------------------------------------

/**
 * Build a whitelist of numeric values that genuinely appear in NumericVerify
 * discrepancies. Only `[Code-Verified: X]` tags whose X normalizes to a
 * value in this set are allowed to survive.
 */
function buildVerifiedValueSet(discrepancies: Array<Record<string, unknown>>): Set<string> {
  const allowed = new Set<string>();
  for (const d of discrepancies) {
    if (d.expected != null) allowed.add(String(d.expected).replace(/,/g, ""));
    if (d.actual != null) allowed.add(String(d.actual).replace(/,/g, ""));
    const desc = String(d.description || "");
    for (const v of extractNumericValues(desc)) allowed.add(v);
  }
  return allowed;
}

/**
 * Post-LLM output sanitizer. Runs on the completed LLM report text to:
 * 1. Strip [Code-Verified: X] tags where X does not trace to a real NumericVerify value
 * 2. Strip bare [Code-Verified] tags entirely
 * 3. Hedge confidence language in sentences that reference figures not in NumericVerify
 *
 * This is the last-resort guard: the prompt tells the LLM not to do this, the pre-LLM
 * pass hedges the input findings, and this pass catches anything the LLM re-invents.
 */
function sanitizeReportOutput(
  report: string,
  discrepancies: Array<Record<string, unknown>>
): string {
  const verifiedValues = buildVerifiedValueSet(discrepancies);

  let result = report;

  // 1. Strip bare [Code-Verified] tags (no value inside)
  result = result.replace(/\[Code-Verified\]/gi, "");

  // 2. Check each [Code-Verified: X] tag — keep only if X contains a verified value
  result = result.replace(/\[Code-Verified:\s*([^\]]+)\]/gi, (_match, inner: string) => {
    const innerValues = extractNumericValues(inner);
    // If any value in the tag is actually from NumericVerify, keep it
    for (const v of innerValues) {
      if (verifiedValues.has(v)) return _match; // Keep — genuinely verified
    }
    // No match — strip the tag entirely
    return "";
  });

  // 3. Hedge remaining unbacked confidence language patterns in the report body.
  // We apply the same hedging map but only to sentences that don't reference verified values.
  // To avoid false positives on legitimate verified-value sentences, we process line by line.
  const lines = result.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!hasConfidenceLanguage(line)) continue;

    // Check if this line references any verified numeric value
    const lineValues = extractNumericValues(line);
    let hasVerifiedRef = false;
    for (const v of lineValues) {
      if (verifiedValues.has(v)) {
        hasVerifiedRef = true;
        break;
      }
    }

    // If the line has confidence language but no verified numeric reference, hedge it
    if (!hasVerifiedRef) {
      lines[i] = hedgeConfidenceLanguage(line);
    }
  }
  result = lines.join("\n");

  // Clean up doubled spaces from tag removal
  result = result.replace(/  +/g, " ");

  return result;
}

// ---------------------------------------------------------------------------
// Bug 2 fix: Code-generated Numeric Appendix (outside LLM control)
// ---------------------------------------------------------------------------

/**
 * Build a deterministic markdown appendix listing every NumericVerify
 * discrepancy verbatim. This section is appended AFTER the LLM output
 * and cannot be editorially dropped.
 */
function buildNumericAppendix(
  discrepancies: Array<Record<string, unknown>>,
  figures: Array<Record<string, unknown>>
): string {
  if (discrepancies.length === 0 && figures.length === 0) return "";

  const lines: string[] = [];
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Numeric Verification Appendix");
  lines.push("");
  lines.push("*This section is auto-generated from the deterministic arithmetic engine output. It is not editable by the report writer and includes every discrepancy found, regardless of severity.*");
  lines.push("");

  const critical = discrepancies.filter(d => d.severity === "critical");
  const warning = discrepancies.filter(d => d.severity === "warning");
  const info = discrepancies.filter(d => d.severity !== "critical" && d.severity !== "warning");

  if (critical.length > 0) {
    lines.push(`### Critical Discrepancies (${critical.length})`);
    lines.push("");
    lines.push("| # | Check Type | Description | Expected | Reported |");
    lines.push("|---|-----------|-------------|----------|----------|");
    for (let i = 0; i < critical.length; i++) {
      const d = critical[i];
      const expected = d.expected != null ? String(d.expected) : "—";
      const actual = d.actual != null ? String(d.actual) : "—";
      lines.push(`| ${i + 1} | ${String(d.check_type || "—")} | ${String(d.description || "—")} | ${expected} | ${actual} |`);
    }
    lines.push("");
  }

  if (warning.length > 0) {
    lines.push(`### Warning Discrepancies (${warning.length})`);
    lines.push("");
    lines.push("| # | Check Type | Description | Expected | Reported |");
    lines.push("|---|-----------|-------------|----------|----------|");
    for (let i = 0; i < warning.length; i++) {
      const d = warning[i];
      const expected = d.expected != null ? String(d.expected) : "—";
      const actual = d.actual != null ? String(d.actual) : "—";
      lines.push(`| ${i + 1} | ${String(d.check_type || "—")} | ${String(d.description || "—")} | ${expected} | ${actual} |`);
    }
    lines.push("");
  }

  if (info.length > 0) {
    lines.push(`### Other Discrepancies (${info.length})`);
    lines.push("");
    for (let i = 0; i < info.length; i++) {
      const d = info[i];
      lines.push(`${i + 1}. **[${String(d.severity || "info").toUpperCase()}]** ${String(d.description || "—")}`);
    }
    lines.push("");
  }

  if (figures.length > 0) {
    lines.push(`### Verified Figures (${figures.length})`);
    lines.push("");
    lines.push("| Figure | Value | Source Cell |");
    lines.push("|--------|-------|-------------|");
    for (const f of figures) {
      lines.push(`| ${String(f.name || "—")} | ${String(f.recomputed_value ?? "—")} | ${String(f.source_cell || "—")} |`);
    }
    lines.push("");
  }

  lines.push(`*${discrepancies.length} discrepancies total: ${critical.length} critical, ${warning.length} warning. ${figures.length} verified figures.*`);
  lines.push("");

  return lines.join("\n");
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
    useOpus: z.boolean().nullable().optional(),
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
    // Time-budget guard: ensure we return a partial report rather than being
    // killed mid-stream by the platform hard limit.
    const FORMAT_START_TIME = Date.now();
    // Derived from effective cap: leaves 100s margin under the platform kill.
    // At 600s cap → 500s format budget; at 300s cap → 200s budget.
    const FORMAT_TIME_BUDGET_MS = EFFECTIVE_CAP_MS - 100_000;

    let reportPrompt = REPORT_PROMPTS[moduleId];
    if (!reportPrompt) {
      throw new Error(`Module "${moduleId}" report prompt not configured.`);
    }

    // Determine whether real numeric verification data is available
    const hasNumericData = !!(numericReport && NUMERIC_MODULES.has(moduleId) &&
        (numericReport.figures.length > 0 || numericReport.discrepancies.length > 0));

    // Bug 1 fix: Sanitize finding confidence language against NumericVerify backing.
    // Any finding that uses "confirmed"/"code-verified" language but has no matching
    // NumericVerify discrepancy gets rewritten with hedged language BEFORE reaching the LLM.
    const discrepancies = (numericReport?.discrepancies ?? []) as Array<Record<string, unknown>>;
    const sanitizedFindings = findings.map(f => sanitizeFinding(f, discrepancies));

    // Fix #3: Conditionally strip or inject numeric verification instructions in the report prompt.
    if (hasNumericData) {
      const numericVerificationInstructions = `## NUMERIC VERIFICATION — TRUSTWORTHY VALUES
A "## Numeric Verification Report" section in your input contains cell values read directly from the financial model by code — NOT by AI inference. You MUST:
- Treat "Verified Figures" as trustworthy cell values — flag where narrative claims disagree
- "Cross-Version Divergences" compare a live model to a frozen reference; frame as "confirm intentional revision vs stale reference," not as asserted errors
- Cite specific values only when they appear in the Verified Figures list
- **NEVER** apply [Code-Verified] or [Code-Verified: X] tags — the concept is removed
- **NEVER** invent or re-derive figures; only cite values from the Verified Figures list
- When discussing cross-version divergences, use hedged framing: "the live model shows X while the frozen reference shows Y — assess whether this reflects an intentional update"
- If a finding discusses a dollar amount that does NOT appear in the Verified Figures list, treat it as a text-derived claim with hedged language`;
      reportPrompt = reportPrompt.replace("{{FORMAT_NUMERIC_VERIFICATION_BLOCK}}", numericVerificationInstructions);
    } else {
      // Fix #1: Belt-and-suspenders guard language for report formatting
      const noNumericGuard = `## IMPORTANT — NO CODE-VERIFIED DATA AVAILABLE
No deterministic numeric verification was performed for this analysis. All figures in the findings are derived from AI text interpretation. You MUST:
- NEVER use the phrases "code-verified", "[Code-Verified]", "[Code-Verified: X]", "confirmed by code", or "deterministic verification" in your report
- NEVER label any figure as independently verified or confirmed unless two source documents explicitly state the same number
- When citing a specific number, attribute it to its source document: "per the [document]" or "as stated in [document]"
- Use qualifiers like "approximately", "as reported", or "per the model" — do NOT imply independent arithmetic verification`;
      reportPrompt = reportPrompt.replace("{{FORMAT_NUMERIC_VERIFICATION_BLOCK}}", noNumericGuard);
    }

    // Numeric report block for numeric-eligible modules
    let numericBlock = "";
    if (numericReport && NUMERIC_MODULES.has(moduleId) &&
        (numericReport.figures.length > 0 || numericReport.discrepancies.length > 0)) {
      numericBlock = `\n\n## Numeric Verification Report\n*Source: deterministic cell-value reads from the financial model*\n\n`;

      if (numericReport.discrepancies.length > 0) {
        numericBlock += `### Cross-Version Divergences\n`;
        numericBlock += `*Differences between the live model and a frozen reference.*\n\n`;
        for (const d of numericReport.discrepancies) {
          const disc = d as Record<string, unknown>;
          numericBlock += `- **[${String(disc.severity).toUpperCase()}]** ${String(disc.description)}\n`;
        }
        numericBlock += `\n`;
      }

      if (numericReport.figures.length > 0) {
        numericBlock += `### Verified Figures (Trustworthy Cell Values)\n`;
        const MAX_FIG_DISPLAY = 200;
        const figuresArr = numericReport.figures as Array<Record<string, unknown>>;
        if (figuresArr.length > MAX_FIG_DISPLAY) {
          console.warn(`[format-report] numeric figures capped at ${MAX_FIG_DISPLAY} (had ${figuresArr.length})`);
        }
        for (const fig of figuresArr.slice(0, MAX_FIG_DISPLAY)) {
          numericBlock += `- **${String(fig.name)}** (${String(fig.period ?? "")}): ${fig.value ?? fig.recomputed_value} @ ${String(fig.source_cell)}\n`;
        }
      }
    }

    // Build the input for the report writer (use sanitized findings)
    const findingsJson = sanitizeBraces(JSON.stringify(sanitizedFindings, null, 2));
    // Build coverage block if provided
    const coverageBlock = coverageLine
      ? `\n\n> **Coverage:** ${sanitizeBraces(coverageLine)}\n`
      : "";

    // If exclusions exist, prepend a note to the executive header
    const exclusionNote = coverageLine && coverageLine.includes("Excluded:")
      ? `\n\n**⚠ Note:** Not all documents in the data room were ingested. ${sanitizeBraces(coverageLine)}`
      : "";

    const criticalCount = sanitizedFindings.filter(f => f.severity === "critical").length;
    const warningCount = sanitizedFindings.filter(f => f.severity === "warning").length;
    const infoCount = sanitizedFindings.filter(f => f.severity === "info").length;

    const reportInput =
      `## Executive Header\n\n${sanitizeBraces(executiveHeader)}${exclusionNote}\n\n` +
      `## Data Room Coverage${coverageBlock}\n\n` +
      `## Findings (${findings.length} total: ${criticalCount} critical, ${warningCount} warning, ${infoCount} info)\n` +
      `**REMINDER: Your report must contain exactly ${sanitizedFindings.length} fully detailed write-ups — one per finding.**\n\n` +
      `${findingsJson}${sanitizeBraces(numericBlock)}`;

    // --- Report generation with continuation on truncation ---
    const MAX_CONTINUATIONS = 2;
    // Default to Sonnet (3× faster) — Opus only when explicitly requested via useOpus flag
    const selectedModel = useOpus ? OPUS_MODEL : SONNET_MODEL;
    let accumulated = "";
    let truncated = false;

    const messages: Array<{ role: string; content: string }> = [
      { role: "user", content: reportInput },
    ];

    for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
      // Time-budget check: abort continuation if insufficient time remains
      const elapsedMs = Date.now() - FORMAT_START_TIME;
      const remainingMs = FORMAT_TIME_BUDGET_MS - elapsedMs;
      if (attempt > 0 && remainingMs < 60_000) {
        console.warn(
          `[FormatReport] Time budget exhausted after ${Math.round(elapsedMs / 1000)}s — ` +
          `skipping continuation ${attempt} (only ${Math.round(remainingMs / 1000)}s left)`
        );
        truncated = true;
        break;
      }

      const result = await ctx.integrations.ai.apiRequest(
        {
          method: "POST",
          path: "/v1/messages",
          body: {
            model: selectedModel,
            max_tokens: REPORT_MAX_TOKENS,
            system: [
              {
                type: "text",
                text: reportPrompt,
                cache_control: { type: "ephemeral" },
              },
            ],
            messages,
          },
        },
        { response: MessageResponseSchema },
        { label: `Format report${attempt > 0 ? ` (continuation ${attempt})` : ""}` }
      );

      const textBlock = result.content.find(
        (c: { type: string }) => c.type === "text"
      );
      if (!textBlock || textBlock.type !== "text") {
        if (accumulated.length > 0) break; // partial is better than nothing
        throw new Error("No text content in report response");
      }

      accumulated += textBlock.text;

      if (result.stop_reason !== "max_tokens") {
        // Completed normally
        truncated = false;
        break;
      }

      // Hit token limit — continue from where we left off
      truncated = true;
      if (attempt < MAX_CONTINUATIONS) {
        // Add assistant's partial response + user continuation prompt
        messages.push({ role: "assistant", content: accumulated });
        messages.push({
          role: "user",
          content: "Your response was cut off. Continue the report EXACTLY where you left off — do not repeat any text already written. Pick up mid-sentence if necessary.",
        });
      }
    }

    // If still truncated after all continuations, append a visible notice
    if (truncated) {
      accumulated += `\n\n---\n\n> ⚠️ **Report Truncated** — This report exceeded the maximum generation length (${REPORT_MAX_TOKENS} tokens × ${MAX_CONTINUATIONS + 1} passes). Some findings at the end may be missing or incomplete. Re-run with fewer documents or contact support.`;
    }

    // Prepend coverage line to the final report output
    let fullReport = accumulated;
    if (coverageLine) {
      fullReport = `> **Coverage:** ${coverageLine}\n\n${fullReport}`;
    }

    // Bug 1 fix (post-LLM pass): Sanitize any confidence language the LLM re-invented
    // despite the prompt guard. This is the critical second pass — the pre-LLM pass
    // hedges the input, but the LLM can still regenerate confidence language from context.
    if (hasNumericData) {
      fullReport = sanitizeReportOutput(fullReport, discrepancies);
    }

    // Bug 2 fix: Append deterministic Numeric Appendix (outside LLM control).
    // Lists every NumericVerify discrepancy verbatim — CRITICAL and WARNING both.
    // Cannot be editorially dropped by the LLM.
    if (hasNumericData) {
      const figures = (numericReport?.figures ?? []) as Array<Record<string, unknown>>;
      const appendix = buildNumericAppendix(discrepancies, figures);
      if (appendix) {
        fullReport += appendix;
      }
    }

    return { fullReport };
  },
});
