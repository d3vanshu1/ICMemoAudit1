/**
 * Diagnostic API — pulls the raw universal_extractions content for specific chunks.
 * Used to inspect what text the sub-agent saw before analysis.
 * NOT production code.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ExtractionRowSchema = z.object({
  chunk_index: z.coerce.number(),
  document_id: z.string(),
  file_name: z.string(),
  extraction_snippet: z.string(),
  extraction_length: z.coerce.number(),
});

export default api({
  name: "DiagnoseExtractionRaw",
  description: "Pulls raw universal_extractions content matching a keyword for a deal",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    searchTerm: z.string().describe("Keyword to search in extraction_json (ILIKE)"),
    contextChars: z.number().nullable().optional().describe("Chars to extract around match (default 1000)"),
    maxHits: z.number().nullable().optional(),
  }),

  output: z.object({
    hits: z.array(ExtractionRowSchema),
    hitCount: z.number(),
  }),

  async run(ctx, { dealId, searchTerm, contextChars, maxHits }) {
    const ctxChars = contextChars ?? 1000;
    const limit = maxHits ?? 5;
    const pattern = `%${searchTerm}%`;

    const rows = await ctx.integrations.db.query(
      `SELECT ue.chunk_index,
              ue.document_id,
              d.file_name,
              SUBSTRING(ue.extraction_json::text FROM GREATEST(1, POSITION(LOWER($2) IN LOWER(ue.extraction_json::text)) - ${Math.floor(ctxChars / 2)}) FOR ${ctxChars}) AS extraction_snippet,
              LENGTH(ue.extraction_json::text)::int AS extraction_length
       FROM universal_extractions ue
       JOIN documents d ON d.id = ue.document_id
       WHERE ue.deal_id = $1 AND ue.extraction_json::text ILIKE $3
       ORDER BY d.file_name, ue.chunk_index
       LIMIT ${limit}`,
      ExtractionRowSchema,
      [dealId, searchTerm, pattern],
      { label: "Search universal_extractions for keyword" }
    );

    return { hits: rows, hitCount: rows.length };
  },
});
