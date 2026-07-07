import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunCheckpointMigration",
  description: "Runs checkpoint-specific DB migration (creates checkpoint tables)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    steps: z.array(z.string()),
    errors: z.array(z.string()),
  }),

  async run(ctx) {
    const steps: string[] = [];
    const errors: string[] = [];

    // 1. Create universal_extractions table (no FK constraints — avoids ownership issues)
    try {
      await ctx.integrations.db.execute(
        `CREATE TABLE IF NOT EXISTS universal_extractions (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          deal_id         UUID NOT NULL,
          document_id     UUID NOT NULL,
          chunk_index     INT NOT NULL DEFAULT 0,
          content_hash    TEXT NOT NULL,
          extraction_json JSONB NOT NULL DEFAULT '{}',
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (deal_id, document_id, chunk_index)
        )`,
        undefined,
        { label: "Create universal_extractions table" }
      );
      steps.push("Created universal_extractions table");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`universal_extractions: ${msg}`);
    }

    try {
      await ctx.integrations.db.execute(
        `CREATE INDEX IF NOT EXISTS idx_univ_extractions_deal ON universal_extractions(deal_id)`,
        undefined,
        { label: "Create universal_extractions index" }
      );
      steps.push("Created universal_extractions index");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`universal_extractions index: ${msg}`);
    }

    // 2. Create merge_checkpoints table (no FK constraints)
    try {
      await ctx.integrations.db.execute(
        `CREATE TABLE IF NOT EXISTS merge_checkpoints (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          module_run_id   UUID NOT NULL,
          tree_level      INT NOT NULL,
          node_index      INT NOT NULL,
          merged_json     JSONB NOT NULL DEFAULT '{}',
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (module_run_id, tree_level, node_index)
        )`,
        undefined,
        { label: "Create merge_checkpoints table" }
      );
      steps.push("Created merge_checkpoints table");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`merge_checkpoints: ${msg}`);
    }

    try {
      await ctx.integrations.db.execute(
        `CREATE INDEX IF NOT EXISTS idx_merge_ckpt_run ON merge_checkpoints(module_run_id)`,
        undefined,
        { label: "Create merge_checkpoints index" }
      );
      steps.push("Created merge_checkpoints index");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`merge_checkpoints index: ${msg}`);
    }

    // 3. Create run_coverage table — per-run document coverage manifest
    try {
      await ctx.integrations.db.execute(
        `CREATE TABLE IF NOT EXISTS run_coverage (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          module_run_id       UUID NOT NULL,
          documents_included  JSONB NOT NULL DEFAULT '[]',
          documents_excluded  JSONB NOT NULL DEFAULT '[]',
          chunk_count         INT NOT NULL DEFAULT 0,
          pages_processed     INT NOT NULL DEFAULT 0,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (module_run_id)
        )`,
        undefined,
        { label: "Create run_coverage table" }
      );
      steps.push("Created run_coverage table");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`run_coverage: ${msg}`);
    }

    try {
      await ctx.integrations.db.execute(
        `CREATE INDEX IF NOT EXISTS idx_run_coverage_run ON run_coverage(module_run_id)`,
        undefined,
        { label: "Create run_coverage index" }
      );
      steps.push("Created run_coverage index");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`run_coverage index: ${msg}`);
    }

    // 4. Create doc_tables table — structured cell grids parsed from Excel/CSV
    try {
      await ctx.integrations.db.execute(
        `CREATE TABLE IF NOT EXISTS doc_tables (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          document_id     UUID NOT NULL,
          sheet_or_page   TEXT NOT NULL,
          caption         TEXT,
          data            JSONB NOT NULL DEFAULT '{}',
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        undefined,
        { label: "Create doc_tables table" }
      );
      steps.push("Created doc_tables table");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`doc_tables: ${msg}`);
    }

    try {
      await ctx.integrations.db.execute(
        `CREATE INDEX IF NOT EXISTS idx_doc_tables_document ON doc_tables(document_id)`,
        undefined,
        { label: "Create doc_tables index" }
      );
      steps.push("Created doc_tables index");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`doc_tables index: ${msg}`);
    }

    // 5. Create numeric_reports table — deterministic arithmetic verification results
    try {
      await ctx.integrations.db.execute(
        `CREATE TABLE IF NOT EXISTS numeric_reports (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          module_run_id   UUID NOT NULL,
          figures         JSONB NOT NULL DEFAULT '[]',
          discrepancies   JSONB NOT NULL DEFAULT '[]',
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        undefined,
        { label: "Create numeric_reports table" }
      );
      steps.push("Created numeric_reports table");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`numeric_reports: ${msg}`);
    }

    try {
      await ctx.integrations.db.execute(
        `CREATE INDEX IF NOT EXISTS idx_numeric_reports_run ON numeric_reports(module_run_id)`,
        undefined,
        { label: "Create numeric_reports index" }
      );
      steps.push("Created numeric_reports index");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`numeric_reports index: ${msg}`);
    }

    return { success: errors.length === 0, steps, errors };
  },
});
