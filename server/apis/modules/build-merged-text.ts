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
   *  memo_omission = present in evidence but absent from subject memo */
  gap_type?: "diligence_gap" | "memo_omission";
  /** Which evidence documents contain the information (for memo_omission findings) */
  evidence_docs?: string[];
  /** false when evidence comes solely from prior IC memos (team-authored, not independent third-party).
   *  true when corroborated by at least one non-ic_memo source. Omit when not applicable. */
  independent?: boolean;
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
