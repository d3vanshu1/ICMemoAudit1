import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const AuditRowSchema = z.object({
  run_id: z.string(),
  deal_id: z.string(),
  deal_name: z.string().nullable(),
  module_id: z.string(),
  status: z.string().nullable(),
  completed_at: z.string().nullable(),
  has_code_verified: z.coerce.number(),
  has_confirmed_language: z.coerce.number(),
  findings_have_code_verified: z.coerce.number(),
  report_length: z.coerce.number().nullable(),
  code_verified_count: z.coerce.number(),
  confirmed_count: z.coerce.number(),
});

export default api({
  name: "ReportLanguageAudit",
  description: "Audits all generated reports for false Code-Verified or confirmed language",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    runs: z.array(AuditRowSchema),
    totalRuns: z.coerce.number(),
    flaggedRuns: z.coerce.number(),
  }),

  async run(ctx) {
    const rows = await ctx.integrations.db.query(
      `SELECT
        mr.id AS run_id,
        mr.deal_id,
        d.name AS deal_name,
        mr.module_id,
        mr.status,
        mr.completed_at::text,
        CASE WHEN mo.full_report_markdown ILIKE '%code-verified%'
             OR mo.full_report_markdown ILIKE '%[code-verified%'
             THEN 1 ELSE 0 END AS has_code_verified,
        CASE WHEN mo.full_report_markdown ILIKE '%confirmed contradiction%'
             OR mo.full_report_markdown ILIKE '%confirmed by code%'
             OR mo.full_report_markdown ILIKE '%deterministic verification%'
             OR mo.full_report_markdown ILIKE '%deterministic arithmetic%'
             OR mo.full_report_markdown ILIKE '%code-recomputed%'
             THEN 1 ELSE 0 END AS has_confirmed_language,
        CASE WHEN mo.findings::text ILIKE '%code-verified%'
             OR mo.findings::text ILIKE '%confirmed by code%'
             OR mo.findings::text ILIKE '%code-recomputed%'
             THEN 1 ELSE 0 END AS findings_have_code_verified,
        length(mo.full_report_markdown) AS report_length,
        (length(mo.full_report_markdown) - length(replace(lower(mo.full_report_markdown), 'code-verified', ''))) / 13 AS code_verified_count,
        (length(mo.full_report_markdown) - length(replace(lower(mo.full_report_markdown), 'confirmed', ''))) / 9 AS confirmed_count
      FROM module_runs mr
      LEFT JOIN module_outputs mo ON mo.module_run_id = mr.id
      LEFT JOIN deals d ON d.id = mr.deal_id
      WHERE mo.full_report_markdown IS NOT NULL
      ORDER BY mr.completed_at DESC NULLS LAST
      LIMIT 10`,
      AuditRowSchema,
      [],
      { label: "Audit all reports for false Code-Verified language" }
    );

    const flagged = rows.filter(r => r.has_code_verified > 0 || r.has_confirmed_language > 0 || r.findings_have_code_verified > 0);

    return {
      runs: rows,
      totalRuns: rows.length,
      flaggedRuns: flagged.length,
    };
  },
});
