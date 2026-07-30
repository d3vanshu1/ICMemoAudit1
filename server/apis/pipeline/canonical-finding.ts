/**
 * canonical-finding.ts
 *
 * THE one canonical finding schema and parser for the IC Diligence pipeline.
 *
 * Audit finding #4 (RC1): every boundary that touches findings must import
 * from this module. No inline schemas, no manual field-extraction maps.
 *
 * Boundaries covered:
 *   - merge-findings.ts         (parse LLM merge output)
 *   - pipeline-core.ts          (checkpoint write/read, runPostMergePipeline)
 *   - absence-verification-phase.ts (checkpoint by finding_id, not index)
 *   - claims-reconciliation.ts  (ReconciliationFinding → CanonicalFinding)
 *   - upsert-module-output.ts   (canonical findings to DB)
 *   - get-run-output.ts         (canonical findings from DB)
 *   - load-module-results.ts    (canonical findings from DB)
 *   - export-findings.ts        (canonical findings from DB)
 *
 * Identity rules (from design review):
 *   finding_id    – UUID v4, assigned once at parse/creation, immutable thereafter.
 *                   Persisted in every checkpoint. On merge, the representative
 *                   gets a NEW UUID; merged_from_finding_ids carries the input IDs.
 *   claim_id      – content-addressed: documentId:contentHashPrefix:chunkId:claimIndex
 *                   (separate identity, see claims-extraction.ts)
 */

import { z } from "@superblocksteam/sdk-api";

// ---------------------------------------------------------------------------
// Cross-environment UUID v4 — avoids Node `crypto` import that Vite externalizes
// ---------------------------------------------------------------------------
function randomUUID(): string {
  // Use the Web Crypto API (available in Node 19+ as globalThis.crypto.randomUUID,
  // and in all modern browsers). Falls back to a pure-JS implementation.
  if (typeof globalThis !== "undefined" && typeof (globalThis as any).crypto?.randomUUID === "function") {
    return (globalThis as any).crypto.randomUUID() as string;
  }
  // RFC 4122 v4 UUID — pure JS fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

/** Structured evidence entry. The `metric` and `period` fields enable coordinate-
 *  based resolution in Layer-1 numeric validation (Defect 5). */
export const EvidenceItemSchema = z.object({
  figure: z.string(),
  source_doc: z.string(),
  verbatim_snippet: z.string(),
  verified: z.boolean(),
  /** Structured metric name (e.g. "revenue", "ebitda") — enables coordinate resolution */
  metric: z.string().optional(),
  /** Period (e.g. "FY2024", "H1 2025") — enables coordinate resolution */
  period: z.string().optional(),
});

export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

/** Structured impact/delta — required for deterministic materiality attribution.
 *  Only verified roles drive the £-floor threshold. */
export const StructuredImpactSchema = z.object({
  /** Value in the stated units (e.g. 19000 for £19k) */
  amount: z.number(),
  currency: z.enum(["GBP", "USD", "EUR", "other"]).default("GBP"),
  /** Units for the amount: thousands=1000, millions=1_000_000, billions=1_000_000_000, raw=1 */
  unit_multiplier: z.number().default(1),
  /** Role of this figure in the finding */
  role: z.enum([
    "delta",          // the difference / discrepancy
    "exposure",       // maximum downside
    "annual_impact",  // recurring annual effect
    "deal_value",     // reference (EV) — cannot drive threshold alone
    "threshold",      // materiality threshold comparison value
    "context",        // contextual reference — cannot drive threshold
  ]),
  /** Source coordinate: document + page/cell/row */
  source_doc: z.string().optional(),
  source_coordinate: z.string().optional(),
  /** Whether this amount was verified by the deterministic NumericVerify pass */
  verified: z.boolean().default(false),
});

export type StructuredImpact = z.infer<typeof StructuredImpactSchema>;

/** Absence verification result (stored on the finding after verification phase) */
export const VerificationSchema = z.object({
  status: z.enum(["revised", "upheld", "verification_error", "failed_retryable"]),
  revisedDetail: z.string().optional(),
  evidenceQuoted: z.string().optional(),
  evidenceSource: z.string().optional(),
  reasoning: z.string().optional(),
  queriesRun: z.array(z.string()),
});

export type Verification = z.infer<typeof VerificationSchema>;

// ---------------------------------------------------------------------------
// Canonical Finding Schema
// ---------------------------------------------------------------------------

/** The one and only finding schema used at every boundary. */
export const CanonicalFindingSchema = z.object({
  // --- Identity ---
  /** UUID v4. Assigned once at parse from LLM output; immutable thereafter.
   *  On merge: representative gets a new UUID; inputs become merged_from_finding_ids. */
  finding_id: z.string().uuid(),
  /** IDs of findings merged into this one. Empty/absent for raw extraction findings. */
  merged_from_finding_ids: z.array(z.string().uuid()).optional(),

  // --- Core content ---
  severity: z.enum(["critical", "warning", "info"]),
  title: z.string().min(1),
  detail: z.string(),
  full_analysis: z.string(),
  source_docs: z.array(z.string()),

  // --- Classification ---
  /** Overall finding classification */
  category: z.enum(["principal_finding", "housekeeping", "human_review_flag"]).optional(),
  /** Specific finding kind — required for numeric validation, reconciliation, materiality */
  finding_kind: z.enum([
    "data_divergence",
    "source_stated_risk",
    "absence_claim",
    "process_observation",
  ]).optional(),
  /** Issue key for semantic consolidation clustering (snake_case, e.g. "fca_authorisation_risk") */
  issue_key: z.string().optional(),

  // --- Severity & materiality ---
  /** The £ figure or source statement justifying the severity assignment.
   *  Required for critical findings — used by materiality gate. */
  severity_anchor: z.string().optional(),
  /** Structured impact/delta — enables deterministic materiality attribution.
   *  Only entries with role=delta/exposure/annual_impact and verified=true drive the threshold. */
  structured_impact: z.array(StructuredImpactSchema).optional(),
  /** Code-enforced rationale for materiality demotion/confirmation */
  materiality_rationale: z.string().optional(),

  // --- Numeric verification ---
  /** Whether the core quantitative claim could not be traced to verified source text */
  numeric_unverified: z.boolean().optional(),
  /** Structured evidence array for numeric claims */
  evidence: z.array(EvidenceItemSchema).optional(),

  // --- Absence / omission fields ---
  absence_confidence: z.enum(["verified_absent", "likely_absent", "unverified"]).optional(),
  gap_type: z.enum(["diligence_gap", "memo_omission", "open_item_acknowledged"]).optional(),
  evidence_docs: z.array(z.string()).optional(),
  independent: z.boolean().optional(),
  /** Absence verification result (populated by absence-verification-phase) */
  verification: VerificationSchema.optional(),

  // --- Provenance ---
  /** Claim IDs (content-addressed: documentId:contentHashPrefix:chunkId:claimIndex) */
  claim_ids: z.array(z.string()).optional(),
});

export type CanonicalFinding = z.infer<typeof CanonicalFindingSchema>;

// ---------------------------------------------------------------------------
// ParseResult — the canonical parser NEVER silently drops
// ---------------------------------------------------------------------------

export interface ParsedFinding {
  finding: CanonicalFinding;
  /** true if the finding had all required fields; false if any were coerced/defaulted */
  valid: boolean;
  /** Human-readable list of field issues (non-empty when valid=false) */
  issues: string[];
}

export interface ParseResult {
  findings: CanonicalFinding[];
  /** Items where schema validation found issues — NOT silently discarded */
  invalid: ParsedFinding[];
  /** true if the LLM response was truncated (max_tokens hit) */
  truncated: boolean;
  /** Number of items that were irrecoverably malformed (neither valid nor coercible) */
  malformed_count: number;
}

// ---------------------------------------------------------------------------
// Canonical parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw JSON array (from LLM output or a checkpoint) into canonical findings.
 *
 * Mode "fresh": assigns new UUIDs to findings lacking finding_id.
 * Mode "reload": preserves existing finding_id from the array; missing IDs are an error.
 *
 * NEVER silently skips items. Invalid items go to ParseResult.invalid with diagnostics.
 */
export function parseCanonicalFindings(
  raw: unknown,
  options: {
    mode: "fresh" | "reload";
    /** Source context for error messages */
    source?: string;
    /** If true, the LLM stop_reason was max_tokens (output was truncated) */
    truncated?: boolean;
  }
): ParseResult {
  const { mode, source = "unknown", truncated = false } = options;
  const findings: CanonicalFinding[] = [];
  const invalid: ParsedFinding[] = [];
  let malformed_count = 0;

  if (!Array.isArray(raw)) {
    malformed_count++;
    console.error(`[canonical-finding] parseCanonicalFindings: expected array, got ${typeof raw} (source=${source})`);
    return { findings: [], invalid: [], truncated, malformed_count };
  }

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const itemSource = `${source}[${i}]`;

    if (!item || typeof item !== "object") {
      malformed_count++;
      console.error(`[canonical-finding] Item ${i} is not an object (source=${source})`);
      continue;
    }

    const obj = item as Record<string, unknown>;
    const itemIssues: string[] = [];
    let isValid = true;

    // --- finding_id ---
    let finding_id: string;
    if (typeof obj.finding_id === "string" && isValidUUID(obj.finding_id)) {
      finding_id = obj.finding_id;
    } else if (mode === "fresh") {
      // Fresh parse from LLM — assign a new UUID
      finding_id = randomUUID();
      if (obj.finding_id !== undefined) {
        itemIssues.push(`finding_id was present but invalid ("${obj.finding_id}") — replaced with new UUID`);
      }
    } else {
      // Reload from checkpoint — missing/invalid finding_id is an error
      itemIssues.push(`finding_id missing or invalid in checkpoint (source=${itemSource}) — assigned new UUID`);
      isValid = false;
      finding_id = randomUUID();
    }

    // --- severity ---
    let severity: "critical" | "warning" | "info";
    if (obj.severity === "critical" || obj.severity === "warning" || obj.severity === "info") {
      severity = obj.severity;
    } else {
      itemIssues.push(`severity invalid ("${obj.severity}") — defaulted to "info"`);
      isValid = false;
      severity = "info";
    }

    // --- required strings ---
    const title = typeof obj.title === "string" && obj.title.trim().length > 0
      ? obj.title.trim()
      : ((): string => {
          itemIssues.push(`title missing or empty — using placeholder`);
          isValid = false;
          return "[MISSING TITLE]";
        })();

    const detail = typeof obj.detail === "string" ? obj.detail : ((): string => {
      itemIssues.push(`detail not a string — coerced to empty string`);
      return "";
    })();

    const full_analysis = typeof obj.full_analysis === "string"
      ? obj.full_analysis
      : typeof obj.detail === "string"
        ? obj.detail
        : ((): string => {
            itemIssues.push(`full_analysis missing — coerced to empty string`);
            return "";
          })();

    const source_docs = Array.isArray(obj.source_docs)
      ? obj.source_docs.map(String)
      : ((): string[] => {
          itemIssues.push(`source_docs missing or not array — defaulted to []`);
          return [];
        })();

    // --- classification ---
    const finding_kind = parseEnum(obj.finding_kind, [
      "data_divergence", "source_stated_risk", "absence_claim", "process_observation",
    ] as const, itemSource, itemIssues);

    const category = parseEnum(obj.category, [
      "principal_finding", "housekeeping", "human_review_flag",
    ] as const, itemSource, itemIssues);

    const issue_key = typeof obj.issue_key === "string" && obj.issue_key.trim()
      ? obj.issue_key.trim()
      : undefined;

    // --- severity & materiality ---
    const severity_anchor = typeof obj.severity_anchor === "string" && obj.severity_anchor
      ? obj.severity_anchor
      : undefined;

    const materiality_rationale = typeof obj.materiality_rationale === "string" && obj.materiality_rationale
      ? obj.materiality_rationale
      : undefined;

    // structured_impact: parse array, skip malformed entries but log them
    const structured_impact = parseStructuredImpact(obj.structured_impact, itemSource, itemIssues);

    // --- numeric verification ---
    const numeric_unverified = typeof obj.numeric_unverified === "boolean"
      ? obj.numeric_unverified
      : undefined;

    const evidence = parseEvidenceArray(obj.evidence, itemSource, itemIssues);

    // --- absence / omission ---
    const absence_confidence = parseEnum(obj.absence_confidence, [
      "verified_absent", "likely_absent", "unverified",
    ] as const, itemSource, itemIssues);

    const gap_type = parseEnum(obj.gap_type, [
      "diligence_gap", "memo_omission", "open_item_acknowledged",
    ] as const, itemSource, itemIssues);

    const evidence_docs = Array.isArray(obj.evidence_docs)
      ? obj.evidence_docs.map(String)
      : undefined;

    const independent = typeof obj.independent === "boolean" ? obj.independent : undefined;

    const verification = parseVerification(obj.verification, itemSource, itemIssues);

    // --- provenance ---
    const claim_ids = Array.isArray(obj.claim_ids) && obj.claim_ids.length > 0
      ? obj.claim_ids.map(String)
      : undefined;

    const merged_from_finding_ids = Array.isArray(obj.merged_from_finding_ids)
      ? obj.merged_from_finding_ids.filter(id => typeof id === "string" && isValidUUID(id))
      : undefined;

    // --- Apply numeric_unverified severity cap ---
    const finalSeverity = numeric_unverified === true && severity !== "info" ? "info" : severity;
    if (finalSeverity !== severity) {
      itemIssues.push(`numeric_unverified=true — severity capped from "${severity}" to "info"`);
    }

    // --- Build canonical finding ---
    const finding: CanonicalFinding = {
      finding_id,
      severity: finalSeverity,
      title,
      detail,
      full_analysis,
      source_docs,
    };

    // Only set optional fields when present (keeps serialized JSON lean)
    if (merged_from_finding_ids && merged_from_finding_ids.length > 0) finding.merged_from_finding_ids = merged_from_finding_ids;
    if (category !== undefined) finding.category = category;
    if (finding_kind !== undefined) finding.finding_kind = finding_kind;
    if (issue_key !== undefined) finding.issue_key = issue_key;
    if (severity_anchor !== undefined) finding.severity_anchor = severity_anchor;
    if (structured_impact && structured_impact.length > 0) finding.structured_impact = structured_impact;
    if (materiality_rationale !== undefined) finding.materiality_rationale = materiality_rationale;
    if (numeric_unverified !== undefined) finding.numeric_unverified = numeric_unverified;
    if (evidence && evidence.length > 0) finding.evidence = evidence;
    if (absence_confidence !== undefined) finding.absence_confidence = absence_confidence;
    if (gap_type !== undefined) finding.gap_type = gap_type;
    if (evidence_docs && evidence_docs.length > 0) finding.evidence_docs = evidence_docs;
    if (independent !== undefined) finding.independent = independent;
    if (verification !== undefined) finding.verification = verification;
    if (claim_ids && claim_ids.length > 0) finding.claim_ids = claim_ids;

    if (!isValid || itemIssues.length > 0) {
      invalid.push({ finding, valid: isValid, issues: itemIssues });
      if (!isValid) {
        console.warn(`[canonical-finding] Invalid finding at ${itemSource}: ${itemIssues.join("; ")}`);
      }
    }

    findings.push(finding);
  }

  if (truncated) {
    console.warn(`[canonical-finding] Response was truncated (max_tokens hit, source=${source}) — result is PARTIAL`);
  }

  return { findings, invalid, truncated, malformed_count };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  _source: string,
  _issues: string[],
): T | undefined {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  // Don't warn on undefined — it just means the field was absent
  return undefined;
}

function parseEvidenceArray(
  raw: unknown,
  source: string,
  issues: string[],
): EvidenceItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: EvidenceItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (!e || typeof e !== "object") {
      issues.push(`evidence[${i}] not an object — skipped`);
      continue;
    }
    const obj = e as Record<string, unknown>;
    const item: EvidenceItem = {
      figure: typeof obj.figure === "string" ? obj.figure : String(obj.figure ?? ""),
      source_doc: typeof obj.source_doc === "string" ? obj.source_doc : String(obj.source_doc ?? ""),
      verbatim_snippet: typeof obj.verbatim_snippet === "string" ? obj.verbatim_snippet : "",
      verified: obj.verified === true,
    };
    if (typeof obj.metric === "string" && obj.metric) item.metric = obj.metric;
    if (typeof obj.period === "string" && obj.period) item.period = obj.period;
    result.push(item);
  }
  return result.length > 0 ? result : undefined;
}

function parseStructuredImpact(
  raw: unknown,
  source: string,
  issues: string[],
): StructuredImpact[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: StructuredImpact[] = [];
  const validRoles = ["delta", "exposure", "annual_impact", "deal_value", "threshold", "context"] as const;
  const validCurrencies = ["GBP", "USD", "EUR", "other"] as const;

  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (!e || typeof e !== "object") {
      issues.push(`structured_impact[${i}] not an object — skipped`);
      continue;
    }
    const obj = e as Record<string, unknown>;
    const amount = typeof obj.amount === "number" ? obj.amount : parseFloat(String(obj.amount ?? "NaN"));
    if (isNaN(amount)) {
      issues.push(`structured_impact[${i}].amount not parseable — skipped`);
      continue;
    }
    const role = (validRoles as readonly string[]).includes(String(obj.role))
      ? obj.role as typeof validRoles[number]
      : ((): typeof validRoles[number] => {
          issues.push(`structured_impact[${i}].role invalid ("${obj.role}") — defaulted to "context"`);
          return "context";
        })();

    const currency = (validCurrencies as readonly string[]).includes(String(obj.currency))
      ? obj.currency as typeof validCurrencies[number]
      : "GBP";

    const unit_multiplier = typeof obj.unit_multiplier === "number" && obj.unit_multiplier > 0
      ? obj.unit_multiplier
      : 1;

    result.push({
      amount,
      currency,
      unit_multiplier,
      role,
      source_doc: typeof obj.source_doc === "string" ? obj.source_doc : undefined,
      source_coordinate: typeof obj.source_coordinate === "string" ? obj.source_coordinate : undefined,
      verified: obj.verified === true,
    });
  }
  return result.length > 0 ? result : undefined;
}

function parseVerification(
  raw: unknown,
  source: string,
  issues: string[],
): Verification | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const validStatuses = ["revised", "upheld", "verification_error", "failed_retryable"] as const;
  const status = (validStatuses as readonly string[]).includes(String(obj.status))
    ? obj.status as typeof validStatuses[number]
    : ((): typeof validStatuses[number] => {
        issues.push(`verification.status invalid ("${obj.status}") — defaulted to "verification_error"`);
        return "verification_error";
      })();

  return {
    status,
    revisedDetail: typeof obj.revisedDetail === "string" ? obj.revisedDetail : undefined,
    evidenceQuoted: typeof obj.evidenceQuoted === "string" ? obj.evidenceQuoted : undefined,
    evidenceSource: typeof obj.evidenceSource === "string" ? obj.evidenceSource : undefined,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : undefined,
    queriesRun: Array.isArray(obj.queriesRun) ? obj.queriesRun.map(String) : [],
  };
}

// ---------------------------------------------------------------------------
// Convenience: assign finding_id to a batch that may have come from pre-id code
// ---------------------------------------------------------------------------

/**
 * Ensure every finding in the array has a finding_id.
 * Used for findings produced by code paths (reconciliation, materiality gate, etc.)
 * that construct CanonicalFinding objects directly rather than through the parser.
 */
export function ensureFindingIds(findings: CanonicalFinding[]): CanonicalFinding[] {
  return findings.map(f => (f.finding_id && isValidUUID(f.finding_id)) ? { ...f } : { ...f, finding_id: randomUUID() });
}

/**
 * Construct a new merged finding from a cluster of input findings.
 * The representative gets a new UUID; merged_from_finding_ids lists all input IDs.
 */
export function buildMergedFinding(
  representative: CanonicalFinding,
  allMembers: CanonicalFinding[],
): CanonicalFinding {
  const merged_from_finding_ids = allMembers.map(m => m.finding_id);
  return {
    ...representative,
    finding_id: randomUUID(),
    merged_from_finding_ids,
  };
}

/**
 * Validate that a JSON blob from the DB round-trips through the canonical schema.
 * Returns { ok: true, findings } or { ok: false, errors }.
 */
export function validateFindingsFromDB(raw: unknown): { ok: true; findings: CanonicalFinding[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(raw)) {
    return { ok: false, errors: [`Expected array, got ${typeof raw}`] };
  }
  const result = parseCanonicalFindings(raw, { mode: "reload", source: "db" });
  if (result.malformed_count > 0) {
    return { ok: false, errors: [`${result.malformed_count} malformed items`] };
  }
  if (result.findings.length === 0 && raw.length > 0) {
    return { ok: false, errors: ["All items failed to parse"] };
  }
  return { ok: true, findings: result.findings };
}
