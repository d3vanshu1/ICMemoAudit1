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

const ModuleStatusRowSchema = z.object({
  module_id: z.string(),
  run_id: z.string(),
  status: z.string(),
  triggered_at: z.string(),
  completed_at: z.string().nullable(),
  executive_header: z.string().nullable(),
  findings: z.any(), // JSONB — parsed below
  full_report_markdown: z.string().nullable(),
  output_created_at: z.string().nullable(),
});

export default api({
  name: "LoadModuleResults",
  description: "Loads the latest module run + output for each module of a deal",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    modules: z.array(
      z.object({
        moduleId: z.string(),
        latestRun: z.object({
          id: z.string(),
          status: z.string(),
          triggeredAt: z.string(),
          completedAt: z.string().nullable(),
        }),
        latestOutput: z
          .object({
            executiveHeader: z.string().nullable(),
            findings: z.array(FindingSchema),
            fullReport: z.string(),
            createdAt: z.string(),
          })
          .nullable(),
      })
    ),
  }),

  async run(ctx, { dealId }) {
    // Get the latest run per module with its output
    const rows = await ctx.integrations.db.query(
      `SELECT DISTINCT ON (mr.module_id)
        mr.module_id,
        mr.id AS run_id,
        mr.status,
        mr.triggered_at,
        mr.completed_at,
        mo.executive_header,
        mo.findings,
        mo.full_report_markdown,
        mo.created_at AS output_created_at
      FROM module_runs mr
      LEFT JOIN module_outputs mo ON mo.module_run_id = mr.id
      WHERE mr.deal_id = $1
      ORDER BY mr.module_id, mr.triggered_at DESC
      LIMIT 50`,
      ModuleStatusRowSchema,
      [dealId],
      { label: "Load latest module results" }
    );

    const modules = rows.map((row) => {
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

      return {
        moduleId: row.module_id,
        latestRun: {
          id: row.run_id,
          status: row.status,
          triggeredAt: row.triggered_at,
          completedAt: row.completed_at,
        },
        latestOutput:
          row.full_report_markdown != null
            ? {
                executiveHeader: row.executive_header,
                findings,
                fullReport: row.full_report_markdown,
                createdAt: row.output_created_at ?? row.completed_at ?? row.triggered_at,
              }
            : null,
      };
    });

    return { modules };
  },
});
