import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const FailedExtractionSchema = z.object({
  chunk_index: z.coerce.number(),
  document_id: z.string(),
  error_msg: z.string().nullable(),
  label: z.string().nullable(),
});

const SuccessfulExtractionSampleSchema = z.object({
  chunk_index: z.coerce.number(),
  document_id: z.string(),
  label: z.string().nullable(),
  extraction_length: z.coerce.number(),
});

const DocMetaSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  text_length: z.coerce.number(),
});

export default api({
  name: "DiagFailedExtractions",
  description: "Diagnostic: returns error_msg and metadata for failed extraction chunks",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    failedChunks: z.array(FailedExtractionSchema),
    successfulSample: z.array(SuccessfulExtractionSampleSchema),
    document: DocMetaSchema.nullable(),
  }),

  async run(ctx, { dealId }) {
    // Get all failed extractions
    const failed = await ctx.integrations.db.query(
      `SELECT chunk_index, document_id,
              extraction_json->>'error_msg' AS error_msg,
              extraction_json->>'label' AS label
       FROM universal_extractions
       WHERE deal_id = $1
         AND (extraction_json->>'failed')::boolean = true
       ORDER BY chunk_index
       LIMIT 10`,
      FailedExtractionSchema,
      [dealId],
      { label: "Get failed extractions" }
    );

    // Get the document these belong to
    let doc = null;
    if (failed.length > 0) {
      const docRows = await ctx.integrations.db.query(
        `SELECT id, file_name, LENGTH(parsed_text) AS text_length
         FROM documents WHERE id = $1 LIMIT 1`,
        DocMetaSchema,
        [failed[0].document_id],
        { label: "Get document metadata" }
      );
      doc = docRows[0] ?? null;
    }

    // Get a sample of successful extractions from the same document for comparison
    const successfulSample = failed.length > 0
      ? await ctx.integrations.db.query(
          `SELECT chunk_index, document_id,
                  extraction_json->>'label' AS label,
                  LENGTH(extraction_json->>'extraction') AS extraction_length
           FROM universal_extractions
           WHERE deal_id = $1
             AND document_id = $2
             AND COALESCE((extraction_json->>'failed')::boolean, false) = false
           ORDER BY chunk_index
           LIMIT 5`,
          SuccessfulExtractionSampleSchema,
          [dealId, failed[0].document_id],
          { label: "Get successful extraction sample for comparison" }
        )
      : [];

    return { failedChunks: failed, successfulSample, document: doc };
  },
});
