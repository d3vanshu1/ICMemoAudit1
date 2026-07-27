/**
 * Diagnostic: shows enriched col headers and period "2026" figures
 * from the numeric verify engine for a specific deal.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { runNumericVerifyInline } from "../pipeline/numeric-verify-inline.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "InspectEnrichedHeaders",
  description: "Diagnostic: returns enriched col headers and period-2026 figures from the engine",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string().uuid(),
    targetPeriod: z.string().default("2026"),
  }),

  output: z.object({
    figuresForPeriod: z.array(z.object({
      name: z.string(),
      period: z.string(),
      value: z.number(),
      source_sheet: z.string(),
      source_cell: z.string(),
    })),
    figureCountForPeriod: z.number(),
    totalFigureCount: z.number(),
    discrepancyPeriods: z.array(z.string()),
    discrepancyDetails: z.array(z.object({
      period: z.string(),
      metricCount: z.number(),
      metrics: z.array(z.object({
        label: z.string(),
        sourceA: z.number(),
        sourceB: z.number(),
        absDiff: z.number(),
        relDiffPct: z.number(),
      })),
    })),
    allPeriods: z.array(z.string()),
  }),

  async run(ctx, { dealId, targetPeriod }) {
    const result = await runNumericVerifyInline(ctx.integrations.db, dealId, 120_000);

    // Filter figures for the target period
    const figuresForPeriod = result.figures
      .filter(f => f.period === targetPeriod)
      .slice(0, 50)
      .map(f => ({
        name: f.name,
        period: f.period,
        value: f.value,
        source_sheet: f.source_sheet,
        source_cell: f.source_cell,
      }));

    // Collect all unique periods from figures
    const allPeriods = [...new Set(result.figures.map(f => f.period))].sort();

    // Collect discrepancy periods
    const discrepancyPeriods = result.discrepancies.map(d => d.period);

    // Collect discrepancy details (metrics per period)
    const discrepancyDetails = result.discrepancies.map(d => ({
      period: d.period,
      metricCount: d.metrics.length,
      metrics: d.metrics.slice(0, 25),
    }));

    return {
      figuresForPeriod,
      figureCountForPeriod: result.figures.filter(f => f.period === targetPeriod).length,
      totalFigureCount: result.figures.length,
      discrepancyPeriods,
      discrepancyDetails,
      allPeriods,
    };
  },
});
