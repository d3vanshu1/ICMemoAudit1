/**
 * API wrapper for clean-parsed-text — exposes dry-run and live modes.
 * Invokes the cleanup phase and returns structured results for review.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { runCleanParsedTextPhase } from "./clean-parsed-text.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "CleanParsedTextDryRun",
  description: "Dry-run parsed_text cleanup — reports corruption and proposed trims without writing",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    /** If false, will actually write the cleaned text back. Default true (dry-run). */
    dryRun: z.boolean().default(true),
  }),

  output: z.object({
    corruptedCount: z.number(),
    totalBytesSaved: z.number(),
    applied: z.boolean(),
    partial: z.boolean(),
    documentsProcessed: z.number(),
    documentsTotal: z.number(),
    documents: z.array(z.object({
      documentId: z.string(),
      fileName: z.string(),
      originalSize: z.number(),
      cleanedSize: z.number(),
      bytesSaved: z.number(),
      hadCorruption: z.boolean(),
      sheets: z.array(z.object({
        sheetName: z.string(),
        originalColumnCount: z.number(),
        detectedBoundary: z.number(),
        columnsRemoved: z.number(),
        isCorrupted: z.boolean(),
        sampleBefore: z.array(z.string()),
        sampleAfter: z.array(z.string()),
      })),
    })),
  }),

  async run(ctx, { dealId, dryRun }) {
    // Diagnostic API — give it a generous budget (no pipeline constraints)
    const result = await runCleanParsedTextPhase(ctx.integrations.db, {
      dealId,
      dryRun,
      startTime: Date.now(),
      timeBudgetMs: 250_000, // 4m10s — generous for standalone diagnostic use
    });

    return result;
  },
});
