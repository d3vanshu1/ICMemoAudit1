/**
 * Regex patterns for suppressing fabricated arithmetic/reconciliation findings.
 *
 * LLM-generated findings that claim summation or reconciliation discrepancies are
 * unreliable (ad-hoc arithmetic on raw text). Only findings grounded in
 * NumericVerify's deterministic output are trustworthy.
 *
 * Validated against 6 acceptance cases:
 *   see pipeline/__tests__/reconciliation-filter.test.ts
 */
export const FABRICATED_ARITHMETIC_PATTERNS: RegExp[] = [
  // Original patterns (catch "Fails to Reconcile...sum", "Do Not Reconcile...sum", etc.)
  /\breconcil(?:e|iation|ing)\b.*\b(?:sum|total|add|subtotal)\b/i,
  /\b(?:sum|total|add(?:s|ing)?|subtotal)\b.*\b(?:does not|doesn't|don't|do not)\s+(?:match|equal|reconcile|agree)\b/i,
  /\b(?:adds? up to|sums? to|totals? to)\b.*\b(?:but|however|yet|whereas)\b/i,
  /\bperiodic values?\b.*\b(?:sum|total)\b.*\b(?:discrepan|mismatch|inconsisten)/i,
  /\barithmetic(?:al)?\s+(?:error|discrepancy|mismatch|inconsistency)\b/i,
  /\bmanual(?:ly)?\s+(?:sum|add|calculat|total|reconcil)/i,
  /\bcolumn[s]?\s+(?:sum|total|add)\b.*\b(?:variance|differ|mismatch|disagree)/i,
  // Second-pass patterns (catch "Irreconcilable", "cannot be reconciled", phrasing variants)
  /\birreconcil/i,
  /\bcannot\s+be\s+reconciled\b/i,
  /\bfails?\s+to\s+reconcile\b/i,
  /\bsum(?:s|ming)?\s+to\b.*\b(?:gap|shortfall|unexplained)\b/i,
  /\bdo\s+not\s+reconcile\b/i,
];
