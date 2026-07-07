import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DeleteDeal",
  description: "Deletes a deal and all related data via cascades",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    success: z.boolean(),
  }),

  async run(ctx, { dealId }) {
    await ctx.integrations.db.execute(
      `DELETE FROM deals WHERE id = $1`,
      [dealId],
      { label: "Delete deal" }
    );

    return { success: true };
  },
});
