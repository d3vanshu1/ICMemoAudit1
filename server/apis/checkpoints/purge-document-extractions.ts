import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CountSchema = z.object({ count: z.coerce.number() });

export default api({
  name: "PurgeDocumentExtractions",
  description: "Purges universal_extractions for specific documents so the next pipeline run re-extracts from updated parsed_text",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    documentIds: z.array(z.string()).min(1),
  }),

  output: z.object({
    extractionsDeleted: z.number(),
  }),

  async run(ctx, { documentIds }) {
    // Count existing extractions for these documents
    const [{ count }] = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS count FROM universal_extractions WHERE document_id = ANY($1::uuid[])`,
      CountSchema,
      [documentIds],
      { label: "Count extractions for target documents" }
    );

    if (count === 0) {
      ctx.log.info(`[PurgeDocumentExtractions] No extractions to purge for ${documentIds.length} document(s)`);
      return { extractionsDeleted: 0 };
    }

    // Delete extractions scoped to these documents only
    await ctx.integrations.db.execute(
      `DELETE FROM universal_extractions WHERE document_id = ANY($1::uuid[])`,
      [documentIds],
      { label: `Purge extractions for ${documentIds.length} document(s)` }
    );

    ctx.log.info(
      `[PurgeDocumentExtractions] Purged ${count} extraction(s) for ${documentIds.length} document(s)`
    );

    return { extractionsDeleted: count };
  },
});
