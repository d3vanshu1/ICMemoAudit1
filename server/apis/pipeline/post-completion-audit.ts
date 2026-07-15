/**
 * Post-Completion Framing Audit (lightweight, runs in-memory)
 *
 * Called immediately after a pipeline run completes with findings + report text.
 * Checks for false-confidence framing patterns (bare [Code-Verified] tags,
 * "confirmed" language without backing data, etc.) and logs warnings.
 *
 * This is the inline hook counterpart to the full FramingPatternAudit API
 * which scans all historical reports from the database.
 */

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------
const BARE_CODE_VERIFIED = /\[Code-Verified\](?!\s*:)/gi;
const VALUED_CODE_VERIFIED = /\[Code-Verified:\s*[^\]]+\]/gi;

const CONFIDENCE_PATTERNS = [
  /code-verified\s+analysis\s+confirms?/gi,
  /confirmed\s+(model\s+integrity|arithmetic|by\s+code|contradiction)/gi,
  /SOURCE:\s*Deterministic\s+Arithmetic\s+Verification/gi,
  /Deterministic\s+Arithmetic\s+(Verification|Engine)/gi,
];

const FINDING_LEVEL_PATTERNS = [
  /code-verified/i,
  /confirmed\s+(by\s+code|model\s+integrity|arithmetic|contradiction)/i,
  /deterministic\s+(arithmetic|verification)/i,
  /\[Code-Verified[^\]]*\]/i,
];

// ---------------------------------------------------------------------------
// Hook function
// ---------------------------------------------------------------------------
export function runPostCompletionAudit(params: {
  runId: string;
  moduleId: string;
  reportText: string;
  findings: any[];
}): { flagged: boolean; warnings: string[] } {
  const { runId, moduleId, reportText, findings } = params;
  const warnings: string[] = [];

  // 1. Bare [Code-Verified] tags in report
  const bareMatches = [...reportText.matchAll(BARE_CODE_VERIFIED)];
  if (bareMatches.length > 0) {
    // Check if there are also valued tags (legitimate usage)
    const valuedMatches = [...reportText.matchAll(VALUED_CODE_VERIFIED)];
    if (valuedMatches.length === 0) {
      warnings.push(
        `${bareMatches.length} bare [Code-Verified] tag(s) with no matching [Code-Verified: value] tags`
      );
    }
  }

  // 2. Confidence language in report
  for (const pattern of CONFIDENCE_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = [...reportText.matchAll(pattern)];
    if (matches.length > 0) {
      warnings.push(`Report contains ${matches.length}× "${matches[0][0]}" pattern`);
    }
  }

  // 3. Finding-level confidence language
  for (const f of findings) {
    const combined = `${f.title || ""} | ${f.detail || ""} | ${f.full_analysis || ""}`;
    for (const fp of FINDING_LEVEL_PATTERNS) {
      const match = combined.match(fp);
      if (match) {
        warnings.push(
          `Finding "${(f.title || "").slice(0, 60)}" contains flagged pattern: "${match[0]}"`
        );
        break; // one flag per finding is sufficient
      }
    }
  }

  const flagged = warnings.length > 0;

  if (flagged) {
    console.warn(
      `[framing-audit] Run ${runId} (${moduleId}) flagged with ${warnings.length} pattern(s):\n` +
        warnings.map((w) => `  • ${w}`).join("\n")
    );
  }

  return { flagged, warnings };
}
