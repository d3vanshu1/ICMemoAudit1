import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "UpdateDeal",
  description: "Updates deal fields and bumps updated_at",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    sector: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    entry_ev: z.number().nullable().optional(),
    entry_multiple: z.number().nullable().optional(),
    equity_check: z.number().nullable().optional(),
    ic_date: z.string().nullable().optional(),
  }),

  output: z.object({
    success: z.boolean(),
  }),

  async run(ctx, { dealId, name, description, sector, status, entry_ev, entry_multiple, equity_check, ic_date }) {
    await ctx.integrations.db.execute(
      `UPDATE deals SET
        name            = COALESCE($2, name),
        description     = COALESCE($3, description),
        sector          = COALESCE($4, sector),
        status          = COALESCE($5, status),
        entry_ev        = COALESCE($6, entry_ev),
        entry_multiple  = COALESCE($7, entry_multiple),
        equity_check    = COALESCE($8, equity_check),
        ic_date         = COALESCE($9, ic_date),
        updated_at      = now()
      WHERE id = $1`,
      [dealId, name ?? null, description ?? null, sector ?? null, status ?? null, entry_ev ?? null, entry_multiple ?? null, equity_check ?? null, ic_date ?? null],
      { label: "Update deal" }
    );

    return { success: true };
  },
});
