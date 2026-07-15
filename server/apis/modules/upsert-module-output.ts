import { z } from "@superblocksteam/sdk-api";

/**
 * Shared helper: upserts a row in module_outputs and bumps the deal's updated_at.
 *
 * Call this instead of writing inline INSERT/UPDATE logic in each recovery path.
 * Keeps module_outputs writes in a single place so schema changes propagate once.
 *
 * @param db - A postgres integration client (ctx.integrations.db)
 */
export async function upsertModuleOutput(
  db: {
    query: (...args: any[]) => Promise<any[]>;
    execute: (...args: any[]) => Promise<any>;
  },
  params: {
    runId: string;
    dealId: string;
    executiveHeader: string;
    findings: unknown[];
    fullReport: string;
  }
): Promise<{ outputId: string; wasUpdate: boolean }> {
  const { runId, dealId, executiveHeader, findings, fullReport } = params;

  // Check if output already exists for this run
  const existing = await db.query(
    `SELECT id AS output_id FROM module_outputs WHERE module_run_id = $1 LIMIT 1`,
    z.object({ output_id: z.string() }),
    [runId],
    { label: "upsertModuleOutput: check existing" }
  );

  let outputId: string;
  let wasUpdate = false;

  if (existing.length > 0) {
    outputId = existing[0].output_id;
    wasUpdate = true;
    await db.execute(
      `UPDATE module_outputs
       SET executive_header = $2, findings = $3::jsonb, full_report_markdown = $4
       WHERE id = $1`,
      [outputId, executiveHeader, JSON.stringify(findings), fullReport],
      { label: "upsertModuleOutput: update" }
    );
  } else {
    const insertRows = await db.query(
      `INSERT INTO module_outputs (module_run_id, executive_header, findings, full_report_markdown)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id AS output_id`,
      z.object({ output_id: z.string() }),
      [runId, executiveHeader, JSON.stringify(findings), fullReport],
      { label: "upsertModuleOutput: insert" }
    );
    outputId = insertRows[0].output_id;
  }

  // Bump deal updated_at
  await db.execute(
    `UPDATE deals SET updated_at = now() WHERE id = $1`,
    [dealId],
    { label: "upsertModuleOutput: bump deal" }
  );

  return { outputId, wasUpdate };
}
