import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * Temporary utility: extracts a substring chunk of a run's full_report_markdown.
 * Used to preserve evidence before purge (report is 233K, too large for single response).
 * Delete after evidence preservation is complete.
 */
export default api({
  name: "ExtractReportChunk",
  description: "Returns a substring chunk of a run's report markdown for evidence extraction",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    offset: z.number().describe("0-based character offset"),
    length: z.number().describe("Number of characters to return (max 50000)"),
  }),

  output: z.object({
    chunk: z.string(),
    totalLength: z.number(),
    offset: z.number(),
    chunkLength: z.number(),
  }),

  async run(ctx, { runId, offset, length }) {
    const safeLength = Math.min(length, 50000);

    const rows = await ctx.integrations.db.query(
      `SELECT
        length(full_report_markdown) AS total_length,
        substr(full_report_markdown, $2::int, $3::int) AS chunk
      FROM module_outputs
      WHERE module_run_id = $1
      LIMIT 1`,
      z.object({ total_length: z.coerce.number(), chunk: z.string() }),
      [runId, offset + 1, safeLength], // PostgreSQL substr is 1-based
      { label: `Extract report chunk: offset=${offset}, len=${safeLength}` }
    );

    if (rows.length === 0) {
      return { chunk: "", totalLength: 0, offset, chunkLength: 0 };
    }

    return {
      chunk: rows[0].chunk,
      totalLength: rows[0].total_length,
      offset,
      chunkLength: rows[0].chunk.length,
    };
  },
});
