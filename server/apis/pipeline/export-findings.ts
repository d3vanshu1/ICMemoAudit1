/**
 * ExportFindings — permanent diagnostic API.
 *
 * Returns the final merge node's full findings array for a given runId,
 * plus a server-computed summary block (counts by severity, by gap_type,
 * total byte size). No writes, no LLM calls, no side effects.
 *
 * The query uses the proven text-stripped pattern: `merged_json->'findings'`
 * (never fetches the `text` field), keeping responses safely under the 4MB
 * gRPC transport limit (~640KB for 350 findings).
 *
 * Pagination: `offset` + `limit` params let callers page through findings.
 * `severityFilter` applies BEFORE pagination (filter → slice).
 * Summary block always reflects the full unfiltered set.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const FindingSchema = z.object({
  severity: z.enum(["critical", "warning", "info"]),
  title: z.string(),
  detail: z.string(),
  full_analysis: z.string(),
  source_docs: z.array(z.string()),
  claim_ids: z.array(z.string()).optional(),
  absence_confidence: z.string().optional(),
  gap_type: z.enum(["diligence_gap", "memo_omission"]).optional(),
  evidence_docs: z.array(z.string()).optional(),
  independent: z.boolean().optional(),
  verification: z.object({
    status: z.enum(["revised", "upheld"]),
    evidenceQuoted: z.string().optional(),
    evidenceSource: z.string().optional(),
    queriesRun: z.array(z.string()),
  }).optional(),
});

const SummarySchema = z.object({
  totalCount: z.number(),
  byteSize: z.number(),
  bySeverity: z.object({
    critical: z.number(),
    warning: z.number(),
    info: z.number(),
  }),
  byGapType: z.object({
    diligence_gap: z.number(),
    memo_omission: z.number(),
    unclassified: z.number(),
  }),
  treeLevel: z.number(),
});

export default api({
  name: "ExportFindings",
  description: "Exports final merge node findings with pagination and severity/category summary",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    mode: z.enum(["full", "ids"]).nullable().optional()
      .describe("'full' (default): return findings with full content. 'ids': return sorted title arrays per severity, counts, byte lengths (~15KB total)."),
    severityFilter: z.enum(["critical", "warning", "info"]).nullable().optional()
      .describe("Optional: return only findings matching this severity (applied before pagination)"),
    offset: z.number().nullable().optional().describe("Pagination offset (0-indexed). Default 0."),
    limit: z.number().nullable().optional().describe("Page size. Default: return all (no limit)."),
  }),

  output: z.object({
    runId: z.string(),
    totalCount: z.number().describe("Total findings matching filter (before pagination)"),
    offset: z.number(),
    returnedCount: z.number().describe("Number of findings in this page"),
    byteLength: z.number().describe("Byte length of the findings JSON in this response"),
    findings: z.array(FindingSchema),
    summary: SummarySchema.describe("Always computed from the FULL unfiltered set"),
    filtered: z.boolean(),
    // mode:"ids" fields — null when mode is "full"
    idManifest: z.object({
      generatedAt: z.string(),
      totalCount: z.number(),
      bySeverity: z.object({
        critical: z.object({ count: z.number(), titles: z.array(z.string()), byteLength: z.number() }),
        warning: z.object({ count: z.number(), titles: z.array(z.string()), byteLength: z.number() }),
        info: z.object({ count: z.number(), titles: z.array(z.string()), byteLength: z.number() }),
      }),
    }).nullable().optional(),
  }),

  async run(ctx, { runId, mode: rawMode, severityFilter, offset: rawOffset, limit: rawLimit }) {
    const mode = rawMode ?? "full";
    const offset = rawOffset ?? 0;

    // Fetch the final merge node's findings array (text-stripped by construction)
    const RawRow = z.object({
      tree_level: z.coerce.number(),
      findings_json: z.string(),
      findings_bytes: z.coerce.number(),
    });

    const [row] = await ctx.integrations.db.query(
      `SELECT tree_level,
              COALESCE(merged_json->'findings', '[]'::jsonb)::text AS findings_json,
              octet_length(COALESCE(merged_json->'findings', '[]'::jsonb)::text) AS findings_bytes
       FROM merge_checkpoints
       WHERE module_run_id = $1
       ORDER BY tree_level DESC, node_index ASC
       LIMIT 1`,
      RawRow,
      [runId],
      { label: "ExportFindings: fetch final merge node findings" }
    );

    if (!row) {
      return {
        runId,
        totalCount: 0,
        offset: 0,
        returnedCount: 0,
        byteLength: 2, // "[]"
        findings: [],
        summary: {
          totalCount: 0,
          byteSize: 0,
          bySeverity: { critical: 0, warning: 0, info: 0 },
          byGapType: { diligence_gap: 0, memo_omission: 0, unclassified: 0 },
          treeLevel: -1,
        },
        filtered: false,
      };
    }

    // Parse the findings JSON
    const allFindings: Array<z.infer<typeof FindingSchema>> = JSON.parse(row.findings_json);

    // Compute summary from the FULL set (before any filter)
    const bySeverity = { critical: 0, warning: 0, info: 0 };
    const byGapType = { diligence_gap: 0, memo_omission: 0, unclassified: 0 };

    for (const f of allFindings) {
      if (f.severity === "critical") bySeverity.critical++;
      else if (f.severity === "warning") bySeverity.warning++;
      else bySeverity.info++;

      if (f.gap_type === "diligence_gap") byGapType.diligence_gap++;
      else if (f.gap_type === "memo_omission") byGapType.memo_omission++;
      else byGapType.unclassified++;
    }

    const summary: z.infer<typeof SummarySchema> = {
      totalCount: allFindings.length,
      byteSize: row.findings_bytes,
      bySeverity,
      byGapType,
      treeLevel: row.tree_level,
    };

    // --- mode: "ids" — lightweight manifest only ---
    if (mode === "ids") {
      const buckets: Record<string, string[]> = { critical: [], warning: [], info: [] };
      for (const f of allFindings) {
        buckets[f.severity]?.push(f.title);
      }
      // Sort each bucket alphabetically for deterministic comparison
      for (const key of Object.keys(buckets)) {
        buckets[key].sort();
      }
      const criticalJson = JSON.stringify(buckets.critical);
      const warningJson = JSON.stringify(buckets.warning);
      const infoJson = JSON.stringify(buckets.info);

      return {
        runId,
        totalCount: allFindings.length,
        offset: 0,
        returnedCount: 0,
        byteLength: 0,
        findings: [] as Array<z.infer<typeof FindingSchema>>,
        summary,
        filtered: false,
        idManifest: {
          generatedAt: new Date().toISOString(),
          totalCount: allFindings.length,
          bySeverity: {
            critical: { count: buckets.critical.length, titles: buckets.critical, byteLength: Buffer.byteLength(criticalJson, "utf8") },
            warning: { count: buckets.warning.length, titles: buckets.warning, byteLength: Buffer.byteLength(warningJson, "utf8") },
            info: { count: buckets.info.length, titles: buckets.info, byteLength: Buffer.byteLength(infoJson, "utf8") },
          },
        },
      };
    }

    // --- mode: "full" (default) ---
    // Apply severity filter if requested (BEFORE pagination)
    const filteredFindings = severityFilter
      ? allFindings.filter(f => f.severity === severityFilter)
      : allFindings;

    const totalCount = filteredFindings.length;

    // Apply pagination
    const pageFindings = rawLimit != null
      ? filteredFindings.slice(offset, offset + rawLimit)
      : filteredFindings.slice(offset);

    const byteLength = Buffer.byteLength(JSON.stringify(pageFindings), "utf8");

    return {
      runId,
      totalCount,
      offset,
      returnedCount: pageFindings.length,
      byteLength,
      findings: pageFindings,
      summary,
      filtered: !!severityFilter,
    };
  },
});
