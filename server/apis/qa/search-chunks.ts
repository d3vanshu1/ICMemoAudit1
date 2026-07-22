import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ChunkResultSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  chunk_index: z.number(),
  content: z.string(),
  rank: z.number(),
});

export default api({
  name: "SearchChunks",
  description: "Full-text search over document chunks for a deal",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    query: z.string(),
    limit: z.number().nullable().optional(),
  }),

  output: z.object({
    chunks: z.array(ChunkResultSchema),
  }),

  async run(ctx, { dealId, query, limit }) {
    const maxResults = limit ?? 20;

    // Build a tsquery from the user's question.
    // plainto_tsquery handles natural language; we also try a prefix-match
    // variant with websearch_to_tsquery for partial-word matching.
    const chunks = await ctx.integrations.db.query(
      `SELECT
         id,
         file_name,
         chunk_index,
         content,
         ts_rank_cd(tsv, q) AS rank
       FROM document_chunks,
            websearch_to_tsquery('english', $2) q
       WHERE deal_id = $1
         AND tsv @@ q
       ORDER BY rank DESC
       LIMIT $3`,
      ChunkResultSchema,
      [dealId, query, maxResults],
      { label: "Full-text search document chunks" }
    );

    return { chunks };
  },
});
