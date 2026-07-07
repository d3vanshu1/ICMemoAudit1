import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CreatedDealSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
});

export default api({
  name: "CreateDeal",
  description: "Creates a new deal in the database",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    name: z.string(),
    description: z.string().nullable().optional(),
    sector: z.string().nullable().optional(),
    entry_ev: z.number().nullable().optional(),
    entry_multiple: z.number().nullable().optional(),
    equity_check: z.number().nullable().optional(),
    ic_date: z.string().nullable().optional(),
  }),

  output: z.object({
    deal: CreatedDealSchema,
  }),

  async run(ctx, { name, description, sector, entry_ev, entry_multiple, equity_check, ic_date }) {
    const rows = await ctx.integrations.db.query(
      `INSERT INTO deals (name, description, sector, entry_ev, entry_multiple, equity_check, ic_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, created_at`,
      CreatedDealSchema,
      [name, description ?? null, sector ?? null, entry_ev ?? null, entry_multiple ?? null, equity_check ?? null, ic_date ?? null],
      { label: "Insert new deal" }
    );

    return { deal: rows[0] };
  },
});
