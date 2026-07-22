import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const NumericReportRowSchema = z.object({
  id: z.string(),
  module_run_id: z.string(),
  figures: z.any(),
  discrepancies: z.any(),
  created_at: z.string(),
});

const FigureSchema = z.object({
  name: z.string(),
  recomputed_value: z.union([z.number(), z.string()]),
  source_doc: z.string(),
  source_cell: z.string(),
  formula: z.string().nullable().optional(),
});

const DiscrepancySchema = z.object({
  description: z.string(),
  severity: z.enum(["critical", "warning", "info"]),
  check_type: z.enum(["subtotal_reconciliation", "sign_consistency", "monotonicity", "cross_doc_agreement"]),
  sources: z.array(z.string()),
  expected: z.union([z.number(), z.string()]).nullable().optional(),
  actual: z.union([z.number(), z.string()]).nullable().optional(),
});

export default api({
  name: "GetNumericReport",
  description: "Loads the most recent numeric verification report for a module run",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    moduleRunId: z.string().uuid(),
  }),

  output: z.object({
    found: z.boolean(),
    numericReportId: z.string().nullable(),
    figures: z.array(FigureSchema),
    discrepancies: z.array(DiscrepancySchema),
    figureCount: z.number(),
    discrepancyCount: z.number(),
    criticalCount: z.number(),
  }),

  async run(ctx, { moduleRunId }) {
    const rows = await ctx.integrations.db.query(
      `SELECT id, module_run_id, figures, discrepancies, created_at
       FROM numeric_reports
       WHERE module_run_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      NumericReportRowSchema,
      [moduleRunId],
      { label: "Load numeric_reports for module run" }
    );

    if (rows.length === 0) {
      return {
        found: false,
        numericReportId: null,
        figures: [],
        discrepancies: [],
        figureCount: 0,
        discrepancyCount: 0,
        criticalCount: 0,
      };
    }

    const row = rows[0];

    let figures: z.infer<typeof FigureSchema>[] = [];
    let discrepancies: z.infer<typeof DiscrepancySchema>[] = [];

    try {
      const rawFigures = typeof row.figures === "string" ? JSON.parse(row.figures) : row.figures;
      const rawDisc = typeof row.discrepancies === "string" ? JSON.parse(row.discrepancies) : row.discrepancies;

      if (Array.isArray(rawFigures)) {
        figures = rawFigures.map((f: unknown) => FigureSchema.parse(f)).filter(Boolean);
      }
      if (Array.isArray(rawDisc)) {
        discrepancies = rawDisc.map((d: unknown) => DiscrepancySchema.parse(d)).filter(Boolean);
      }
    } catch {
      // Return with empty arrays if parsing fails
    }

    const criticalCount = discrepancies.filter((d) => d.severity === "critical").length;

    return {
      found: true,
      numericReportId: row.id,
      figures,
      discrepancies,
      figureCount: figures.length,
      discrepancyCount: discrepancies.length,
      criticalCount,
    };
  },
});
