import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "SaveMergeCheckpoint",
  description: "Persists a merge tree node (success or error) to merge_checkpoints",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    moduleRunId: z.string(),
    treeLevel: z.number(),
    nodeIndex: z.number(),
    // Either a successful merge result or an error — stored as JSONB
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
    }),
  }),

  output: z.object({
    saved: z.boolean(),
  }),

  async run(ctx, { moduleRunId, treeLevel, nodeIndex, mergedNode }) {
    // Strip the bulky "text" field before persisting — it's a formatted
    // serialization of executiveHeader + findings and is reconstructed
    // on load.  With 4-way merges this field can exceed 50 KB per
    // checkpoint, causing slow JSONB TOAST writes (25-57 s observed).
    const { text: _stripped, ...compactNode } = mergedNode as Record<string, unknown>;

    await ctx.integrations.db.execute(
      `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (module_run_id, tree_level, node_index)
       DO UPDATE SET merged_json = EXCLUDED.merged_json,
                     updated_at = now()`,
      [moduleRunId, treeLevel, nodeIndex, JSON.stringify(compactNode)],
      { label: `Save merge checkpoint L${treeLevel} N${nodeIndex}` }
    );

    return { saved: true };
  },
});
