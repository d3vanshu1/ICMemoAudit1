import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// Platform limits: single column value cannot exceed 10MB in the wire format.
// JSON encoding + escaping can expand raw text by ~2-3x in worst case (special chars, unicode).
// Use 2MB slices to stay safely under even with worst-case encoding overhead.
const SLICE_SIZE = 2_000_000; // 2MB per substring read
const WARN_THRESHOLD = 5_000_000; // Log warning above 5MB
const MAX_DOCUMENT_SIZE = 50_000_000; // Skip documents over 50MB (unreasonable for text analysis)

const DocMetaSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  file_type: z.string(),
  document_tag: z.string(),
  document_source: z.string().nullable(),
  text_length: z.coerce.number(),
});

const TextSliceSchema = z.object({
  text_slice: z.string(),
});

const DocTextOutputSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  file_type: z.string(),
  document_tag: z.string(),
  document_source: z.string().nullable(),
  parsed_text: z.string().nullable(),
  /** When parsed_text is null, indicates why: "too_large" | "load_error" | undefined (text exists) */
  skip_reason: z.enum(["too_large", "load_error"]).nullable().optional(),
});

export default api({
  name: "GetDocumentTexts",
  description: "Fetches parsed text for deal documents, with subject-ID exclusion for evidence retrieval",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    /** Exclude specific document IDs (e.g. the subject memo(s) chosen at run time). */
    excludeDocumentIds: z.array(z.string()).nullable().optional(),
  }),

  output: z.object({
    documents: z.array(DocTextOutputSchema),
    warnings: z.array(z.string()),
  }),

  async run(ctx, { dealId, excludeDocumentIds }) {
    const warnings: string[] = [];

    // Build dynamic WHERE filters
    let exclusionFilter = "";
    const params: unknown[] = [dealId];
    let paramIdx = 2; // $1 = dealId

    if (excludeDocumentIds && excludeDocumentIds.length > 0) {
      exclusionFilter += ` AND id != ALL($${paramIdx}::uuid[])`;
      params.push(excludeDocumentIds);
      paramIdx++;
    }

    // Step 1: Load metadata only (no parsed_text) — always succeeds regardless of text size
    const metas = await ctx.integrations.db.query(
      `SELECT id, file_name, file_type, document_tag, document_source,
              COALESCE(length(parsed_text), 0) AS text_length
       FROM documents
       WHERE deal_id = $1 AND parsed_text IS NOT NULL AND parsed_text != ''${exclusionFilter}
       ORDER BY uploaded_at DESC
       LIMIT 200`,
      DocMetaSchema,
      params,
      { label: "Load document metadata (no text)" }
    );

    if (metas.length === 0) {
      return { documents: [], warnings: [] };
    }

    // Step 2: Load text for each document individually
    const documents: z.infer<typeof DocTextOutputSchema>[] = [];

    for (const meta of metas) {
      if (meta.text_length > WARN_THRESHOLD) {
        warnings.push(`${meta.file_name}: large document (${(meta.text_length / 1_000_000).toFixed(1)}MB)`);
      }

      try {
        let parsedText: string;

        if (meta.text_length > MAX_DOCUMENT_SIZE) {
          warnings.push(`${meta.file_name}: SKIPPED — too large (${(meta.text_length / 1_000_000).toFixed(0)}MB exceeds 50MB limit)`);
          documents.push({
            id: meta.id,
            file_name: meta.file_name,
            file_type: meta.file_type,
            document_tag: meta.document_tag,
            document_source: meta.document_source,
            parsed_text: null,
            skip_reason: "too_large",
          });
          continue;
        }

        if (meta.text_length <= SLICE_SIZE) {
          // Small enough to load in one query
          const rows = await ctx.integrations.db.query(
            `SELECT parsed_text AS text_slice FROM documents WHERE id = $1`,
            TextSliceSchema,
            [meta.id],
            { label: `Load text: ${meta.file_name} (${(meta.text_length / 1000).toFixed(0)}KB)` }
          );
          parsedText = rows[0]?.text_slice ?? "";
        } else {
          // Large document — load in slices using substring()
          const slices: string[] = [];
          let offset = 1; // PostgreSQL substring is 1-indexed
          const totalSlices = Math.ceil(meta.text_length / SLICE_SIZE);

          for (let i = 0; i < totalSlices; i++) {
            const rows = await ctx.integrations.db.query(
              `SELECT substring(parsed_text FROM ${offset} FOR ${SLICE_SIZE}) AS text_slice
               FROM documents WHERE id = $1`,
              TextSliceSchema,
              [meta.id],
              { label: `Load slice ${i + 1}/${totalSlices}: ${meta.file_name}` }
            );
            const slice = rows[0]?.text_slice ?? "";
            if (slice.length === 0) break;
            slices.push(slice);
            offset += SLICE_SIZE;
          }

          parsedText = slices.join("");
          warnings.push(`${meta.file_name}: loaded in ${slices.length} slices (${(meta.text_length / 1_000_000).toFixed(1)}MB total)`);
        }

        documents.push({
          id: meta.id,
          file_name: meta.file_name,
          file_type: meta.file_type,
          document_tag: meta.document_tag,
          document_source: meta.document_source,
          parsed_text: parsedText,
        });
      } catch (err) {
        // Graceful degradation: skip this document but don't crash the pipeline
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`${meta.file_name}: SKIPPED — failed to load text (${msg})`);
        documents.push({
          id: meta.id,
          file_name: meta.file_name,
          file_type: meta.file_type,
          document_tag: meta.document_tag,
          document_source: meta.document_source,
          parsed_text: null,
          skip_reason: "load_error",
        });
      }
    }

    return { documents, warnings };
  },
});
