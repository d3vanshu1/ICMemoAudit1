import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "UpdateParsedText",
  description: "Updates parsed_text for an existing document after re-parsing",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    documentId: z.string(),
    parsedText: z.string(),
  }),

  output: z.object({
    success: z.boolean(),
    charCount: z.number(),
  }),

  async run(ctx, { documentId, parsedText }) {
    const MAX_PARSED_TEXT_CHARS = 3_500_000;
    let safeParsedText = parsedText;
    if (safeParsedText.length > MAX_PARSED_TEXT_CHARS) {
      ctx.log.warn(
        `[UpdateParsedText] parsedText for doc ${documentId} is ${safeParsedText.length} chars — truncating to ${MAX_PARSED_TEXT_CHARS}`
      );
      safeParsedText =
        safeParsedText.slice(0, MAX_PARSED_TEXT_CHARS) +
        "\n\n[…truncated: original text exceeded storage limit]";
    }

    await ctx.integrations.db.execute(
      `UPDATE documents SET parsed_text = $1 WHERE id = $2`,
      [safeParsedText, documentId],
      { label: "Update parsed_text after re-parse" }
    );

    ctx.log.info(
      `[UpdateParsedText] Updated doc ${documentId}: ${safeParsedText.length} chars`
    );

    return { success: true, charCount: safeParsedText.length };
  },
});
