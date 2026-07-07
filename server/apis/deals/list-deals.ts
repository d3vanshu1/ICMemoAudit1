import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const DealRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sector: z.string().nullable(),
  status: z.string(),
  entry_ev: z.string().nullable(),
  entry_multiple: z.string().nullable(),
  equity_check: z.string().nullable(),
  ic_date: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  document_count: z.coerce.number(),
  total_findings: z.coerce.number(),
  critical_findings: z.coerce.number(),
});

export default api({
  name: "ListDeals",
  description: "Lists all deals with computed document and finding counts",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    search: z.string().nullable().optional(),
  }),

  output: z.object({
    deals: z.array(DealRowSchema),
  }),

  async run(ctx, { search }) {
    const deals = await ctx.integrations.db.query(
      `SELECT
        d.id, d.name, d.description, d.sector, d.status,
        d.entry_ev, d.entry_multiple, d.equity_check,
        d.ic_date, d.created_at, d.updated_at,
        COALESCE(doc_counts.cnt, 0) AS document_count,
        COALESCE(finding_counts.total, 0) AS total_findings,
        COALESCE(finding_counts.critical, 0) AS critical_findings
      FROM deals d
      LEFT JOIN (
        SELECT deal_id, COUNT(*) AS cnt
        FROM documents
        GROUP BY deal_id
      ) doc_counts ON doc_counts.deal_id = d.id
      LEFT JOIN (
        SELECT
          mr.deal_id,
          SUM(jsonb_array_length(mo.findings)) AS total,
          SUM((
            SELECT COUNT(*) FROM jsonb_array_elements(mo.findings) f
            WHERE f.value->>'severity' = 'critical'
          )) AS critical
        FROM module_runs mr
        JOIN module_outputs mo ON mo.module_run_id = mr.id
        WHERE mr.status = 'completed'
        GROUP BY mr.deal_id
      ) finding_counts ON finding_counts.deal_id = d.id
      WHERE ($1::text IS NULL OR d.name ILIKE '%' || $1 || '%')
      ORDER BY d.updated_at DESC
      LIMIT 100`,
      DealRowSchema,
      [search ?? null],
      { label: "List deals with counts" }
    );

    return { deals };
  },
});
