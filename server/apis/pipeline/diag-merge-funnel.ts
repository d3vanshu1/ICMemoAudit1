/**
 * Diagnostic API — Per-Round Merge Funnel
 *
 * Shows how findings are consolidated through each merge round:
 *   - Per tree_level: how many nodes, total findings going in, total coming out
 *   - Collapse ratio per round (findings_out / findings_in)
 *   - Identifies where the most aggressive deduplication happens
 *
 * Read-only: queries merge_checkpoints for a given run.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const MergeFunnelRowSchema = z.object({
  tree_level: z.coerce.number(),
  node_count: z.coerce.number(),
  total_findings: z.coerce.number(),
  min_findings: z.coerce.number(),
  max_findings: z.coerce.number(),
  total_bytes: z.coerce.number(),
});

const FunnelRoundSchema = z.object({
  treeLevel: z.number(),
  nodeCount: z.number(),
  totalFindings: z.number(),
  minFindings: z.number(),
  maxFindings: z.number(),
  totalBytes: z.number(),
  collapseRatio: z.number().nullable(),
});

export default api({
  name: "DiagMergeFunnel",
  description: "Shows per-round merge funnel: findings in vs out at each tree level",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    rounds: z.array(FunnelRoundSchema),
    totalLevels: z.number(),
    overallCollapseRatio: z.number().nullable().describe("Final findings / leaf findings"),
  }),

  async run(ctx, { runId }) {
    const rows = await ctx.integrations.db.query(
      `SELECT tree_level,
              COUNT(*)::int AS node_count,
              SUM(jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb)))::int AS total_findings,
              MIN(jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb)))::int AS min_findings,
              MAX(jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb)))::int AS max_findings,
              SUM(octet_length(merged_json::text))::int AS total_bytes
       FROM merge_checkpoints
       WHERE module_run_id = $1
       GROUP BY tree_level
       ORDER BY tree_level ASC`,
      MergeFunnelRowSchema,
      [runId],
      { label: "Diag: merge funnel by tree level" }
    );

    const rounds: Array<{
      treeLevel: number;
      nodeCount: number;
      totalFindings: number;
      minFindings: number;
      maxFindings: number;
      totalBytes: number;
      collapseRatio: number | null;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const previousFindings = i > 0 ? rows[i - 1].total_findings : null;
      const collapseRatio = previousFindings && previousFindings > 0
        ? Math.round((r.total_findings / previousFindings) * 100) / 100
        : null;
      rounds.push({
        treeLevel: r.tree_level,
        nodeCount: r.node_count,
        totalFindings: r.total_findings,
        minFindings: r.min_findings,
        maxFindings: r.max_findings,
        totalBytes: r.total_bytes,
        collapseRatio,
      });
    }

    const totalLevels = rounds.length;
    const leafFindings = rounds.length > 0 ? rounds[0].totalFindings : 0;
    const finalFindings = rounds.length > 0 ? rounds[rounds.length - 1].totalFindings : 0;
    const overallCollapseRatio = leafFindings > 0
      ? Math.round((finalFindings / leafFindings) * 100) / 100
      : null;

    return { rounds, totalLevels, overallCollapseRatio };
  },
});
