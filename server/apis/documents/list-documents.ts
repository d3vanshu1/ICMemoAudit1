import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const DocumentRowSchema = z.object({
  id: z.string(),
  deal_id: z.string(),
  file_name: z.string(),
  file_type: z.string(),
  document_tag: z.string(),
  document_source: z.string().nullable(),
  uploaded_at: z.string(),
  parsed_text_length: z.coerce.number(),
});

export default api({
  name: "ListDocuments",
  description: "Lists documents for a deal with parsed text length",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    documents: z.array(DocumentRowSchema),
  }),

  async run(ctx, { dealId }) {
    const documents = await ctx.integrations.db.query(
      `SELECT
        id, deal_id, file_name, file_type, document_tag, document_source,
        uploaded_at, LENGTH(parsed_text) AS parsed_text_length
      FROM documents
      WHERE deal_id = $1
      ORDER BY uploaded_at DESC
      LIMIT 200`,
      DocumentRowSchema,
      [dealId],
      { label: "List documents for deal" }
    );

    return { documents };
  },
});
