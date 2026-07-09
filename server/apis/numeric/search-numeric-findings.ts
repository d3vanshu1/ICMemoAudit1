import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "SearchNumericFindings",
  description: "Searches numeric report discrepancies and figures by keyword or check_type",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    moduleRunId: z.string().uuid(),
    query: z.enum([
      "summary",
      "critical_discrepancies",
      "cross_doc",
      "balance_sheet",
      "sign_consistency",
      "monotonicity",
    ]),
  }),

  output: z.object({
    totalFigures: z.number(),
    totalDiscrepancies: z.number(),
    criticalCount: z.number(),
    warningCount: z.number(),
    byCheckType: z.record(z.string(), z.number()),
    results: z.array(z.object({
      type: z.string(),
      description: z.string(),
      severity: z.string().optional(),
      expected: z.any().optional(),
      actual: z.any().optional(),
    })),
  }),

  async run(ctx, { moduleRunId, query }) {
    const ReportSchema = z.object({
      figures: z.any(),
      discrepancies: z.any(),
    });

    const rows = await ctx.integrations.db.query(
      `SELECT figures, discrepancies
       FROM numeric_reports
       WHERE module_run_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      ReportSchema,
      [moduleRunId],
      { label: "Load numeric report" }
    );

    if (rows.length === 0) {
      return {
        totalFigures: 0,
        totalDiscrepancies: 0,
        criticalCount: 0,
        warningCount: 0,
        byCheckType: {},
        results: [],
      };
    }

    const rawFigures = typeof rows[0].figures === "string" ? JSON.parse(rows[0].figures) : rows[0].figures;
    const rawDisc = typeof rows[0].discrepancies === "string" ? JSON.parse(rows[0].discrepancies) : rows[0].discrepancies;

    const figures = Array.isArray(rawFigures) ? rawFigures : [];
    const discrepancies = Array.isArray(rawDisc) ? rawDisc : [];

    const criticalCount = discrepancies.filter((d: any) => d.severity === "critical").length;
    const warningCount = discrepancies.filter((d: any) => d.severity === "warning").length;

    // Count by check_type
    const byCheckType: Record<string, number> = {};
    for (const d of discrepancies) {
      const ct = (d as any).check_type || "unknown";
      byCheckType[ct] = (byCheckType[ct] || 0) + 1;
    }

    type Result = { type: string; description: string; severity?: string; expected?: any; actual?: any };
    let results: Result[] = [];

    switch (query) {
      case "summary":
        // Return top 20 critical discrepancies
        results = discrepancies
          .filter((d: any) => d.severity === "critical")
          .slice(0, 20)
          .map((d: any) => ({
            type: d.check_type,
            description: d.description,
            severity: d.severity,
            expected: d.expected,
            actual: d.actual,
          }));
        break;

      case "critical_discrepancies":
        // Return unique critical discrepancies (dedup by description prefix)
        const seen = new Set<string>();
        for (const d of discrepancies) {
          if ((d as any).severity !== "critical") continue;
          const key = (d as any).description.slice(0, 80);
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({
            type: (d as any).check_type,
            description: (d as any).description,
            severity: (d as any).severity,
            expected: (d as any).expected,
            actual: (d as any).actual,
          });
          if (results.length >= 30) break;
        }
        break;

      case "cross_doc":
        results = discrepancies
          .filter((d: any) => d.check_type === "cross_doc_agreement")
          .slice(0, 30)
          .map((d: any) => ({
            type: d.check_type,
            description: d.description,
            severity: d.severity,
            expected: d.expected,
            actual: d.actual,
          }));
        break;

      case "balance_sheet":
        // Filter for IS/BS/CF sheets
        results = discrepancies
          .filter((d: any) => {
            const desc = (d.description || "").toLowerCase();
            return desc.includes("is, bs") || desc.includes("balance") || desc.includes("financial plan") ||
                   desc.includes("assets") || desc.includes("liabilities") || desc.includes("equity") ||
                   desc.includes("operating model");
          })
          .slice(0, 30)
          .map((d: any) => ({
            type: d.check_type,
            description: d.description,
            severity: d.severity,
            expected: d.expected,
            actual: d.actual,
          }));
        break;

      case "sign_consistency":
        results = discrepancies
          .filter((d: any) => d.check_type === "sign_consistency")
          .slice(0, 30)
          .map((d: any) => ({
            type: d.check_type,
            description: d.description,
            severity: d.severity,
            expected: d.expected,
            actual: d.actual,
          }));
        break;

      case "monotonicity":
        results = discrepancies
          .filter((d: any) => d.check_type === "monotonicity")
          .slice(0, 30)
          .map((d: any) => ({
            type: d.check_type,
            description: d.description,
            severity: d.severity,
          }));
        break;
    }

    return {
      totalFigures: figures.length,
      totalDiscrepancies: discrepancies.length,
      criticalCount,
      warningCount,
      byCheckType,
      results,
    };
  },
});
