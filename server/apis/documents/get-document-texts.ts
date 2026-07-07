import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const DocTextSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  file_type: z.string(),
  document_tag: z.string(),
  document_source: z.string().nullable(),
  parsed_text: z.string().nullable(),
});

export default api({
  name: "GetDocumentTexts",
  description: "Fetches parsed text content for all documents in a deal",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    documents: z.array(DocTextSchema),
  }),

  async run(ctx, { dealId }) {
    const documents = await ctx.integrations.db.query(
      `SELECT id, file_name, file_type, document_tag, document_source, parsed_text
       FROM documents
       WHERE deal_id = $1 AND parsed_text IS NOT NULL AND parsed_text != ''
       ORDER BY uploaded_at DESC
       LIMIT 200`,
      DocTextSchema,
      [dealId],
      { label: "Fetch document texts for deal" }
    );

    return { documents };
  },
});
