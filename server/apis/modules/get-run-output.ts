import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const FindingSchema = z.object({
  severity: z.enum(["critical", "warning", "info"]),
  title: z.string(),
  detail: z.string(),
  full_analysis: z.string(),
  source_docs: z.array(z.string()),
  claim_ids: z.array(z.string()).optional(),
});

const RunOutputRowSchema = z.object({
  run_id: z.string(),
  module_id: z.string(),
  status: z.string(),
  triggered_at: z.string(),
  completed_at: z.string().nullable(),
  documents_included: z.any(), // TEXT[]
  executive_header: z.string().nullable(),
  findings: z.any(), // JSONB
  full_report_markdown: z.string().nullable(),
});

export default api({
  name: "GetRunOutput",
  description: "Loads the full output (findings JSON + report) for a specific module run",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    run: z.object({
      id: z.string(),
      moduleId: z.string(),
      status: z.string(),
      triggeredAt: z.string(),
      completedAt: z.string().nullable(),
      documentsIncluded: z.array(z.string()),
    }).nullable(),
    output: z.object({
      executiveHeader: z.string(),
      findings: z.array(FindingSchema),
      fullReport: z.string(),
    }).nullable(),
  }),

  async run(ctx, { runId }) {
    const rows = await ctx.integrations.db.query(
      `SELECT
        mr.id AS run_id,
        mr.module_id,
        mr.status,
        mr.triggered_at,
        mr.completed_at,
        mr.documents_included,
        mo.executive_header,
        mo.findings,
        mo.full_report_markdown
      FROM module_runs mr
      LEFT JOIN module_outputs mo ON mo.module_run_id = mr.id
      WHERE mr.id = $1
      LIMIT 1`,
      RunOutputRowSchema,
      [runId],
      { label: "Get run output by ID" }
    );

    if (rows.length === 0) {
      return { run: null, output: null };
    }

    const row = rows[0];

    // Parse findings from JSONB
    let findings: Array<{
      severity: "critical" | "warning" | "info";
      title: string;
      detail: string;
      full_analysis: string;
      source_docs: string[];
    }> = [];

    if (row.findings) {
      const raw = typeof row.findings === "string" ? JSON.parse(row.findings) : row.findings;
      if (Array.isArray(raw)) {
        findings = raw.map((f: Record<string, unknown>) => ({
          severity:
            f.severity === "critical" || f.severity === "warning" || f.severity === "info"
              ? f.severity
              : "info",
          title: String(f.title ?? ""),
          detail: String(f.detail ?? ""),
          full_analysis: String(f.full_analysis ?? f.detail ?? ""),
          source_docs: Array.isArray(f.source_docs) ? f.source_docs.map(String) : [],
        }));
      }
    }

    const docsIncluded = Array.isArray(row.documents_included)
      ? row.documents_included.map(String)
      : [];

    return {
      run: {
        id: row.run_id,
        moduleId: row.module_id,
        status: row.status,
        triggeredAt: row.triggered_at,
        completedAt: row.completed_at,
        documentsIncluded: docsIncluded,
      },
      output: row.full_report_markdown != null
        ? {
            executiveHeader: row.executive_header ?? "",
            findings,
            fullReport: row.full_report_markdown,
          }
        : null,
    };
  },
});
