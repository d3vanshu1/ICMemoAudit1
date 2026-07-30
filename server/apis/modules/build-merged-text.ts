/**
 * Shared utility — builds the merged-text representation used as input to the
 * next tree-reduce round.  Called from:
 *   • merge-findings.ts  (after a live merge)
 *   • load-merge-checkpoints.ts  (to reconstruct stripped text on resume)
 *
 * Keeping this in one place guarantees byte-for-byte parity between fresh
 * merges and checkpoint-resumed merges.
 */

export interface MergedFinding {
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  full_analysis: string;
  source_docs: string[];
  claim_ids?: string[];
  absence_confidence?: string;
  /** Omission classification: diligence_gap = absent from subject AND evidence;
   *  memo_omission = present in evidence but absent from subject memo;
   *  open_item_acknowledged = record itself discloses item as open/pending */
  gap_type?: "diligence_gap" | "memo_omission" | "open_item_acknowledged";
  /** Which evidence documents contain the information (for memo_omission findings) */
  evidence_docs?: string[];
  /** false when evidence comes solely from prior IC memos (team-authored, not independent third-party).
   *  true when corroborated by at least one non-ic_memo source. Omit when not applicable. */
  independent?: boolean;
  /** Evidence trace array for numeric claims (Fix 3) */
  evidence?: Array<{ figure: string; source_doc: string; verbatim_snippet: string; verified: boolean }>;
  /** Whether the finding's core quantitative claim could not be traced to source text (Fix 3) */
  numeric_unverified?: boolean;
  /** One-line rationale for why this finding meets the IC-chair materiality threshold (Fix 4) */
  materiality_rationale?: string;
  /** Finding classification: principal_finding (default), housekeeping (sub-materiality), human_review_flag (emphasis-judgment) */
  category?: "principal_finding" | "housekeeping" | "human_review_flag";
  /** Severity anchor: the £ figure or source statement justifying the assigned severity (Fix 3 observability) */
  severity_anchor?: string;
  /** Finding kind: data_divergence (numeric/cross-version), source_stated_risk, absence_claim, process_observation */
  finding_kind?: "data_divergence" | "source_stated_risk" | "absence_claim" | "process_observation";
  /** Normalized issue key for global consolidation clustering (snake_case, e.g. "fca_authorisation_risk") */
  issue_key?: string;
  verification?: {
    status: "revised" | "upheld";
    evidenceQuoted?: string;
    evidenceSource?: string;
    queriesRun: string[];
  };
}

export function buildMergedText(
  executiveHeader: string,
  findings: MergedFinding[]
): string {
  return (
    `### Merged Findings (${findings.length} total)\n\n` +
    `**Executive Summary**: ${executiveHeader}\n\n` +
    findings
      .map(
        (f, i) =>
          `**Finding ${i + 1} [${f.severity}]**: ${f.title}\n` +
          `Detail: ${f.detail}\n` +
          `Analysis: ${f.full_analysis}\n` +
          `Sources: ${f.source_docs.join(", ")}` +
          (f.claim_ids && f.claim_ids.length > 0
            ? `\nClaim IDs: ${f.claim_ids.join(", ")}`
            : "")
      )
      .join("\n\n")
  );
}
