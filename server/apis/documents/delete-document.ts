import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DeleteDocument",
  description: "Deletes a document from the database",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    documentId: z.string(),
  }),

  output: z.object({
    success: z.boolean(),
  }),

  async run(ctx, { documentId }) {
    await ctx.integrations.db.execute(
      `DELETE FROM documents WHERE id = $1`,
      [documentId],
      { label: "Delete document" }
    );

    return { success: true };
  },
});
