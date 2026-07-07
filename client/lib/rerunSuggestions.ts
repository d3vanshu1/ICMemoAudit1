import type { DocumentTag } from "@/types/document";

/**
 * Mapping from document type tag to module IDs that should be pre-selected
 * for re-run when a document with that tag is uploaded.
 */
const TAG_TO_MODULES: Record<DocumentTag, string[]> = {
  cim: [
    "omission_audit",
    "blind_spot_scanner",
    "ic_challenge_mode",
    "diligence_completeness",
    "contradiction_check",
  ],
  ic_memo: [
    "omission_audit",
    "contradiction_check",
    "ic_challenge_mode",
  ],
  customer_data: [
    "contradiction_check",
    "blind_spot_scanner",
    "diligence_completeness",
  ],
  consultant_report: ["contradiction_check", "blind_spot_scanner"],
  financial_model: ["model_assumptions_stress", "contradiction_check"],
  legal: ["omission_audit", "diligence_completeness"],
  other: ["omission_audit", "diligence_completeness"],
};

/**
 * Given a set of document tags from newly uploaded files,
 * returns a de-duplicated list of module IDs that should be
 * pre-selected for re-run.
 */
export function getSuggestedModules(tags: DocumentTag[]): string[] {
  const suggested = new Set<string>();
  for (const tag of tags) {
    const modules = TAG_TO_MODULES[tag] ?? TAG_TO_MODULES.other;
    for (const moduleId of modules) {
      suggested.add(moduleId);
    }
  }
  return Array.from(suggested);
}
