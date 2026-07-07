// ---------------------------------------------------------------------------
// Shared constants for analysis modules
// ---------------------------------------------------------------------------
// IMPORTANT: If you update this list, also update client/lib/moduleConfig.ts
// which re-declares the same constant for the client bundle.
// ---------------------------------------------------------------------------

/**
 * Module IDs that receive numeric verification reports as authoritative input.
 * These modules cross-reference LLM findings against code-verified arithmetic.
 */
export const NUMERIC_MODULE_IDS = [
  "model_assumptions_stress",
  "contradiction_check",
] as const;

export type NumericModuleId = (typeof NUMERIC_MODULE_IDS)[number];

/** Pre-built Set for O(1) membership checks */
export const NUMERIC_MODULES = new Set<string>(NUMERIC_MODULE_IDS);
