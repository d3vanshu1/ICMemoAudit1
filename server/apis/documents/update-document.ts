import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "UpdateDocument",
  description: "Updates document tag and source metadata",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    documentId: z.string(),
    documentTag: z.string(),
    documentSource: z.string().nullable(),
  }),

  output: z.object({
    success: z.boolean(),
  }),

  async run(ctx, { documentId, documentTag, documentSource }) {
    await ctx.integrations.db.execute(
      `UPDATE documents SET document_tag = $1, document_source = $2 WHERE id = $3`,
      [documentTag, documentSource, documentId],
      { label: "Update document tag/source" }
    );

    return { success: true };
  },
});
