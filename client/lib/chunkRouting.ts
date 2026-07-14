/**
 * Chunk Routing — maps document tags to relevant analysis modules.
 *
 * The universal extraction runs on EVERY chunk (all images + text preserved).
 * Routing only controls which modules receive each extraction during the
 * merge phase, reducing the number of merge calls significantly.
 *
 * Chunks tagged "other" are sent to ALL modules as a safe default.
 */

import type { DocumentTag } from "@/types/document";

// ---------------------------------------------------------------------------
// Routing table: which document tags are relevant to which modules
// ---------------------------------------------------------------------------

/**
 * For each module, the set of document tags whose chunks should be
 * routed to that module's merge pipeline.
 *
 * Design principles:
 * - Omission Audit & Diligence Completeness receive ALL doc types
 *   (they assess completeness across the entire data room)
 * - Contradiction Check receives ALL doc types (contradictions can
 *   emerge between any pair of documents)
 * - Financial-focused modules skip legal-only and pure narrative docs
 * - Social/reputation modules skip financial models and legal docs
 * - "other" always goes everywhere (safe default)
 */
const MODULE_TAG_RELEVANCE: Record<string, Set<DocumentTag>> = {
  // Receives ALL — assesses what's missing across entire data room
  omission_audit: new Set([
    "cim",
    "ic_memo",
    "customer_data",
    "consultant_report",
    "financial_model",
    "legal",
    "other",
  ]),

  // Receives ALL — contradictions can exist between any document pair
  contradiction_check: new Set([
    "cim",
    "ic_memo",
    "customer_data",
    "consultant_report",
    "financial_model",
    "legal",
    "other",
  ]),

  // Thesis + assumptions live primarily in CIM, IC memo, consultant reports
  // Financial models contain implicit assumptions too
  blind_spot_scanner: new Set([
    "cim",
    "ic_memo",
    "consultant_report",
    "financial_model",
    "other",
  ]),

  // Extracts deal material for cross-referencing against external research
  // Legal and customer data provide key risk signals
  external_risk_overlay: new Set([
    "cim",
    "ic_memo",
    "customer_data",
    "consultant_report",
    "legal",
    "other",
  ]),

  // Social/reputation signals come from narrative docs, not financial models
  social_reputation: new Set([
    "cim",
    "ic_memo",
    "consultant_report",
    "customer_data",
    "other",
  ]),

  // IC challenge questions target the thesis/risks/assumptions
  ic_challenge_mode: new Set([
    "cim",
    "ic_memo",
    "consultant_report",
    "financial_model",
    "other",
  ]),

  // Model assumptions primarily in IC memo, financial models, and CIM projections
  model_assumptions_stress: new Set([
    "ic_memo",
    "financial_model",
    "cim",
    "consultant_report",
    "other",
  ]),

  // Receives ALL — scores completeness across all 10 dimensions
  diligence_completeness: new Set([
    "cim",
    "ic_memo",
    "customer_data",
    "consultant_report",
    "financial_model",
    "legal",
    "other",
  ]),

  // Executive Summary operates on module outputs, not document chunks
  // Included here for completeness but routing is N/A
  executive_summary: new Set([
    "cim",
    "ic_memo",
    "customer_data",
    "consultant_report",
    "financial_model",
    "legal",
    "other",
  ]),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TaggedExtraction {
  label: string;
  extraction: string;
  chunkIndex: number;
  sourceFile: string;
  documentTag: DocumentTag;
  /** When true, extraction failed and this entry should not be cached or routed to modules */
  failed?: boolean;
}

/**
 * Given all universal extractions (with their document tags) and a module ID,
 * returns only the extractions relevant to that module.
 */
export function getExtractionsForModule(
  allExtractions: TaggedExtraction[],
  moduleId: string
): TaggedExtraction[] {
  // Always exclude failed extractions — they contain error placeholders, not document text
  const valid = allExtractions.filter((ext) => !ext.failed);

  const relevantTags = MODULE_TAG_RELEVANCE[moduleId];

  // If module has no routing config, send everything (safe default)
  if (!relevantTags) return valid;

  return valid.filter((ext) => relevantTags.has(ext.documentTag));
}

/**
 * Returns the set of relevant document tags for a given module.
 * Useful for showing users which doc types will be analyzed.
 */
export function getRelevantTagsForModule(
  moduleId: string
): Set<DocumentTag> | null {
  return MODULE_TAG_RELEVANCE[moduleId] ?? null;
}
