import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ~2000 chars per chunk — small enough for precise retrieval, large enough for context
const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 200;

export default api({
  name: "IndexDocumentChunks",
  description: "Splits document text into searchable chunks for Q&A retrieval",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    documentId: z.string(),
    dealId: z.string(),
    fileName: z.string(),
    parsedText: z.string(),
  }),

  output: z.object({
    chunksCreated: z.number(),
  }),

  async run(ctx, { documentId, dealId, fileName, parsedText }) {
    // Delete any existing chunks for this document (re-index case)
    await ctx.integrations.db.execute(
      `DELETE FROM document_chunks WHERE document_id = $1`,
      [documentId],
      { label: "Clear existing chunks" }
    );

    if (!parsedText || parsedText.trim().length === 0) {
      return { chunksCreated: 0 };
    }

    // Split text into overlapping chunks
    const chunks: string[] = [];
    let start = 0;
    while (start < parsedText.length) {
      const end = Math.min(start + CHUNK_SIZE, parsedText.length);
      chunks.push(parsedText.slice(start, end));
      if (end >= parsedText.length) break;
      start = end - CHUNK_OVERLAP;
    }

    // Batch insert chunks
    for (let i = 0; i < chunks.length; i++) {
      await ctx.integrations.db.execute(
        `INSERT INTO document_chunks (document_id, deal_id, chunk_index, file_name, content)
         VALUES ($1, $2, $3, $4, $5)`,
        [documentId, dealId, i, fileName, chunks[i]],
        { label: `Insert chunk ${i + 1}/${chunks.length}` }
      );
    }

    return { chunksCreated: chunks.length };
  },
});
