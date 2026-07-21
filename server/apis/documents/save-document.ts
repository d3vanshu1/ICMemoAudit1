import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const SavedDocSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  uploaded_at: z.string(),
});

export default api({
  name: "SaveDocument",
  description: "Saves document metadata and parsed text after upload",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    fileName: z.string(),
    fileType: z.string(),
    documentTag: z.string(),
    documentSource: z.string().nullable().optional(),
    parsedText: z.string().nullable(),
  }),

  output: z.object({
    document: SavedDocSchema,
  }),

  async run(ctx, { dealId, fileName, fileType, documentTag, documentSource, parsedText }) {
    // Hard cap on parsedText to stay well under the 4MB gRPC payload limit.
    const MAX_PARSED_TEXT_CHARS = 3_500_000;
    let safeParsedText = parsedText;
    if (safeParsedText && safeParsedText.length > MAX_PARSED_TEXT_CHARS) {
      ctx.log.warn(
        `[SaveDocument] parsedText for "${fileName}" is ${safeParsedText.length} chars — truncating to ${MAX_PARSED_TEXT_CHARS}`
      );
      safeParsedText =
        safeParsedText.slice(0, MAX_PARSED_TEXT_CHARS) +
        "\n\n[…truncated: original text exceeded storage limit]";
    }

    // Also bump the deal's updated_at
    await ctx.integrations.db.execute(
      `UPDATE deals SET updated_at = now() WHERE id = $1`,
      [dealId],
      { label: "Bump deal updated_at" }
    );

    const rows = await ctx.integrations.db.query(
      `INSERT INTO documents (deal_id, file_name, file_type, document_tag, document_source, parsed_text)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, file_name, uploaded_at`,
      SavedDocSchema,
      [dealId, fileName, fileType, documentTag, documentSource ?? null, safeParsedText],
      { label: "Insert document" }
    );

    return { document: rows[0] };
  },
});
