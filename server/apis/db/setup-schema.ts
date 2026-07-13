import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "SetupSchema",
  description: "Creates all IC Diligence database tables if they don't exist",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    tablesCreated: z.array(z.string()),
  }),

  async run(ctx) {
    const tablesCreated: string[] = [];

    // 1. Deals table (using gen_random_uuid() — built-in, no extension needed)
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS deals (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name            TEXT NOT NULL,
        description     TEXT,
        sector          TEXT,
        status          TEXT NOT NULL DEFAULT 'active',
        entry_ev        NUMERIC(15, 2),
        entry_multiple  NUMERIC(8, 2),
        equity_check    NUMERIC(15, 2),
        ic_date         DATE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      undefined,
      { label: "Create deals table" }
    );
    tablesCreated.push("deals");

    // 3. Documents table
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS documents (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id         UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        file_name       TEXT NOT NULL,
        file_type       TEXT NOT NULL,
        document_tag    TEXT NOT NULL DEFAULT 'other',
        document_source TEXT,
        parsed_text     TEXT NOT NULL DEFAULT '',
        uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      undefined,
      { label: "Create documents table" }
    );
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_documents_deal_id ON documents(deal_id)`,
      undefined,
      { label: "Create documents index" }
    );
    tablesCreated.push("documents");

    // 4. Module runs table
    await ctx.integrations.db.execute(
      `DO $$ BEGIN
        CREATE TYPE module_status AS ENUM ('pending', 'running', 'completed', 'failed');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$`,
      undefined,
      { label: "Create module_status enum" }
    );

    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS module_runs (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id             UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        module_id           TEXT NOT NULL,
        status              module_status NOT NULL DEFAULT 'pending',
        triggered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at        TIMESTAMPTZ,
        documents_included  TEXT[] NOT NULL DEFAULT '{}'
      )`,
      undefined,
      { label: "Create module_runs table" }
    );
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_module_runs_deal_id ON module_runs(deal_id)`,
      undefined,
      { label: "Create module_runs index" }
    );
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_module_runs_deal_module ON module_runs(deal_id, module_id)`,
      undefined,
      { label: "Create module_runs composite index" }
    );
    tablesCreated.push("module_runs");

    // Migration: change documents_included from UUID[] to TEXT[] if needed
    try {
      await ctx.integrations.db.execute(
        `ALTER TABLE module_runs ALTER COLUMN documents_included TYPE TEXT[] USING documents_included::TEXT[]`,
        undefined,
        { label: "Migrate documents_included to TEXT[]" }
      );
    } catch {
      // Ignore — already migrated or lacking ALTER privileges
    }

    // 5. Module outputs table
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS module_outputs (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        module_run_id        UUID NOT NULL REFERENCES module_runs(id) ON DELETE CASCADE,
        executive_header     TEXT,
        findings             JSONB NOT NULL DEFAULT '[]',
        full_report_markdown TEXT NOT NULL DEFAULT '',
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      undefined,
      { label: "Create module_outputs table" }
    );
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_module_outputs_run_id ON module_outputs(module_run_id)`,
      undefined,
      { label: "Create module_outputs index" }
    );
    tablesCreated.push("module_outputs");

    // 6. Sub-agent extractions table
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS sub_agent_extractions (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        module_run_id   UUID NOT NULL REFERENCES module_runs(id) ON DELETE CASCADE,
        document_id     UUID REFERENCES documents(id) ON DELETE CASCADE,
        chunk_index     INT NOT NULL DEFAULT 0,
        extraction_json JSONB NOT NULL DEFAULT '{}',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      undefined,
      { label: "Create sub_agent_extractions table" }
    );
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_extractions_run_id ON sub_agent_extractions(module_run_id)`,
      undefined,
      { label: "Create extractions index" }
    );
    tablesCreated.push("sub_agent_extractions");

    // 7. Document chunks table (for Q&A full-text search / RAG)
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS document_chunks (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        deal_id         UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        chunk_index     INT NOT NULL DEFAULT 0,
        file_name       TEXT NOT NULL,
        content         TEXT NOT NULL,
        tsv             TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
      )`,
      undefined,
      { label: "Create document_chunks table" }
    );
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_doc_chunks_deal_id ON document_chunks(deal_id)`,
      undefined,
      { label: "Create document_chunks deal index" }
    );
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_doc_chunks_doc_id ON document_chunks(document_id)`,
      undefined,
      { label: "Create document_chunks doc index" }
    );
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_doc_chunks_tsv ON document_chunks USING GIN(tsv)`,
      undefined,
      { label: "Create document_chunks GIN index" }
    );
    tablesCreated.push("document_chunks");

    // -----------------------------------------------------------------------
    // 8. Universal extractions table (deal-level, survives across runs)
    // -----------------------------------------------------------------------
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
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_univ_extractions_deal ON universal_extractions(deal_id)`,
      undefined,
      { label: "Create universal_extractions deal index" }
    );
    tablesCreated.push("universal_extractions");

    // -----------------------------------------------------------------------
    // 9. Merge checkpoints table (per module run)
    // -----------------------------------------------------------------------
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
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_merge_ckpt_run ON merge_checkpoints(module_run_id)`,
      undefined,
      { label: "Create merge_checkpoints run index" }
    );
    tablesCreated.push("merge_checkpoints");

    // -----------------------------------------------------------------------
    // 10. Pipeline analysis checkpoints (server-side pipeline per-chunk results)
    // -----------------------------------------------------------------------
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS pipeline_analysis (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id          UUID NOT NULL,
        chunk_index     INT NOT NULL,
        result_json     JSONB NOT NULL DEFAULT '{}',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (run_id, chunk_index)
      )`,
      undefined,
      { label: "Create pipeline_analysis table" }
    );
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_pipeline_analysis_run ON pipeline_analysis(run_id)`,
      undefined,
      { label: "Create pipeline_analysis run index" }
    );
    tablesCreated.push("pipeline_analysis");

    return { success: true, tablesCreated };
  },
});
