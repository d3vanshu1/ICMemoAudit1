import { api, z, anthropic } from "@superblocksteam/sdk-api";

const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

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

export default api({
  name: "ExtractReportSnippets",
  description: "Re-runs FormatReport and extracts Code-Verified snippets for verification audit",

  integrations: {
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    moduleId: z.string(),
    executiveHeader: z.string(),
    findings: z.array(z.any()),
    numericReport: z.object({
      figures: z.array(z.any()),
      discrepancies: z.array(z.any()),
    }).nullable().optional(),
    searchTerms: z.array(z.string()).nullable().optional(),
  }),

  output: z.object({
    codeVerifiedSnippets: z.array(z.object({
      snippet: z.string(),
      lineContext: z.string(),
    })),
    nonVerifiedExcerpts: z.array(z.object({
      findingTitle: z.string(),
      excerpt: z.string(),
    })),
    totalCodeVerifiedCount: z.number(),
    reportPreview: z.string(),
    keywordHits: z.array(z.object({
      term: z.string(),
      count: z.number(),
      contexts: z.array(z.string()),
    })),
    sectionTitles: z.array(z.string()),
  }),

  async run(ctx, { moduleId, executiveHeader, findings, numericReport, searchTerms }) {
    // Import the format-report logic inline — we need to generate the same report
    // then extract snippets. For efficiency, we replicate the key logic here.

    const REPORT_PREAMBLE = `You are a senior investment committee advisor. You have already identified and prioritized findings. Now write the DETAILED MARKDOWN REPORT based on the structured findings provided.

## Your Input

You will receive:
1. An executive header (already written — do not rewrite it)
2. A JSON array of prioritized findings with severity, title, detail, full_analysis, and source_docs

## Critical Rule — Full Treatment for Every Finding

You receive N findings in the JSON array. Your report MUST contain exactly N fully detailed write-ups — one per finding. No finding may be omitted, compressed into a brief one-liner, folded into a bullet point, or split across multiple sections.

Treatment depth is proportional to severity:

**Critical findings** — full treatment (all 5 elements):
1. A **heading** with the finding title and severity tag
2. The **detail** paragraph
3. The **full_analysis** paragraph
4. **Source documents** cited
5. A **recommended action** specific to this finding

**Warning findings** — standard treatment (4 elements):
1. A **heading** with the finding title and severity tag
2. The **detail** paragraph
3. A **condensed analysis** (2-3 sentences)
4. **Source documents** cited

**Info findings** — brief treatment (3 elements):
1. A **heading** with the finding title and severity tag
2. A **single paragraph** combining the detail and key takeaway
3. **Source documents** cited

## Self-Check Before Responding

Before returning your report, count the fully detailed write-ups. If the count does not equal N, fix it.

## Output Format

Output ONLY the markdown report content. Start directly with the markdown.`;

    const hasNumericData = !!(numericReport &&
        (numericReport.figures.length > 0 || numericReport.discrepancies.length > 0));

    let numericInstructions = "";
    if (hasNumericData) {
      numericInstructions = `## NUMERIC VERIFICATION REQUIREMENT
A "## Numeric Verification Report" section in your input contains code-verified arithmetic results. You MUST:
- Present all numeric discrepancies and cross-doc figure mismatches as **Confirmed Contradictions** with the highest priority
- Cite the recomputed_value as the authoritative figure
- State "[Code-Verified: X]" next to any figure drawn from the Numeric Verification Report
- Never paraphrase or re-derive a code-verified figure from text
- Label these findings as: **SOURCE: Deterministic Arithmetic Verification**`;
    } else {
      numericInstructions = `## IMPORTANT — NO CODE-VERIFIED DATA AVAILABLE
No deterministic numeric verification was performed for this analysis. All figures in the findings are derived from AI text interpretation. You MUST:
- NEVER use the phrases "code-verified", "[Code-Verified]", "[Code-Verified: X]", "confirmed by code", or "deterministic verification" in your report
- NEVER label any figure as independently verified or confirmed unless two source documents explicitly state the same number
- When citing a specific number, attribute it to its source document
- Use qualifiers like "approximately", "as reported", or "per the model"`;
    }

    const reportPrompt = `${REPORT_PREAMBLE}

${numericInstructions}

Structure your report as:

## Narrative vs. Data Contradiction Report

### Critical Findings
[For EACH critical finding: heading with title, the narrative claim, the contradicting data point, sources, why it matters, and recommended action.]

### Elevated Findings
[For EACH warning finding: heading with [WARNING] tag, detail paragraph, condensed analysis, source docs.]

### Informational Findings
[For EACH info finding: heading with [INFO] tag, single paragraph, source docs.]

### Recommended Actions Summary
[Numbered list of next steps.]`;

    function sanitizeBraces(text: string): string {
      if (!text) return text;
      return text.replace(/\{/g, "\uFE5B").replace(/\}/g, "\uFE5C");
    }

    // Build numeric block
    let numericBlock = "";
    if (numericReport && (numericReport.figures.length > 0 || numericReport.discrepancies.length > 0)) {
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
      }
    }

    const findingsJson = sanitizeBraces(JSON.stringify(findings, null, 2));
    const criticalCount = findings.filter((f: Record<string, unknown>) => f.severity === "critical").length;
    const warningCount = findings.filter((f: Record<string, unknown>) => f.severity === "warning").length;
    const infoCount = findings.filter((f: Record<string, unknown>) => f.severity === "info").length;

    const reportInput =
      `## Executive Header\n\n${sanitizeBraces(executiveHeader)}\n\n` +
      `## Findings (${findings.length} total: ${criticalCount} critical, ${warningCount} warning, ${infoCount} info)\n` +
      `**REMINDER: Your report must contain exactly ${findings.length} fully detailed write-ups — one per finding.**\n\n` +
      `${findingsJson}${sanitizeBraces(numericBlock)}`;

    const result = await ctx.integrations.ai.apiRequest(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: "claude-sonnet-4-6",
          max_tokens: 16000,
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
      { label: "Generate report for snippet extraction" }
    );

    const textBlock = result.content.find(
      (c: { type: string }) => c.type === "text"
    );
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text content in report response");
    }

    const fullReport = textBlock.text;

    // Extract [Code-Verified snippets
    const codeVerifiedRegex = /\[Code-Verified[^\]]*\]/gi;
    const matches = fullReport.match(codeVerifiedRegex) || [];

    const codeVerifiedSnippets: { snippet: string; lineContext: string }[] = [];
    for (const match of matches) {
      const idx = fullReport.indexOf(match);
      const start = Math.max(0, idx - 150);
      const end = Math.min(fullReport.length, idx + match.length + 150);
      codeVerifiedSnippets.push({
        snippet: match,
        lineContext: fullReport.substring(start, end),
      });
    }

    // Extract non-verified excerpts (findings without Code-Verified)
    const nonVerifiedExcerpts: { findingTitle: string; excerpt: string }[] = [];
    const findingHeaders = fullReport.match(/####\s+[^\n]+/g) || [];
    for (const header of findingHeaders.slice(0, 12)) {
      const headerIdx = fullReport.indexOf(header);
      const nextHeaderIdx = fullReport.indexOf("####", headerIdx + header.length);
      const sectionEnd = nextHeaderIdx > 0 ? nextHeaderIdx : headerIdx + 800;
      const section = fullReport.substring(headerIdx, Math.min(sectionEnd, headerIdx + 800));
      const hasCodeVerified = /\[Code-Verified/i.test(section);
      if (!hasCodeVerified) {
        nonVerifiedExcerpts.push({
          findingTitle: header.replace(/^####\s+/, ""),
          excerpt: section.substring(0, 500),
        });
        if (nonVerifiedExcerpts.length >= 3) break;
      }
    }

    // Keyword search
    const keywordHits: { term: string; count: number; contexts: string[] }[] = [];
    for (const term of (searchTerms || [])) {
      const termLower = term.toLowerCase();
      const reportLower = fullReport.toLowerCase();
      let searchIdx = 0;
      const contexts: string[] = [];
      while (true) {
        const found = reportLower.indexOf(termLower, searchIdx);
        if (found === -1) break;
        const ctxStart = Math.max(0, found - 250);
        const ctxEnd = Math.min(fullReport.length, found + term.length + 250);
        contexts.push(fullReport.substring(ctxStart, ctxEnd));
        searchIdx = found + term.length;
        if (contexts.length >= 5) break;
      }
      keywordHits.push({ term, count: contexts.length, contexts });
    }

    // Extract section titles (### or #### headers)
    const sectionTitles = (fullReport.match(/^#{2,4}\s+.+$/gm) || []).map(h => h.trim());

    return {
      codeVerifiedSnippets,
      nonVerifiedExcerpts,
      totalCodeVerifiedCount: matches.length,
      reportPreview: fullReport.substring(0, 2000),
      keywordHits,
      sectionTitles,
    };
  },
});
