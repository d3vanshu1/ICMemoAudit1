/**
 * Diagnostic: counts sheet delimiters in a document's parsed_text.
 * Returns sheet names found.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CountSchema = z.object({ sheet_count: z.coerce.number() });
const SheetNameSchema = z.object({ sheet_name: z.string() });

export default api({
  name: "CountSheets",
  description: "Counts sheet delimiters in parsed_text for a document",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    documentId: z.string(),
  }),

  output: z.object({
    sheetCount: z.number(),
    sheetNames: z.array(z.string()),
  }),

  async run(ctx, { documentId }) {
    // Count occurrences of '--- Sheet: ' in parsed_text
    const countRows = await ctx.integrations.db.query(
      `SELECT (length(parsed_text) - length(replace(parsed_text, '--- Sheet: ', ''))) / length('--- Sheet: ') AS sheet_count
       FROM documents WHERE id = $1`,
      CountSchema,
      [documentId],
      { label: "Count sheet delimiters" }
    );
    const sheetCount = countRows[0]?.sheet_count ?? 0;

    // Extract sheet names using regexp_matches
    const nameRows = await ctx.integrations.db.query(
      `SELECT m[1] AS sheet_name
       FROM documents,
            LATERAL regexp_matches(parsed_text, '--- Sheet: (.+?) ---', 'g') AS m
       WHERE id = $1`,
      SheetNameSchema,
      [documentId],
      { label: "Extract sheet names" }
    );
    const sheetNames = nameRows.map(r => r.sheet_name);

    return { sheetCount, sheetNames };
  },
});
