import { api, z, postgres } from "@superblocksteam/sdk-api";
import { buildMergedText } from "../modules/build-merged-text.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CheckpointRowSchema = z.object({
  tree_level: z.coerce.number(),
  node_index: z.coerce.number(),
  merged_json: z.any(),
});

export default api({
  name: "LoadMergeCheckpoints",
  description: "Loads all merge checkpoints (success + error) for a module run",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    moduleRunId: z.string(),
  }),

  output: z.object({
    checkpoints: z.array(
      z.object({
        treeLevel: z.number(),
        nodeIndex: z.number(),
        mergedNode: z.object({
          text: z.string().optional(),
          executiveHeader: z.string().optional(),
          findings: z.array(
            z.object({
              severity: z.enum(["critical", "warning", "info"]),
              title: z.string(),
              detail: z.string(),
              full_analysis: z.string(),
              source_docs: z.array(z.string()),
              claim_ids: z.array(z.string()).optional(),
            })
          ).optional(),
          error: z.string().optional(),
          failureCount: z.number().optional(),
          lastError: z.string().optional(),
          skippedAfterFailures: z.number().optional(),
          timestamp: z.string().optional(),
        }),
      })
    ),
  }),

  async run(ctx, { moduleRunId }) {
    const rows = await ctx.integrations.db.query(
      `SELECT tree_level, node_index, merged_json
       FROM merge_checkpoints
       WHERE module_run_id = $1
       ORDER BY tree_level, node_index
       LIMIT 500`,
      CheckpointRowSchema,
      [moduleRunId],
      { label: "Load merge checkpoints" }
    );

    const checkpoints = rows.map((row) => {
      const merged = typeof row.merged_json === "string"
        ? JSON.parse(row.merged_json)
        : row.merged_json;

      // If this is an error node, return it with diagnostic fields
      if (merged.error) {
        return {
          treeLevel: row.tree_level,
          nodeIndex: row.node_index,
          mergedNode: {
            error: String(merged.error),
            failureCount: merged.failureCount ?? undefined,
            timestamp: merged.timestamp ?? undefined,
          },
        };
      }

      const executiveHeader = String(merged.executiveHeader ?? "");
      const findings = Array.isArray(merged.findings)
        ? merged.findings.map((f: Record<string, unknown>) => ({
            severity:
              f.severity === "critical" || f.severity === "warning" || f.severity === "info"
                ? f.severity
                : "info",
            title: String(f.title ?? ""),
            detail: String(f.detail ?? ""),
            full_analysis: String(f.full_analysis ?? f.detail ?? ""),
            source_docs: Array.isArray(f.source_docs) ? f.source_docs.map(String) : [],
            ...(Array.isArray(f.claim_ids) && f.claim_ids.length > 0
              ? { claim_ids: f.claim_ids.map(String) }
              : {}),
          }))
        : [];

      // Reconstruct the text field from executiveHeader + findings.
      // SaveMergeCheckpoint strips the bulky text field to keep JSONB
      // writes fast; we rebuild it here using the shared buildMergedText()
      // to guarantee byte-for-byte parity with the original.
      const text = merged.text
        ? String(merged.text)
        : buildMergedText(executiveHeader, findings);

      return {
        treeLevel: row.tree_level,
        nodeIndex: row.node_index,
        mergedNode: {
          text,
          executiveHeader,
          findings,
          // Include diagnostic fields from fallback (skipped) checkpoints
          ...(merged.lastError ? { lastError: String(merged.lastError) } : {}),
          ...(merged.skippedAfterFailures ? { skippedAfterFailures: merged.skippedAfterFailures } : {}),
        },
      };
    });

    return { checkpoints };
  },
});
