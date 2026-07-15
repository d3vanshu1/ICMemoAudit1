/**
 * Diagnostic API — samples parsed_text from spreadsheet documents to identify
 * the corruption signature (phantom columns). NOT production code — delete after use.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const TextSliceSchema = z.object({ text_slice: z.string() });

export default api({
  name: "DiagnoseParsedText",
  description: "Samples parsed_text from spreadsheet docs to inspect corruption pattern",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    documentId: z.string(),
    // Which byte offset to sample from (1-indexed, postgres style)
    offset: z.number().default(1),
    // How many chars to read
    length: z.number().default(5000),
  }),

  output: z.object({
    sample: z.string(),
    totalLength: z.number(),
  }),

  async run(ctx, { documentId, offset, length }) {
    const metaRows = await ctx.integrations.db.query(
      `SELECT COALESCE(length(parsed_text), 0) AS text_slice FROM documents WHERE id = $1`,
      z.object({ text_slice: z.coerce.number() }),
      [documentId],
      { label: "Get text length" }
    );
    const totalLength = metaRows[0]?.text_slice ?? 0;

    const rows = await ctx.integrations.db.query(
      `SELECT substring(parsed_text FROM ${offset} FOR ${length}) AS text_slice
       FROM documents WHERE id = $1`,
      TextSliceSchema,
      [documentId],
      { label: `Sample text at offset ${offset}` }
    );

    return {
      sample: rows[0]?.text_slice ?? "",
      totalLength,
    };
  },
});
