/**
 * ExportFindings — permanent diagnostic API.
 *
 * RC1: Now uses CanonicalFindingSchema at the output boundary — all finding fields
 * preserved including finding_kind, severity_anchor, issue_key, structured_impact,
 * evidence, verification, etc.
 *
 * RC audit item #10 (§10 "persist one canonical post-quality artifact"):
 * Primary source is module_outputs.findings (post-quality-pass canonical artifact).
 * Falls back to merge_checkpoints only when module_outputs has no row (run incomplete).
 * The fallback source is clearly flagged as pre-quality in the response.
 *
 * Pagination: `offset` + `limit` params let callers page through findings.
 * `severityFilter` applies BEFORE pagination (filter → slice).
 * Summary block always reflects the full unfiltered set.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { CanonicalFindingSchema, parseCanonicalFindings } from "./canonical-finding.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

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
  /** true = findings came from post-quality module_outputs; false = fell back to raw merge checkpoint */
  fromCanonicalArtifact: z.boolean(),
});

export default api({
  name: "ExportFindings",
  description: "Exports final findings (post-quality artifact) with pagination and severity/category summary",

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
    findings: z.array(CanonicalFindingSchema),
    summary: SummarySchema.describe("Always computed from the FULL unfiltered set"),
    filtered: z.boolean(),
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

    // --- RC1/RC10: Primary source = module_outputs (canonical post-quality artifact) ---
    const CanonicalOutputRow = z.object({
      findings: z.any(),
      findings_bytes: z.coerce.number(),
      from_canonical: z.literal(true),
      tree_level: z.literal(-1),
    });

    const FallbackRow = z.object({
      findings: z.any(),
      findings_bytes: z.coerce.number(),
      from_canonical: z.literal(false),
      tree_level: z.coerce.number(),
    });

    type ExportRow = {
      findings: unknown;
      findings_bytes: number;
      from_canonical: boolean;
      tree_level: number;
    };

    let row: ExportRow | null = null;

    // Try canonical artifact first
    try {
      const canonRows = await ctx.integrations.db.query(
        `SELECT mo.findings,
                octet_length(mo.findings::text) AS findings_bytes,
                true AS from_canonical,
                -1 AS tree_level
         FROM module_outputs mo
         WHERE mo.module_run_id = $1
         LIMIT 1`,
        CanonicalOutputRow,
        [runId],
        { label: "ExportFindings: fetch canonical artifact from module_outputs" }
      );
      if (canonRows.length > 0) {
        const cr = canonRows[0];
        row = { findings: cr.findings, findings_bytes: cr.findings_bytes, from_canonical: true, tree_level: -1 };
      }
    } catch {
      // module_outputs may not have a row — fall through to checkpoint fallback
    }

    // Fallback: pre-quality merge checkpoint (flagged in response)
    if (!row) {
      const cpRows = await ctx.integrations.db.query(
        `SELECT COALESCE(merged_json->'findings', '[]'::jsonb) AS findings,
                octet_length(COALESCE(merged_json->'findings', '[]'::jsonb)::text) AS findings_bytes,
                false AS from_canonical,
                tree_level
         FROM merge_checkpoints
         WHERE module_run_id = $1
         ORDER BY tree_level DESC, node_index ASC
         LIMIT 1`,
        FallbackRow,
        [runId],
        { label: "ExportFindings: fallback to merge checkpoint" }
      );
      if (cpRows.length > 0) {
        const cr = cpRows[0];
        row = { findings: cr.findings, findings_bytes: cr.findings_bytes, from_canonical: false, tree_level: cr.tree_level };
      }
    }

    if (!row) {
      return {
        runId,
        totalCount: 0,
        offset: 0,
        returnedCount: 0,
        byteLength: 2,
        findings: [],
        summary: {
          totalCount: 0,
          byteSize: 0,
          bySeverity: { critical: 0, warning: 0, info: 0 },
          byGapType: { diligence_gap: 0, memo_omission: 0, unclassified: 0 },
          treeLevel: -1,
          fromCanonicalArtifact: false,
        },
        filtered: false,
      };
    }

    // RC1: canonical parser
    const rawFindings = typeof row.findings === "string"
      ? JSON.parse(row.findings)
      : row.findings;
    const parseResult = parseCanonicalFindings(rawFindings, {
      mode: "reload",
      source: `ExportFindings run_id=${runId} canonical=${row.from_canonical}`,
    });
    if (parseResult.malformed_count > 0) {
      console.error(`[ExportFindings] ${parseResult.malformed_count} malformed findings for run ${runId}`);
    }
    const allFindings = parseResult.findings;

    // Compute summary from the FULL set (before filter)
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
      fromCanonicalArtifact: row.from_canonical,
    };

    // --- mode: "ids" ---
    if (mode === "ids") {
      const buckets: Record<string, string[]> = { critical: [], warning: [], info: [] };
      for (const f of allFindings) {
        buckets[f.severity]?.push(f.title);
      }
      for (const key of Object.keys(buckets)) buckets[key].sort();
      const cJ = JSON.stringify(buckets.critical);
      const wJ = JSON.stringify(buckets.warning);
      const iJ = JSON.stringify(buckets.info);

      return {
        runId,
        totalCount: allFindings.length,
        offset: 0,
        returnedCount: 0,
        byteLength: 0,
        findings: [],
        summary,
        filtered: false,
        idManifest: {
          generatedAt: new Date().toISOString(),
          totalCount: allFindings.length,
          bySeverity: {
            critical: { count: buckets.critical.length, titles: buckets.critical, byteLength: Buffer.byteLength(cJ, "utf8") },
            warning: { count: buckets.warning.length, titles: buckets.warning, byteLength: Buffer.byteLength(wJ, "utf8") },
            info: { count: buckets.info.length, titles: buckets.info, byteLength: Buffer.byteLength(iJ, "utf8") },
          },
        },
      };
    }

    // --- mode: "full" ---
    const filteredFindings = severityFilter
      ? allFindings.filter(f => f.severity === severityFilter)
      : allFindings;

    const totalCount = filteredFindings.length;
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
