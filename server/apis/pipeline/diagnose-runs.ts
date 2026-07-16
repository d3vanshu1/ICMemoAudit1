/**
 * Diagnostic API — shows recent module_runs for a deal.
 * NOT production code — used to inspect stuck/stale pipeline state.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const RunRowSchema = z.object({
  id: z.string(),
  module_id: z.string(),
  status: z.string(),
  triggered_at: z.string(),
  completed_at: z.string().nullable(),
});

const MergeCheckpointSchema = z.object({
  tree_level: z.coerce.number(),
  node_index: z.coerce.number(),
  json_size: z.coerce.number(),
  error: z.string().nullable(),
  failure_count: z.string().nullable(),
  header: z.string().nullable(),
});

// Time-bucketed extraction writes — reveals overlapping invocations
const ExtractionBucketSchema = z.object({
  bucket: z.string(),
  writes: z.coerce.number(),
  failed: z.coerce.number(),
  truncated: z.coerce.number(),
});

export default api({
  name: "DiagnoseRuns",
  description: "Shows recent module_runs for a deal to diagnose stuck pipelines",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    runs: z.array(RunRowSchema),
    analysisCount: z.number().optional(),
    mergeCheckpoints: z.array(MergeCheckpointSchema).optional(),
    // Extraction write timeline: 30s buckets showing writes per window
    // Multiple high-count buckets within ~200s = overlapping invocations
    extractionTimeline: z.array(ExtractionBucketSchema).optional(),
    // Concurrency check: writes_before_triggered > 0 means a prior invocation
    // was still writing AFTER the current invocation started (= overlap)
    concurrencyCheck: z.object({
      current_triggered_at: z.string().nullable(),
      writes_after_triggered: z.coerce.number(),
      earliest_write_after: z.string().nullable(),
      latest_write_after: z.string().nullable(),
      writes_before_triggered: z.coerce.number(),
    }).nullable().optional(),
    chunkStatus: z.array(z.object({
      document_id: z.string(),
      chunk_index: z.coerce.number(),
      file_name: z.string(),
      doc_text_length: z.coerce.number(),
      status: z.string(),
      error_msg: z.string().nullable(),
      json_size: z.coerce.number(),
      last_write: z.string(),
    })).optional(),
    chunkSummary: z.object({
      total: z.number(),
      successful: z.number(),
      failed: z.number(),
      truncated: z.number(),
    }).optional(),
  }),

  async run(ctx, { dealId }) {
    const runs = await ctx.integrations.db.query(
      `SELECT id, module_id, status,
              triggered_at::text, completed_at::text
       FROM module_runs
       WHERE deal_id = $1
       ORDER BY triggered_at DESC
       LIMIT 10`,
      RunRowSchema,
      [dealId],
      { label: "Recent module runs" }
    );

    // Check analysis checkpoint count for the most recent running run
    const runningRun = runs.find(r => r.status === "running");
    let analysisCount: number | undefined;
    let mergeCheckpoints: z.infer<typeof MergeCheckpointSchema>[] | undefined;
    if (runningRun) {
      const countRows = await ctx.integrations.db.query(
        `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis WHERE run_id = $1`,
        z.object({ cnt: z.number() }),
        [runningRun.id],
        { label: "Count analysis checkpoints" }
      );
      analysisCount = countRows[0]?.cnt ?? 0;

      // Get merge checkpoint details
      mergeCheckpoints = await ctx.integrations.db.query(
        `SELECT tree_level, node_index,
                LENGTH(merged_json::text) AS json_size,
                merged_json->>'error' AS error,
                merged_json->>'failureCount' AS failure_count,
                SUBSTRING(merged_json->>'executiveHeader', 1, 80) AS header
         FROM merge_checkpoints
         WHERE module_run_id = $1
         ORDER BY tree_level, node_index
         LIMIT 10`,
        MergeCheckpointSchema,
        [runningRun.id],
        { label: "Merge checkpoint details" }
      );
    }

    // Extraction write timeline (30s buckets) — detect overlapping invocations.
    // If two invocations run simultaneously, you'll see two bursts of 8 writes
    // landing in the same or adjacent 30s windows (normal is max 8 per window).
    const extractionTimeline = await ctx.integrations.db.query(
      `SELECT
         date_trunc('minute', created_at) +
           (EXTRACT(second FROM created_at)::int / 30 * interval '30 seconds') AS bucket,
         COUNT(*)::int AS writes,
         COUNT(*) FILTER (WHERE (extraction_json->>'failed')::boolean IS TRUE)::int AS failed,
         COUNT(*) FILTER (WHERE (extraction_json->>'truncated')::boolean IS TRUE)::int AS truncated
       FROM universal_extractions
       WHERE deal_id = $1
         AND created_at >= now() - interval '6 hours'
       GROUP BY 1
       ORDER BY 1 DESC
       LIMIT 50`,
      ExtractionBucketSchema,
      [dealId],
      { label: "Extraction write timeline (30s buckets)" }
    );

    // Check for concurrent invocations: look at the gap between triggered_at
    // timestamps. The pipeline updates triggered_at at the start of each invocation.
    // If invocations are properly sequential (one finishes, then re-invoked),
    // gaps should be ~200-210s. Gaps much shorter than that (< 60s) suggest overlap.
    // We can also check: are there extraction writes happening RIGHT NOW that
    // started before the current triggered_at? That means a prior invocation is
    // still writing while a new one already started.
    const concurrencyCheck = await ctx.integrations.db.query(
      `SELECT
         (SELECT triggered_at FROM module_runs WHERE id = $2) AS current_triggered_at,
         COUNT(*)::int AS writes_after_triggered,
         MIN(created_at)::text AS earliest_write_after,
         MAX(created_at)::text AS latest_write_after,
         COUNT(*) FILTER (WHERE created_at < (SELECT triggered_at FROM module_runs WHERE id = $2))::int AS writes_before_triggered
       FROM universal_extractions
       WHERE deal_id = $1
         AND created_at >= now() - interval '5 minutes'`,
      z.object({
        current_triggered_at: z.string().nullable(),
        writes_after_triggered: z.coerce.number(),
        earliest_write_after: z.string().nullable(),
        latest_write_after: z.string().nullable(),
        writes_before_triggered: z.coerce.number(),
      }),
      [dealId, runningRun?.id ?? "00000000-0000-0000-0000-000000000000"],
      { label: "Concurrency check" }
    );

    // Per-chunk extraction status: which chunks are failed/truncated/successful?
    // Join with documents to get source text lengths for comparison.
    const chunkStatus = await ctx.integrations.db.query(
      `SELECT
         ue.document_id,
         ue.chunk_index,
         d.file_name,
         COALESCE(length(d.parsed_text), 0) AS doc_text_length,
         CASE
           WHEN (ue.extraction_json->>'failed')::boolean IS TRUE THEN 'failed'
           WHEN (ue.extraction_json->>'truncated')::boolean IS TRUE THEN 'truncated'
           ELSE 'success'
         END AS status,
         COALESCE(ue.extraction_json->>'error_msg', ue.extraction_json->>'error') AS error_msg,
         LENGTH(ue.extraction_json::text) AS json_size,
         ue.created_at::text AS last_write
       FROM universal_extractions ue
       JOIN documents d ON d.id = ue.document_id
       WHERE ue.deal_id = $1
       ORDER BY ue.document_id, ue.chunk_index
       LIMIT 200`,
      z.object({
        document_id: z.string(),
        chunk_index: z.coerce.number(),
        file_name: z.string(),
        doc_text_length: z.coerce.number(),
        status: z.string(),
        error_msg: z.string().nullable(),
        json_size: z.coerce.number(),
        last_write: z.string(),
      }),
      [dealId],
      { label: "Per-chunk extraction status" }
    );

    // Summarize: group by status, show source lengths
    const summary = {
      total: chunkStatus.length,
      successful: chunkStatus.filter(c => c.status === "success").length,
      failed: chunkStatus.filter(c => c.status === "failed").length,
      truncated: chunkStatus.filter(c => c.status === "truncated").length,
    };

    return {
      runs,
      analysisCount,
      mergeCheckpoints,
      extractionTimeline,
      concurrencyCheck: concurrencyCheck[0] ?? null,
      chunkStatus,
      chunkSummary: summary,
    };
  },
});
