import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagnoseRunEvidence",
  description: "Raw evidence queries for a specific run: module_outputs, merge_checkpoints breakdown, pipeline_analysis count.",
  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },
  input: z.object({
    runId: z.string(),
    alsoCheckRunId: z.string().nullable().optional(),
    fetchMergeLevel: z.number().nullable().optional(),
  }),
  output: z.object({
    moduleOutputsQuery: z.object({
      sql: z.string(),
      params: z.array(z.string()),
      rowCount: z.number(),
      rows: z.array(z.record(z.unknown())),
    }),
    mergeCheckpointsQuery: z.object({
      sql: z.string(),
      params: z.array(z.string()),
      rowCount: z.number(),
      rows: z.array(z.object({
        tree_level: z.coerce.number(),
        node_count: z.coerce.number(),
        total_json_size: z.coerce.number(),
      })),
    }),
    pipelineAnalysisCount: z.object({
      sql: z.string(),
      params: z.array(z.string()),
      count: z.coerce.number(),
    }),
    moduleRunRow: z.object({
      sql: z.string(),
      params: z.array(z.string()),
      rows: z.array(z.record(z.unknown())),
    }),
    mergeLevelContent: z.object({
      sql: z.string(),
      params: z.array(z.any()),
      rows: z.array(z.object({
        node_index: z.coerce.number(),
        merged_json: z.string(),
      })),
    }).nullable(),
    alsoRunOutputs: z.object({
      sql: z.string(),
      params: z.array(z.string()),
      rowCount: z.number(),
      reportLength: z.number().nullable(),
      reportFirst500: z.string().nullable(),
      pipelineAnalysisCount: z.number(),
    }).nullable(),
    absenceVerification: z.object({
      rowCount: z.number(),
      rows: z.array(z.object({
        finding_index: z.coerce.number(),
        verdict_json: z.any(),
        model_used: z.string().nullable(),
      })),
    }).nullable(),
    promptVersionSample: z.object({
      analysis_version: z.string().nullable(),
      merge_version: z.string().nullable(),
    }).nullable(),
  }),
  async run(ctx, { runId, alsoCheckRunId, fetchMergeLevel }) {
    // Query 1: module_outputs — does a row exist?
    const moSql = `SELECT module_run_id, created_at, length(full_report_markdown) AS report_length
                   FROM module_outputs
                   WHERE module_run_id = $1
                   LIMIT 1`;
    const moRows = await ctx.integrations.db.query(
      moSql,
      z.record(z.unknown()),
      [runId],
      { label: "module_outputs for run" }
    );

    // Query 2: merge_checkpoints tree_level breakdown
    const mcSql = `SELECT tree_level,
                          COUNT(*)::int AS node_count,
                          SUM(length(merged_json::text))::int AS total_json_size
                   FROM merge_checkpoints
                   WHERE module_run_id = $1
                   GROUP BY tree_level
                   ORDER BY tree_level`;
    const mcRows = await ctx.integrations.db.query(
      mcSql,
      z.object({
        tree_level: z.coerce.number(),
        node_count: z.coerce.number(),
        total_json_size: z.coerce.number(),
      }),
      [runId],
      { label: "merge_checkpoints breakdown" }
    );

    // Query 3: pipeline_analysis count
    const paSql = `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis WHERE run_id = $1`;
    const paRows = await ctx.integrations.db.query(
      paSql,
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "pipeline_analysis count" }
    );

    // Query 4: module_runs row
    const mrSql = `SELECT id, module_id, status, triggered_at, completed_at
                   FROM module_runs
                   WHERE id = $1
                   LIMIT 1`;
    const mrRows = await ctx.integrations.db.query(
      mrSql,
      z.record(z.unknown()),
      [runId],
      { label: "module_runs row" }
    );

    return {
      moduleOutputsQuery: {
        sql: moSql.trim(),
        params: [runId],
        rowCount: moRows.length,
        rows: moRows,
      },
      mergeCheckpointsQuery: {
        sql: mcSql.trim(),
        params: [runId],
        rowCount: mcRows.length,
        rows: mcRows,
      },
      pipelineAnalysisCount: {
        sql: paSql.trim(),
        params: [runId],
        count: paRows[0]?.cnt ?? 0,
      },
      moduleRunRow: {
        sql: mrSql.trim(),
        params: [runId],
        rows: mrRows,
      },
      mergeLevelContent: fetchMergeLevel != null ? await (async () => {
        const mlSql = `SELECT node_index, merged_json::text AS merged_json
                       FROM merge_checkpoints
                       WHERE module_run_id = $1 AND tree_level = $2
                       ORDER BY node_index`;
        const mlRows = await ctx.integrations.db.query(
          mlSql,
          z.object({ node_index: z.coerce.number(), merged_json: z.string() }),
          [runId, fetchMergeLevel],
          { label: "merge level content" }
        );
        return { sql: mlSql.trim(), params: [runId, fetchMergeLevel], rows: mlRows };
      })() : null,
      absenceVerification: await (async () => {
        try {
          const avRows = await ctx.integrations.db.query(
            `SELECT finding_index, verdict_json, model_used
             FROM absence_verification_checkpoints
             WHERE module_run_id = $1
             ORDER BY finding_index
             LIMIT 10`,
            z.object({
              finding_index: z.coerce.number(),
              verdict_json: z.any(),
              model_used: z.string().nullable(),
            }),
            [runId],
            { label: "absence verification checkpoints" }
          );
          return { rowCount: avRows.length, rows: avRows };
        } catch {
          return null;
        }
      })(),
      promptVersionSample: await (async () => {
        try {
          const pvRows = await ctx.integrations.db.query(
            `SELECT prompt_version FROM pipeline_analysis WHERE run_id = $1 AND prompt_version IS NOT NULL LIMIT 1`,
            z.object({ prompt_version: z.string().nullable() }),
            [runId],
            { label: "prompt_version sample from analysis" }
          );
          const mvRows = await ctx.integrations.db.query(
            `SELECT prompt_version FROM merge_checkpoints WHERE module_run_id = $1 AND prompt_version IS NOT NULL LIMIT 1`,
            z.object({ prompt_version: z.string().nullable() }),
            [runId],
            { label: "prompt_version sample from merge" }
          );
          return {
            analysis_version: pvRows[0]?.prompt_version ?? null,
            merge_version: mvRows[0]?.prompt_version ?? null,
          };
        } catch {
          return null;
        }
      })(),
      alsoRunOutputs: alsoCheckRunId ? await (async () => {
        const arSql = `SELECT module_run_id, created_at, length(full_report_markdown) AS report_length,
                              left(full_report_markdown, 500) AS report_first_500
                       FROM module_outputs
                       WHERE module_run_id = $1
                       LIMIT 1`;
        const arRows = await ctx.integrations.db.query(
          arSql,
          z.object({
            module_run_id: z.string(),
            created_at: z.string().nullable(),
            report_length: z.coerce.number().nullable(),
            report_first_500: z.string().nullable(),
          }),
          [alsoCheckRunId],
          { label: "also-check run outputs" }
        );
        const arPaSql = `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis WHERE run_id = $1`;
        const arPaRows = await ctx.integrations.db.query(
          arPaSql,
          z.object({ cnt: z.coerce.number() }),
          [alsoCheckRunId],
          { label: "also-check pipeline_analysis count" }
        );
        return {
          sql: arSql.trim(),
          params: [alsoCheckRunId],
          rowCount: arRows.length,
          reportLength: arRows[0]?.report_length ?? null,
          reportFirst500: arRows[0]?.report_first_500 ?? null,
          pipelineAnalysisCount: arPaRows[0]?.cnt ?? 0,
        };
      })() : null,
    };
  },
});
