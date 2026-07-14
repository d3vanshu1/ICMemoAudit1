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
  description: "Saves module output, attaching to existing run when runId is provided",

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
    // When provided, attaches output to this existing run instead of creating a new one.
    // Used by the server-pipeline path where pipeline-core.ts already manages the module_runs row.
    runId: z.string().nullable().optional(),
  }),

  output: z.object({
    result: SavedRunSchema,
  }),

  async run(ctx, { dealId, moduleId, executiveHeader, findings, fullReport, documentsIncluded, runId }) {
    let effectiveRunId: string;

    if (runId) {
      // Server-pipeline path: run already exists and is marked completed by pipeline-core.
      // Just update documents_included if provided (pipeline-core doesn't set this).
      effectiveRunId = runId;
      if (documentsIncluded && documentsIncluded.length > 0) {
        await ctx.integrations.db.execute(
          `UPDATE module_runs SET documents_included = $2::text[] WHERE id = $1`,
          [effectiveRunId, documentsIncluded],
          { label: "Update documents_included on existing run" }
        );
      }
    } else {
      // Legacy client-only path (non-pipeline): create a new completed run.
      const runRows = await ctx.integrations.db.query(
        `INSERT INTO module_runs (deal_id, module_id, status, completed_at, documents_included)
         VALUES ($1, $2, 'completed', now(), $3::text[])
         RETURNING id AS run_id`,
        z.object({ run_id: z.string() }),
        [dealId, moduleId, documentsIncluded ?? []],
        { label: "Insert module run (legacy path)" }
      );
      effectiveRunId = runRows[0].run_id;
    }

    // Check if output already exists for this run (no unique index available)
    const existing = await ctx.integrations.db.query(
      `SELECT id AS output_id FROM module_outputs WHERE module_run_id = $1 LIMIT 1`,
      z.object({ output_id: z.string() }),
      [effectiveRunId],
      { label: "Check existing module_output" }
    );

    let outputId: string;
    if (existing.length > 0) {
      // Update existing (e.g. ResumeStalePipelines wrote a stub, client now has the formatted report)
      outputId = existing[0].output_id;
      await ctx.integrations.db.execute(
        `UPDATE module_outputs
         SET executive_header = $2, findings = $3::jsonb, full_report_markdown = $4
         WHERE id = $1`,
        [outputId, executiveHeader, JSON.stringify(findings), fullReport],
        { label: "Update module output" }
      );
    } else {
      // Insert new output
      const outputRows = await ctx.integrations.db.query(
        `INSERT INTO module_outputs (module_run_id, executive_header, findings, full_report_markdown)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING id AS output_id`,
        z.object({ output_id: z.string() }),
        [effectiveRunId, executiveHeader, JSON.stringify(findings), fullReport],
        { label: "Insert module output" }
      );
      outputId = outputRows[0].output_id;
    }

    // Bump deal updated_at
    await ctx.integrations.db.execute(
      `UPDATE deals SET updated_at = now() WHERE id = $1`,
      [dealId],
      { label: "Bump deal updated_at" }
    );

    return { result: { run_id: effectiveRunId, output_id: outputId } };
  },
});
