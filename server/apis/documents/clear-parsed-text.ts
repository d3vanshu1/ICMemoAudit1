import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const DocIdSchema = z.object({ id: z.string() });

export default api({
  name: "ClearParsedText",
  description: "Clears parsed_text for all documents in a deal, requiring re-upload",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string().uuid(),
  }),

  output: z.object({
    documentsCleared: z.number(),
  }),

  async run(ctx, { dealId }) {
    // RLS workaround: UPDATE by deal_id returns 0 rows on this table,
    // but UPDATE by id works. So fetch IDs first, then update each.
    const docs = await ctx.integrations.db.query(
      `SELECT id FROM documents WHERE deal_id = $1 AND parsed_text != ''`,
      DocIdSchema,
      [dealId],
      { label: "Fetch document IDs to clear" }
    );

    let cleared = 0;
    for (const doc of docs) {
      await ctx.integrations.db.execute(
        `UPDATE documents SET parsed_text = '' WHERE id = $1`,
        [doc.id],
        { label: `Clear parsed_text for doc ${doc.id.slice(0, 8)}` }
      );
      cleared++;
    }

    return { documentsCleared: cleared };
  },
});
