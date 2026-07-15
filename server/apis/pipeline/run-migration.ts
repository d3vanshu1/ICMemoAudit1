/**
 * One-off migration runner — creates web_research_iterations table.
 * Delete after running.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration004",
  description: "Creates web_research_iterations table for server-side research checkpointing",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
  }),

  async run(ctx) {
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS web_research_iterations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id UUID NOT NULL,
        run_id UUID NOT NULL,
        module_id TEXT NOT NULL,
        iteration INT NOT NULL,
        query TEXT,
        finding TEXT,
        confidence INT,
        platform TEXT,
        category TEXT,
        sources JSONB,
        materiality TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE (run_id, iteration)
      )`,
      [],
      { label: "Create web_research_iterations table" }
    );

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_web_research_iterations_run
       ON web_research_iterations (run_id, iteration)`,
      [],
      { label: "Create run index" }
    );

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_web_research_iterations_deal
       ON web_research_iterations (deal_id, module_id)`,
      [],
      { label: "Create deal index" }
    );

    return { success: true, message: "web_research_iterations table created with indexes" };
  },
});
