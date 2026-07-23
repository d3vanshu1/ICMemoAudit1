import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const NodeSizeSchema = z.object({
  tree_level: z.coerce.number(),
  node_index: z.coerce.number(),
  findings_count: z.coerce.number(),
  findings_bytes: z.coerce.number(),
  total_row_bytes: z.coerce.number(),
});

export default api({
  name: "DiagMergeNodeSize",
  description: "Measures findings count and byte size of top merge checkpoint nodes",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    nodes: z.array(NodeSizeSchema),
  }),

  async run(ctx, { runId }) {
    const nodes = await ctx.integrations.db.query(
      `SELECT tree_level, node_index,
              jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb)) AS findings_count,
              octet_length(COALESCE(merged_json->'findings', '[]'::jsonb)::text) AS findings_bytes,
              octet_length(merged_json::text) AS total_row_bytes
       FROM merge_checkpoints
       WHERE module_run_id = $1
       ORDER BY tree_level DESC, node_index ASC
       LIMIT 5`,
      NodeSizeSchema,
      [runId],
      { label: "Diag: measure top merge node sizes" }
    );
    return { nodes };
  },
});
