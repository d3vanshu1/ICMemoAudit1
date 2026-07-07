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

const SavedRunSchema = z.object({
  run_id: z.string(),
  output_id: z.string(),
});

export default api({
  name: "SaveModuleResult",
  description: "Saves a completed module run and its output to the database",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    moduleId: z.string(),
    executiveHeader: z.string(),
    findings: z.array(FindingSchema),
    fullReport: z.string(),
    documentsIncluded: z.array(z.string()).optional(),
  }),

  output: z.object({
    result: SavedRunSchema,
  }),

  async run(ctx, { dealId, moduleId, executiveHeader, findings, fullReport, documentsIncluded }) {
    // Create a completed module run
    const runRows = await ctx.integrations.db.query(
      `INSERT INTO module_runs (deal_id, module_id, status, completed_at, documents_included)
       VALUES ($1, $2, 'completed', now(), $3::text[])
       RETURNING id AS run_id`,
      z.object({ run_id: z.string() }),
      [dealId, moduleId, documentsIncluded ?? []],
      { label: "Insert module run" }
    );

    const runId = runRows[0].run_id;

    // Save the output
    const outputRows = await ctx.integrations.db.query(
      `INSERT INTO module_outputs (module_run_id, executive_header, findings, full_report_markdown)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id AS output_id`,
      z.object({ output_id: z.string() }),
      [runId, executiveHeader, JSON.stringify(findings), fullReport],
      { label: "Insert module output" }
    );

    // Bump deal updated_at
    await ctx.integrations.db.execute(
      `UPDATE deals SET updated_at = now() WHERE id = $1`,
      [dealId],
      { label: "Bump deal updated_at" }
    );

    return { result: { run_id: runId, output_id: outputRows[0].output_id } };
  },
});
