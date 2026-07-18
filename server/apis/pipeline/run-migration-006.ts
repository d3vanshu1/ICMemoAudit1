/**
 * Migration 006 — creates absence_verification_checkpoints table.
 * Used by the absence verification phase (Step 2) to checkpoint per-finding
 * verdicts so resumed invocations skip already-verified findings.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration006",
  description: "Creates absence_verification_checkpoints table",

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
      `CREATE TABLE IF NOT EXISTS absence_verification_checkpoints (
        module_run_id UUID NOT NULL,
        finding_index INT NOT NULL,
        verdict_json JSONB NOT NULL,
        model_used TEXT,
        created_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE (module_run_id, finding_index)
      )`,
      [],
      { label: "Create absence_verification_checkpoints table" }
    );

    return {
      success: true,
      message: "absence_verification_checkpoints table created",
    };
  },
});
