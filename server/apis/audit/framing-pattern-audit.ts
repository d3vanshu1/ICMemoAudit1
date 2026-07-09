import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * Deep audit for false-confidence framing patterns.
 *
 * Scans all saved reports for:
 * 1. Bare [Code-Verified] tags (no value inside brackets)
 * 2. "confirmed" / "code-verified analysis confirms" language
 * 3. "Deterministic Arithmetic Verification" SOURCE lines
 * 4. Cross-references each against whether a matching bracketed value
 *    (e.g. [Code-Verified: 13,721]) exists in the same finding section
 *
 * Also checks the findings JSON for confidence language injected at
 * the finding-generation stage (before FormatReport).
 */

const ReportRowSchema = z.object({
  run_id: z.string(),
  deal_id: z.string(),
  deal_name: z.string().nullable(),
  module_id: z.string(),
  completed_at: z.string().nullable(),
  report_text: z.string().nullable(),
  findings_text: z.string().nullable(),
});

const FlagSchema = z.object({
  pattern: z.string(),
  context: z.string(),
  sectionTitle: z.string().nullable(),
  hasMatchingBracketValue: z.boolean(),
});

const FindingFlagSchema = z.object({
  findingTitle: z.string(),
  pattern: z.string(),
  context: z.string(),
});

const AuditResultSchema = z.object({
  runId: z.string(),
  dealId: z.string(),
  dealName: z.string().nullable(),
  moduleId: z.string(),
  completedAt: z.string().nullable(),
  reportFlags: z.array(FlagSchema),
  findingFlags: z.array(FindingFlagSchema),
  totalBareCodeVerified: z.number(),
  totalValuedCodeVerified: z.number(),
  totalConfirmedLanguage: z.number(),
  totalDetArithSource: z.number(),
  isFlagged: z.boolean(),
});

export default api({
  name: "FramingPatternAudit",
  description: "Deep audit of all reports for false-confidence framing patterns",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    results: z.array(AuditResultSchema),
    totalReports: z.number(),
    totalFlagged: z.number(),
    summary: z.string(),
  }),

  async run(ctx) {
    const rows = await ctx.integrations.db.query(
      `SELECT
        mr.id AS run_id,
        mr.deal_id,
        d.name AS deal_name,
        mr.module_id,
        mr.completed_at::text,
        mo.full_report_markdown AS report_text,
        mo.findings::text AS findings_text
      FROM module_runs mr
      LEFT JOIN module_outputs mo ON mo.module_run_id = mr.id
      LEFT JOIN deals d ON d.id = mr.deal_id
      WHERE mo.full_report_markdown IS NOT NULL
      ORDER BY mr.completed_at DESC NULLS LAST
      LIMIT 50`,
      ReportRowSchema,
      [],
      { label: "Load all reports for framing audit" }
    );

    const results: z.infer<typeof AuditResultSchema>[] = [];

    for (const row of rows) {
      const report = row.report_text || "";
      const findingsText = row.findings_text || "";

      // --- REPORT-LEVEL SCAN ---

      // 1. Find bare [Code-Verified] tags (no value)
      const bareTagRegex = /\[Code-Verified\](?!\s*:)/gi;
      const bareMatches = [...report.matchAll(bareTagRegex)];

      // 2. Find valued [Code-Verified: X] tags
      const valuedTagRegex = /\[Code-Verified:\s*[^\]]+\]/gi;
      const valuedMatches = [...report.matchAll(valuedTagRegex)];

      // 3. Find confidence language patterns
      const confidencePatterns = [
        { regex: /code-verified\s+analysis\s+confirms?/gi, name: "code-verified analysis confirms" },
        { regex: /confirmed\s+(model\s+integrity|arithmetic|by\s+code|contradiction)/gi, name: "confirmed [qualifier]" },
        { regex: /SOURCE:\s*Deterministic\s+Arithmetic\s+Verification/gi, name: "SOURCE: Deterministic Arithmetic Verification" },
        { regex: /Deterministic\s+Arithmetic\s+(Verification|Engine)/gi, name: "Deterministic Arithmetic ref" },
      ];

      // Split report into sections by ### headers
      const sectionSplitRegex = /^(#{2,4}\s+.+)$/gm;
      const sectionHeaders = [...report.matchAll(sectionSplitRegex)];

      function findSectionTitle(idx: number): string | null {
        let closest: string | null = null;
        for (const h of sectionHeaders) {
          if (h.index != null && h.index <= idx) {
            closest = h[1].trim();
          }
        }
        return closest;
      }

      function sectionHasValuedTag(idx: number): boolean {
        // Check if the same section (between headers) contains a valued [Code-Verified: X] tag
        let sectionStart = 0;
        let sectionEnd = report.length;
        for (let i = 0; i < sectionHeaders.length; i++) {
          const hIdx = sectionHeaders[i].index ?? 0;
          if (hIdx <= idx) {
            sectionStart = hIdx;
            sectionEnd = i + 1 < sectionHeaders.length ? (sectionHeaders[i + 1].index ?? report.length) : report.length;
          }
        }
        const sectionText = report.substring(sectionStart, sectionEnd);
        return valuedTagRegex.test(sectionText);
      }

      const reportFlags: z.infer<typeof FlagSchema>[] = [];

      // Flag bare tags
      for (const m of bareMatches) {
        const idx = m.index ?? 0;
        const ctxStart = Math.max(0, idx - 120);
        const ctxEnd = Math.min(report.length, idx + (m[0]?.length ?? 0) + 120);
        // Reset regex lastIndex for sectionHasValuedTag
        valuedTagRegex.lastIndex = 0;
        reportFlags.push({
          pattern: "bare [Code-Verified] tag",
          context: report.substring(ctxStart, ctxEnd),
          sectionTitle: findSectionTitle(idx),
          hasMatchingBracketValue: sectionHasValuedTag(idx),
        });
      }

      // Flag confidence language
      let totalConfirmedLang = 0;
      let totalDetArithSource = 0;
      for (const cp of confidencePatterns) {
        cp.regex.lastIndex = 0;
        const cpMatches = [...report.matchAll(cp.regex)];
        for (const m of cpMatches) {
          const idx = m.index ?? 0;
          const ctxStart = Math.max(0, idx - 120);
          const ctxEnd = Math.min(report.length, idx + (m[0]?.length ?? 0) + 120);
          valuedTagRegex.lastIndex = 0;
          const hasMatching = sectionHasValuedTag(idx);
          reportFlags.push({
            pattern: cp.name,
            context: report.substring(ctxStart, ctxEnd),
            sectionTitle: findSectionTitle(idx),
            hasMatchingBracketValue: hasMatching,
          });
          if (cp.name.includes("Deterministic")) totalDetArithSource++;
          else totalConfirmedLang++;
        }
      }

      // --- FINDINGS-LEVEL SCAN ---
      // Check if the raw findings JSON contains confidence language
      // (injected at finding-generation stage, before FormatReport)
      const findingFlags: z.infer<typeof FindingFlagSchema>[] = [];

      if (findingsText && findingsText.length > 2) {
        try {
          const findings = JSON.parse(findingsText);
          if (Array.isArray(findings)) {
            for (const f of findings) {
              const title = String(f.title || "");
              const detail = String(f.detail || "");
              const fullAnalysis = String(f.full_analysis || "");
              const combined = `${title} | ${detail} | ${fullAnalysis}`;

              const findingPatterns = [
                /code-verified/i,
                /confirmed\s+(by\s+code|model\s+integrity|arithmetic|contradiction)/i,
                /deterministic\s+(arithmetic|verification)/i,
                /\[Code-Verified[^\]]*\]/i,
              ];

              for (const fp of findingPatterns) {
                const match = combined.match(fp);
                if (match) {
                  const matchIdx = combined.indexOf(match[0]);
                  const ctxStart = Math.max(0, matchIdx - 80);
                  const ctxEnd = Math.min(combined.length, matchIdx + match[0].length + 80);
                  findingFlags.push({
                    findingTitle: title,
                    pattern: match[0],
                    context: combined.substring(ctxStart, ctxEnd),
                  });
                }
              }
            }
          }
        } catch {
          // findings_text isn't valid JSON — skip
        }
      }

      const isFlagged = reportFlags.some(f => !f.hasMatchingBracketValue) || findingFlags.length > 0;

      results.push({
        runId: row.run_id,
        dealId: row.deal_id,
        dealName: row.deal_name,
        moduleId: row.module_id,
        completedAt: row.completed_at,
        reportFlags,
        findingFlags,
        totalBareCodeVerified: bareMatches.length,
        totalValuedCodeVerified: valuedMatches.length,
        totalConfirmedLanguage: totalConfirmedLang,
        totalDetArithSource: totalDetArithSource,
        isFlagged,
      });
    }

    const totalFlagged = results.filter(r => r.isFlagged).length;

    const summary = results
      .filter(r => r.isFlagged)
      .map(r => {
        const unbacked = r.reportFlags.filter(f => !f.hasMatchingBracketValue);
        return `${r.dealName || r.dealId} / ${r.moduleId} (run ${r.runId.substring(0, 8)}): ` +
          `${r.totalBareCodeVerified} bare tags, ${r.totalValuedCodeVerified} valued tags, ` +
          `${unbacked.length} unbacked confidence patterns, ` +
          `${r.findingFlags.length} finding-level flags`;
      })
      .join("\n");

    return {
      results,
      totalReports: rows.length,
      totalFlagged,
      summary: summary || "No flagged reports found.",
    };
  },
});
