/**
 * Diagnostic: shows enriched col headers and tiered cross-agreement output
 * from the numeric verify engine for a specific deal.
 *
 * Returns three-tier structure per period:
 *   Tier 1 — Headline finding (plain-language)
 *   Tier 2 — Material movements (aggregate lines above materiality floor)
 *   Tier 3 — Full detail (all remaining divergences)
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { runNumericVerifyInline } from "../pipeline/numeric-verify-inline.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const MetricSchema = z.object({
  label: z.string(),
  sourceA: z.number(),
  sourceB: z.number(),
  absDiff: z.number(),
  relDiffPct: z.number(),
  tier: z.enum(["material", "detail"]),
  isAggregate: z.boolean(),
  isDuplicateLabel: z.boolean(),
});

export default api({
  name: "InspectEnrichedHeaders",
  description: "Diagnostic: returns tiered cross-agreement output from the engine",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string().uuid(),
    targetPeriod: z.string().default("2026"),
  }),

  output: z.object({
    periods: z.array(z.object({
      period: z.string(),
      headline: z.string(),
      materialityFloor: z.object({ abs: z.number(), rel: z.number() }),
      totalMetrics: z.number(),
      materialCount: z.number(),
      detailCount: z.number(),
      materialMovements: z.array(MetricSchema),
      detailLines: z.array(MetricSchema),
    })),
    allPeriods: z.array(z.string()),
    totalFigureCount: z.number(),
  }),

  async run(ctx, { dealId, targetPeriod }) {
    const result = await runNumericVerifyInline(ctx.integrations.db, dealId, 120_000);

    // Collect all unique periods from figures
    const allPeriods = [...new Set(result.figures.map(f => f.period))].sort();

    // Build three-tier output per discrepancy period
    const periods = result.discrepancies.map(d => {
      const materialMovements = d.metrics.filter(m => m.tier === "material");
      const detailLines = d.metrics.filter(m => m.tier === "detail");

      return {
        period: d.period,
        headline: d.headline,
        materialityFloor: d.materialityFloor,
        totalMetrics: d.metrics.length,
        materialCount: materialMovements.length,
        detailCount: detailLines.length,
        materialMovements,
        detailLines,
      };
    });

    return {
      periods,
      allPeriods,
      totalFigureCount: result.figures.length,
    };
  },
});
