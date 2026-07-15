import { api, z, postgres } from "@superblocksteam/sdk-api";
import { upsertModuleOutput } from "../modules/upsert-module-output.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const RootLocatorSchema = z.object({
  tree_level: z.coerce.number(),
  node_index: z.coerce.number(),
  has_error: z.boolean(),
});

const FindingsSliceSchema = z.object({
  findings_json: z.any(),
  executive_header: z.string().nullable(),
});

export default api({
  name: "ReconcileFindings",
  description: "Recovers findings from merge checkpoints when FormatReport timed out.",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    moduleId: z.string(),
    runId: z.string(),
  }),

  output: z.object({
    success: z.boolean(),
    findingsCount: z.number(),
    executiveHeader: z.string().nullable(),
    savedWithoutReport: z.boolean(),
    debugInfo: z.string().optional(),
  }),

  async run(ctx, { dealId, moduleId, runId }) {
    // Step 1: Find the root node coordinates WITHOUT fetching the large merged_json
    // This avoids the gRPC 4MB message limit
    // Get a broader view: all tree_levels where node_index=0, plus the top 20 overall
    const locators = await ctx.integrations.db.query(
      `(SELECT tree_level, node_index,
              (merged_json->>'error' IS NOT NULL) as has_error
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND node_index = 0
       ORDER BY tree_level DESC
       LIMIT 10)
       UNION ALL
      (SELECT tree_level, node_index,
              (merged_json->>'error' IS NOT NULL) as has_error
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND node_index != 0
       ORDER BY tree_level DESC, node_index ASC
       LIMIT 10)
       ORDER BY tree_level DESC, node_index ASC`,
      RootLocatorSchema,
      [runId],
      { label: "Find root merge checkpoint coordinates" }
    );

    if (locators.length === 0) {
      return { success: false, findingsCount: 0, executiveHeader: null, savedWithoutReport: false, debugInfo: "No checkpoints found for this run" };
    }

    // The root is the highest tree_level with node_index = 0
    const root = locators.find(cp => cp.node_index === 0);
    if (!root) {
      return { success: false, findingsCount: 0, executiveHeader: null, savedWithoutReport: false, debugInfo: `Found ${locators.length} checkpoints but none with node_index=0. Levels: ${locators.map(l => `${l.tree_level}/${l.node_index}`).join(", ")}` };
    }

    if (root.has_error) {
      // Root has error — try the next-highest tree_level with node_index=0 that doesn't have an error
      const fallback = locators.find(cp => cp.node_index === 0 && !cp.has_error);
      if (!fallback) {
        const summary = locators.map(l => `L${l.tree_level}/N${l.node_index}${l.has_error ? "(err)" : ""}`).join(", ");
        return { success: false, findingsCount: 0, executiveHeader: null, savedWithoutReport: false, debugInfo: `Root (L${root.tree_level}) has error. All top checkpoints: ${summary}` };
      }
      // Use fallback as the root
      Object.assign(root, fallback);
    }

    // Step 2: Extract only the findings and executiveHeader using JSON operators
    // This keeps the response size manageable (findings array without the huge text field)
    const sliceRows = await ctx.integrations.db.query(
      `SELECT
         merged_json->'findings' as findings_json,
         COALESCE(merged_json->>'executiveHeader', merged_json->>'executive_header') as executive_header
       FROM merge_checkpoints
       WHERE module_run_id = $1
         AND tree_level = $2
         AND node_index = 0
       LIMIT 1`,
      FindingsSliceSchema,
      [runId, root.tree_level],
      { label: "Extract findings from root checkpoint" }
    );

    if (sliceRows.length === 0) {
      return { success: false, findingsCount: 0, executiveHeader: null, savedWithoutReport: false, debugInfo: "Root node disappeared between queries" };
    }

    const row = sliceRows[0];
    const executiveHeader = row.executive_header;

    // Parse findings — comes back as parsed JSONB (array) from the -> operator
    let findings: any[] = [];
    if (row.findings_json) {
      try {
        const parsed = typeof row.findings_json === "string" ? JSON.parse(row.findings_json) : row.findings_json;
        findings = Array.isArray(parsed) ? parsed : [];
      } catch {
        return { success: false, findingsCount: 0, executiveHeader: null, savedWithoutReport: false, debugInfo: "Failed to parse findings JSON" };
      }
    }

    if (findings.length === 0) {
      return { success: false, findingsCount: 0, executiveHeader, savedWithoutReport: false, debugInfo: "Root node has no findings array" };
    }

    // Step 3: Build a placeholder report from findings
    const reportPlaceholder = `# ${executiveHeader ?? moduleId}\n\n_Report formatting pending — findings recovered from merge checkpoints._\n\n## Key Findings (${findings.length})\n\n${findings.slice(0, 20).map((f: any, i: number) => `${i + 1}. **${f.title ?? f.claim ?? "Finding"}** — ${f.detail ?? f.summary ?? f.evidence ?? ""}`).join("\n")}${findings.length > 20 ? `\n\n_...and ${findings.length - 20} more findings._` : ""}`;

    // Step 4: Save to module_outputs via shared helper
    await upsertModuleOutput(ctx.integrations.db, {
      runId,
      dealId,
      executiveHeader: executiveHeader ?? moduleId,
      findings,
      fullReport: reportPlaceholder,
    });

    // Mark run completed (guarded — only transitions running → completed)
    await ctx.integrations.db.execute(
      `UPDATE module_runs SET status = 'completed'::module_status, completed_at = now()
       WHERE id = $1 AND status = 'running'::module_status`,
      [runId],
      { label: "Mark reconciled run completed" }
    );

    return {
      success: true,
      findingsCount: findings.length,
      executiveHeader,
      savedWithoutReport: true,
    };
  },
});
