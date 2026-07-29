/**
 * Claims Reconciliation Engine — code-verified delta computation.
 *
 * ARCHITECTURE PRINCIPLE (non-negotiable):
 *   LLM proposes which model line a claim maps to.
 *   CODE pulls the model cell and computes the delta.
 *   No LLM-computed numbers anywhere.
 *
 * For each claim in the ledger (operating_metric category only):
 *   1. LLM proposes the matching model line by metric + scope_qualifier + period,
 *      or returns "no matching model line."
 *   2. Code pulls that model cell value from the verified figures set.
 *   3. Code computes the delta and classifies:
 *      - Matched scope + delta above materiality floor → data_divergence finding
 *      - Matched scope + within tolerance → no finding (or housekeeping)
 *      - No model counterpart → unreconcilable (info)
 *      - Scope mismatch → NEVER assert contradiction; flag "confirm like-for-like basis"
 *
 * Also runs the existing live-vs-hardcoded cross-version check and surfaces
 * it as a data_divergence finding.
 */
import { z } from "@superblocksteam/sdk-api";
import type { Claim, ClaimsLedger } from "./claims-extraction.js";
import type { Figure, Discrepancy } from "./numeric-verify-inline.js";
import { callLLMWithHeadroom, type LLMResponse } from "./call-llm.js";
import { SONNET_MODEL } from "./model-config.js";
import type { PipelineContext } from "./pipeline-config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconciliationFinding {
  finding_kind: "data_divergence" | "unreconcilable" | "scope_mismatch" | "cross_version";
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  full_analysis: string;
  /** Numeric magnitude — for materiality-based severity tiering */
  severity_anchor: number | null;
  /** Source documents — derived in code, not LLM free-listed */
  source_docs: string[];
  /** The original claim that triggered this finding */
  claim: Claim;
  /** The matched model figure (null if unreconcilable) */
  model_figure: Figure | null;
  /** Computed delta (code-verified, never LLM-computed) */
  delta_abs: number | null;
  delta_pct: number | null;
}

export interface ReconciliationResult {
  findings: ReconciliationFinding[];
  reconciled_count: number;
  unreconcilable_count: number;
  scope_mismatch_count: number;
  within_tolerance_count: number;
  cross_version_findings: number;
}

/** LLM match proposal for a single claim */
interface MatchProposal {
  claim_index: number;
  match_status: "matched" | "no_model_line" | "scope_mismatch";
  /** When matched: the exact figure label from the verified figures list */
  matched_label: string | null;
  /** When matched: the period to look up */
  matched_period: string | null;
  /** When scope_mismatch: explanation of why scopes differ */
  mismatch_reason: string | null;
}

// ---------------------------------------------------------------------------
// Unit compatibility & basis alignment guards (Fix 3)
// ---------------------------------------------------------------------------

/** Coarse unit families for compatibility checking */
type UnitFamily = "absolute_gbp" | "rate_pct" | "multiplier" | "count" | "unknown";

function classifyClaimUnit(unit: string): UnitFamily {
  const u = unit.trim().toLowerCase();
  if (u === "£m" || u === "£k" || u === "£" || u === "£bn") return "absolute_gbp";
  if (u === "%" || u === "bps" || u === "pp") return "rate_pct";
  if (u === "x" || u === "turns") return "multiplier";
  if (u === "#" || u === "headcount" || u === "units") return "count";
  return "unknown";
}

/**
 * Classify what unit family a model figure likely represents.
 * Model figures store raw £ values (absolute) unless the label/context
 * clearly indicates a percentage or multiple.
 */
function classifyModelFigureUnit(fig: Figure): UnitFamily {
  const label = fig.name.toLowerCase();
  // Rate indicators in the figure label
  if (label.includes("margin") || label.includes("growth") || label.includes("%") ||
      label.includes("nrr") || label.includes("churn") || label.includes("recurring %") ||
      label.includes("retention") || label.includes("conversion rate") ||
      label.includes("yield")) {
    return "rate_pct";
  }
  // Multiplier indicators
  if (label.includes(" multiple") || label.includes(" x ") || label.includes("ev/") ||
      label.includes("turns")) {
    return "multiplier";
  }
  // Headcount / count
  if (label.includes("headcount") || label.includes("fte") || label.includes("# of")) {
    return "count";
  }
  // Default: model figures are £ absolutes (stored in raw £)
  return "absolute_gbp";
}

/**
 * Returns true if claim unit and model figure unit families are compatible.
 * Incompatible pairs should NEVER be reconciled — they'd produce false divergences.
 */
function unitsAreCompatible(claimFamily: UnitFamily, modelFamily: UnitFamily): boolean {
  // If either is unknown, we can't assert incompatibility — allow match (be conservative)
  if (claimFamily === "unknown" || modelFamily === "unknown") return true;
  // Same family is always compatible
  if (claimFamily === modelFamily) return true;
  // All other cross-family combinations are incompatible
  return false;
}

/**
 * Basis alignment check: even when the LLM says "matched" and units technically align,
 * verify that a scope_qualifier of "Total Group Revenue" on a rate/percentage claim
 * is not being matched to an absolute revenue figure. This catches the lazy-default
 * scenario where extraction tagged "96% recurring" with scope "Total Group Revenue"
 * and reconciliation matches it to the actual revenue line.
 */
function basisGenuinelyAligns(claim: Claim, modelFig: Figure): boolean {
  const claimFamily = classifyClaimUnit(claim.unit);
  const modelFamily = classifyModelFigureUnit(modelFig);

  // Cross-family match that slipped past unit guard (shouldn't happen, but defense in depth)
  if (!unitsAreCompatible(claimFamily, modelFamily)) return false;

  // Rate claim matched to a revenue/absolute model line by coincidental scope string
  // e.g., claim "96% recurring" scope="Total Group Revenue" matched to model "Total Revenue"
  if (claimFamily === "rate_pct" && modelFamily === "absolute_gbp") return false;
  if (claimFamily === "absolute_gbp" && modelFamily === "rate_pct") return false;

  return true;
}

// ---------------------------------------------------------------------------
// Materiality thresholds
// ---------------------------------------------------------------------------
const MATERIALITY_ABS_FLOOR = 2_000_000; // £2m — below this, delta is not material
const MATERIALITY_REL_FLOOR = 0.05;      // 5% — below this, delta is not material
const CRITICAL_ABS_THRESHOLD = 10_000_000; // £10m — above this, finding is critical
const CRITICAL_REL_THRESHOLD = 0.15;       // 15%

// ---------------------------------------------------------------------------
// LLM Matching Prompt
// ---------------------------------------------------------------------------

function buildMatchingPrompt(claims: Claim[], figures: Figure[]): string {
  // Build a de-duplicated figure reference list (label + period pairs)
  const figureEntries = new Map<string, Set<string>>();
  for (const fig of figures) {
    if (!figureEntries.has(fig.name)) figureEntries.set(fig.name, new Set());
    figureEntries.get(fig.name)!.add(fig.period);
  }

  const figureRef = Array.from(figureEntries.entries())
    .map(([label, periods]) => `  "${label}" → periods: [${Array.from(periods).join(", ")}]`)
    .join("\n");

  const claimsList = claims
    .map((c, i) => `  [${i}] metric="${c.metric}" scope="${c.scope_qualifier}" period="${c.period}" value=${c.value}${c.unit} basis="${c.basis_note}"`)
    .join("\n");

  return `You are matching IC memo financial claims against verified model figures.

## Available Model Figures (from the financial model, code-read cell values)

${figureRef}

## Claims to Match

${claimsList}

## Matching Rules

For each claim, determine:
1. **matched** — The claim's metric + scope maps to a specific model figure label AND the period aligns.
   Return the EXACT label string and period from the Available Model Figures list.
   
2. **no_model_line** — The claim describes a metric/scope that has NO counterpart in the model figures.
   Examples: "PEP Cash EBITDA (Organic)" when only "EBITDA" and "Adjusted EBITDA" exist;
   returns metrics (IRR, MoM); structuring EBITDA not in operating model.
   
3. **scope_mismatch** — The claim's BASE metric exists in the model (e.g., both say "revenue") 
   but the scope qualifiers are DIFFERENT and therefore not directly comparable.
   Examples: memo says "Revenue (PF)" but model has "Total revenue (excl. future M&A)";
   memo says "Run-rate EBITDA" but model has annual reported EBITDA.
   
## CRITICAL: Never force a match across scope boundaries.
- "Revenue (PF)" ≠ "Total revenue (excl. future M&A)" — these are DIFFERENT metrics
- "Run-rate" ≠ "FY actual" — different temporal basis
- "Organic Cash EBITDA" ≠ "Adjusted EBITDA" — different adjustments
- If the scope qualifiers differ AT ALL, return scope_mismatch, NOT matched

## Output Format

Return a JSON array with one object per claim (same order as input):
[
  { "claim_index": 0, "match_status": "matched", "matched_label": "Total Revenue", "matched_period": "2026", "mismatch_reason": null },
  { "claim_index": 1, "match_status": "no_model_line", "matched_label": null, "matched_period": null, "mismatch_reason": null },
  { "claim_index": 2, "match_status": "scope_mismatch", "matched_label": null, "matched_period": null, "mismatch_reason": "Claim is PF revenue, model is excl-M&A" }
]

Return ONLY the JSON array. No markdown fences, no commentary.`;
}

// ---------------------------------------------------------------------------
// Main reconciliation function
// ---------------------------------------------------------------------------

/**
 * Reconcile extracted claims against verified model figures.
 *
 * @param ctx Pipeline context
 * @param ledger The claims ledger from claim extraction
 * @param figures Verified figures from numeric-verify-inline
 * @param discrepancies Cross-version discrepancies from numeric-verify-inline
 * @param pipelineStartTime For headroom calculations
 * @param timeBudgetMs Max time for this phase
 */
export async function runReconciliation(
  ctx: PipelineContext,
  ledger: ClaimsLedger,
  figures: Figure[],
  discrepancies: Discrepancy[],
  pipelineStartTime: number,
  timeBudgetMs: number,
): Promise<ReconciliationResult> {
  const phaseStart = Date.now();
  console.log(`[Reconciliation] Starting — ${ledger.claims.length} claims, ${figures.length} figures, budget ${Math.round(timeBudgetMs / 1000)}s`);

  const findings: ReconciliationFinding[] = [];
  let reconciled_count = 0;
  let unreconcilable_count = 0;
  let scope_mismatch_count = 0;
  let within_tolerance_count = 0;

  // ----- Step 1: Filter to operating_metric claims only (reconcilable) -----
  const reconcilableClaims = ledger.claims.filter(c => c.claim_category === "operating_metric");
  const nonReconcilable = ledger.claims.filter(c => c.claim_category !== "operating_metric");

  console.log(`[Reconciliation] ${reconcilableClaims.length} operating_metric claims to reconcile, ${nonReconcilable.length} non-reconcilable (tagged)`);

  // ----- Step 2: Emit unreconcilable findings for notable non-operating claims -----
  // Only valuation_structuring claims that reference specific £ amounts get INFO findings
  for (const claim of nonReconcilable) {
    if (claim.claim_category === "valuation_structuring" && claim.unit === "£m" && claim.value > 50) {
      findings.push({
        finding_kind: "unreconcilable",
        severity: "info",
        title: `${claim.scope_qualifier}: £${claim.value}m — basis not in provided model`,
        detail: `The memo cites ${claim.scope_qualifier} of £${claim.value}m (${claim.period}). ` +
          `This figure depends on a valuation/structuring model not included in the operating model files.`,
        full_analysis: `[UNRECONCILABLE] Claim: "${claim.verbatim_snippet}" — This is a ${claim.claim_category} figure ` +
          `that references a model or methodology (${claim.basis_note}) not present in the uploaded financial model. ` +
          `Cannot verify — flagged for awareness only.`,
        severity_anchor: claim.value * 1_000_000,
        source_docs: [claim.source_doc],
        claim,
        model_figure: null,
        delta_abs: null,
        delta_pct: null,
      });
      unreconcilable_count++;
    }
    if (claim.claim_category === "returns_projection") {
      findings.push({
        finding_kind: "unreconcilable",
        severity: "info",
        title: `Returns projection: ${claim.value}${claim.unit} ${claim.scope_qualifier} — depends on model not provided`,
        detail: `The memo projects ${claim.scope_qualifier} of ${claim.value}${claim.unit} (${claim.period}). ` +
          `This depends on a returns model not included in the operating model files.`,
        full_analysis: `[UNRECONCILABLE] Claim: "${claim.verbatim_snippet}" — Returns projections (${claim.basis_note}) ` +
          `cannot be verified against the operating/financial model. The returns model was not provided.`,
        severity_anchor: null,
        source_docs: [claim.source_doc],
        claim,
        model_figure: null,
        delta_abs: null,
        delta_pct: null,
      });
      unreconcilable_count++;
    }
  }

  // ----- Step 3: LLM proposes matches for reconcilable claims -----
  if (reconcilableClaims.length > 0 && figures.length > 0) {
    const elapsed = Date.now() - phaseStart;
    if (elapsed < timeBudgetMs - 60_000) {
      try {
        const matchPrompt = buildMatchingPrompt(reconcilableClaims, figures);
        const response: LLMResponse = await callLLMWithHeadroom(
          ctx,
          {
            model: SONNET_MODEL,
            max_tokens: 8_192,
            system: matchPrompt,
            messages: [{ role: "user", content: "Match each claim to the model figures. Return only the JSON array." }],
          },
          "Reconciliation: match claims to model",
          { pipelineStartTime, maxPerCallTimeout: 90_000, retries: 2 },
        );

        const proposals = parseMatchProposals(response.content[0]?.text ?? "");
        console.log(`[Reconciliation] Got ${proposals.length} match proposals`);

        // ----- Step 4: Code-verified delta computation -----
        for (const proposal of proposals) {
          if (proposal.claim_index < 0 || proposal.claim_index >= reconcilableClaims.length) continue;
          const claim = reconcilableClaims[proposal.claim_index];

          if (proposal.match_status === "matched" && proposal.matched_label && proposal.matched_period) {
            // ---- Fix 3: Unit-match guard ----
            // Before even looking up the model figure, check if the claim's unit family
            // is plausibly compatible with what the model line represents.
            const claimUnitFamily = classifyClaimUnit(claim.unit);

            // Find the model figure by label + period
            const modelFig = findModelFigure(figures, proposal.matched_label, proposal.matched_period);

            if (!modelFig) {
              // LLM proposed a match but the figure doesn't exist — treat as unreconcilable
              findings.push({
                finding_kind: "unreconcilable",
                severity: "info",
                title: `${claim.scope_qualifier}: no model figure found at "${proposal.matched_label}" / "${proposal.matched_period}"`,
                detail: `LLM proposed match to "${proposal.matched_label}" (${proposal.matched_period}) but no verified figure exists at that address.`,
                full_analysis: `[UNRECONCILABLE] Claim: "${claim.verbatim_snippet}" — Proposed model line "${proposal.matched_label}" at period "${proposal.matched_period}" not found in verified figures set.`,
                severity_anchor: null,
                source_docs: [claim.source_doc],
                claim,
                model_figure: null,
                delta_abs: null,
                delta_pct: null,
              });
              unreconcilable_count++;
              continue;
            }

            // ---- Fix 3: Unit compatibility check ----
            const modelUnitFamily = classifyModelFigureUnit(modelFig);
            if (!unitsAreCompatible(claimUnitFamily, modelUnitFamily)) {
              // % claim vs £m model (or vice versa) — NEVER reconcile, emit scope_mismatch
              findings.push({
                finding_kind: "scope_mismatch",
                severity: "info",
                title: `Unit mismatch: claim ${claim.value}${claim.unit} vs model figure "${modelFig.name}" (incompatible units)`,
                detail: `Claim unit (${claim.unit} → ${claimUnitFamily}) is incompatible with model figure unit family (${modelUnitFamily}). ` +
                  `Percentage/rate claims cannot be reconciled against absolute £ figures.`,
                full_analysis: `[UNIT_MISMATCH] Claim: "${claim.verbatim_snippet}" (${claim.unit}) ` +
                  `was matched by LLM to "${modelFig.name}" but units are incompatible ` +
                  `(claim: ${claimUnitFamily}, model: ${modelUnitFamily}). ` +
                  `Rejecting match to prevent false divergence.`,
                severity_anchor: null,
                source_docs: [claim.source_doc],
                claim,
                model_figure: modelFig,
                delta_abs: null,
                delta_pct: null,
              });
              scope_mismatch_count++;
              continue;
            }

            // ---- Fix 3: Basis alignment check ----
            if (!basisGenuinelyAligns(claim, modelFig)) {
              // Scope string coincidence — bases don't genuinely align
              findings.push({
                finding_kind: "scope_mismatch",
                severity: "info",
                title: `Basis misalignment: ${claim.scope_qualifier} (${claim.unit}) vs "${modelFig.name}" — not like-for-like`,
                detail: `Claim (${claim.unit}, scope: "${claim.scope_qualifier}") appears superficially matched to ` +
                  `model figure "${modelFig.name}" but the basis/unit families indicate these are not genuinely comparable. ` +
                  `A rate/percentage cannot be compared against an absolute figure even if scope strings match.`,
                full_analysis: `[BASIS_MISALIGNMENT] Claim: "${claim.verbatim_snippet}" ` +
                  `(unit: ${claim.unit}, scope: "${claim.scope_qualifier}") ` +
                  `matched to model "${modelFig.name}" (inferred family: ${modelUnitFamily}). ` +
                  `Basis alignment check FAILED — rejecting to prevent fabricated divergence. ` +
                  `Coincidental scope string match is insufficient without genuine unit/basis agreement.`,
                severity_anchor: null,
                source_docs: [claim.source_doc],
                claim,
                model_figure: modelFig,
                delta_abs: null,
                delta_pct: null,
              });
              scope_mismatch_count++;
              continue;
            }

            // CODE computes the delta — never LLM
            const claimValueInUnits = normalizeClaimValue(claim);
            const modelValueInUnits = modelFig.value; // Already in £ (raw cell value)
            const deltaAbs = Math.abs(claimValueInUnits - modelValueInUnits);
            const deltaPct = modelValueInUnits !== 0 ? deltaAbs / Math.abs(modelValueInUnits) : (deltaAbs > 0 ? 1 : 0);

            // Classify
            if (deltaAbs < MATERIALITY_ABS_FLOOR && deltaPct < MATERIALITY_REL_FLOOR) {
              // Within tolerance — no finding
              within_tolerance_count++;
              reconciled_count++;
              continue;
            }

            // Above materiality floor → emit data_divergence finding
            const severity = (deltaAbs >= CRITICAL_ABS_THRESHOLD || deltaPct >= CRITICAL_REL_THRESHOLD) ? "warning" : "info";
            // Note: severity is capped at "warning" for memo-vs-model divergences.
            // Only cross-version (live vs frozen) gets "critical" because it signals stale data.

            const deltaSign = claimValueInUnits > modelValueInUnits ? "+" : "−";
            const deltaFormatted = deltaAbs >= 1_000_000
              ? `${deltaSign}£${(deltaAbs / 1_000_000).toFixed(1)}m`
              : `${deltaSign}£${(deltaAbs / 1_000).toFixed(0)}k`;

            findings.push({
              finding_kind: "data_divergence",
              severity,
              title: `${claim.metric} gap: memo ${formatValue(claim)} vs model £${(modelValueInUnits / 1_000_000).toFixed(1)}m (${deltaFormatted})`,
              detail: `Memo claims ${claim.scope_qualifier} of ${formatValue(claim)} (${claim.period}). ` +
                `Model figure "${modelFig.name}" shows £${(modelValueInUnits / 1_000_000).toFixed(1)}m at ${modelFig.period}. ` +
                `Delta: ${deltaFormatted} (${(deltaPct * 100).toFixed(1)}%).`,
              full_analysis: `[DATA_DIVERGENCE] Memo claim: "${claim.verbatim_snippet}" ` +
                `→ ${claim.scope_qualifier} = ${formatValue(claim)} (${claim.period}). ` +
                `Model: "${modelFig.name}" @ [${modelFig.source_cell}] = £${(modelValueInUnits / 1_000_000).toFixed(2)}m (${modelFig.period}). ` +
                `Code-computed delta: ${deltaFormatted} (${(deltaPct * 100).toFixed(1)}%). ` +
                `Confirm whether this represents a pro-forma/annualisation gap, a timing difference, or a genuine inconsistency.`,
              severity_anchor: deltaAbs,
              source_docs: [claim.source_doc, modelFig.source_doc],
              claim,
              model_figure: modelFig,
              delta_abs: deltaAbs,
              delta_pct: deltaPct,
            });
            reconciled_count++;

          } else if (proposal.match_status === "scope_mismatch") {
            // Scope mismatch — NEVER assert contradiction
            findings.push({
              finding_kind: "scope_mismatch",
              severity: "info",
              title: `Scope mismatch: ${claim.scope_qualifier} — confirm like-for-like basis`,
              detail: `Memo cites ${claim.scope_qualifier}: ${formatValue(claim)} (${claim.period}). ` +
                `Model has a similar metric but different scope. ${proposal.mismatch_reason ?? ""}`,
              full_analysis: `[SCOPE_MISMATCH] Memo claim: "${claim.verbatim_snippet}" ` +
                `→ scope: "${claim.scope_qualifier}". ` +
                `Model scope differs: ${proposal.mismatch_reason ?? "unspecified"}. ` +
                `These metrics have different scope definitions and are not directly comparable. ` +
                `Do NOT assert a contradiction — flag for scope confirmation only.`,
              severity_anchor: null,
              source_docs: [claim.source_doc],
              claim,
              model_figure: null,
              delta_abs: null,
              delta_pct: null,
            });
            scope_mismatch_count++;

          } else {
            // no_model_line — unreconcilable
            findings.push({
              finding_kind: "unreconcilable",
              severity: "info",
              title: `${claim.scope_qualifier}: no model counterpart`,
              detail: `Memo cites ${claim.scope_qualifier}: ${formatValue(claim)} (${claim.period}). ` +
                `No matching metric found in the operating model.`,
              full_analysis: `[UNRECONCILABLE] Claim: "${claim.verbatim_snippet}" ` +
                `→ ${claim.scope_qualifier} has no counterpart in the verified figures set. ` +
                `This metric/scope is not covered by the uploaded financial model.`,
              severity_anchor: null,
              source_docs: [claim.source_doc],
              claim,
              model_figure: null,
              delta_abs: null,
              delta_pct: null,
            });
            unreconcilable_count++;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Reconciliation] LLM matching failed: ${msg}`);
        // All reconcilable claims become unreconcilable on LLM failure
        unreconcilable_count += reconcilableClaims.length;
      }
    } else {
      console.warn(`[Reconciliation] Skipped LLM matching — time budget exhausted`);
      unreconcilable_count += reconcilableClaims.length;
    }
  } else if (figures.length === 0) {
    console.log(`[Reconciliation] No verified figures available — all claims unreconcilable`);
    unreconcilable_count += reconcilableClaims.length;
  }

  // ----- Step 5: Cross-version findings from numeric-verify discrepancies -----
  let cross_version_findings = 0;
  for (const disc of discrepancies) {
    const materialMetrics = (disc.metrics ?? []).filter(m => m.tier === "material");

    if (materialMetrics.length === 0) continue;

    // Determine severity based on magnitude
    const maxDelta = Math.max(...materialMetrics.map(m => m.absDiff));
    const severity: "critical" | "warning" | "info" = maxDelta >= 1_000_000 ? "warning" : "info";

    findings.push({
      finding_kind: "cross_version",
      severity,
      title: `Cross-version revision: ${disc.period} — ${materialMetrics.length} material movement${materialMetrics.length === 1 ? "" : "s"}`,
      detail: disc.headline ?? disc.description,
      full_analysis: `[CROSS_VERSION] ${disc.description}\n\nMaterial movements:\n` +
        materialMetrics.map(m => {
          const sign = m.sourceA > m.sourceB ? "+" : "−";
          const mag = m.absDiff >= 1_000_000 ? `£${(m.absDiff / 1_000_000).toFixed(1)}m` : `£${(m.absDiff / 1_000).toFixed(0)}k`;
          return `  - ${m.label}: ${sign}${mag} (${m.relDiffPct.toFixed(1)}%)`;
        }).join("\n") +
        "\n\nConfirm whether these reflect intentional model updates or stale references in the memo.",
      severity_anchor: maxDelta,
      source_docs: disc.sources,
      claim: null as any, // Cross-version findings don't originate from a memo claim
      model_figure: null,
      delta_abs: maxDelta,
      delta_pct: materialMetrics.length > 0 ? Math.max(...materialMetrics.map(m => m.relDiffPct / 100)) : null,
    });
    cross_version_findings++;
  }

  console.log(
    `[Reconciliation] Complete: ${findings.length} findings ` +
    `(${reconciled_count} reconciled, ${within_tolerance_count} within tolerance, ` +
    `${unreconcilable_count} unreconcilable, ${scope_mismatch_count} scope mismatches, ` +
    `${cross_version_findings} cross-version). Elapsed: ${Math.round((Date.now() - phaseStart) / 1000)}s`
  );

  return {
    findings,
    reconciled_count,
    unreconcilable_count,
    scope_mismatch_count,
    within_tolerance_count,
    cross_version_findings,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeClaimValue(claim: Claim): number {
  // Convert claim value to the same units as model figures (raw £)
  switch (claim.unit) {
    case "£m": return claim.value * 1_000_000;
    case "£k": return claim.value * 1_000;
    case "£": return claim.value;
    default: return claim.value * 1_000_000; // Default assumption: £m for financial claims
  }
}

function formatValue(claim: Claim): string {
  return `${claim.value}${claim.unit}`;
}

function findModelFigure(figures: Figure[], label: string, period: string): Figure | null {
  // Exact match first
  const exact = figures.find(f =>
    f.name.trim().toLowerCase() === label.trim().toLowerCase() &&
    f.period.trim().toLowerCase() === period.trim().toLowerCase()
  );
  if (exact) return exact;

  // Fuzzy: label contains + period year match
  const labelLower = label.trim().toLowerCase();
  const periodYear = period.match(/\b(20\d{2})\b/)?.[1];
  if (periodYear) {
    const fuzzy = figures.find(f =>
      f.name.trim().toLowerCase().includes(labelLower) &&
      f.period.includes(periodYear)
    );
    if (fuzzy) return fuzzy;

    // Even fuzzier: model figure label contains claim label
    const fuzzy2 = figures.find(f =>
      labelLower.includes(f.name.trim().toLowerCase()) &&
      f.period.includes(periodYear)
    );
    if (fuzzy2) return fuzzy2;
  }

  return null;
}

function parseMatchProposals(responseText: string): MatchProposal[] {
  let jsonStr = responseText.trim();

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    return parsed.map((p: any) => ({
      claim_index: typeof p.claim_index === "number" ? p.claim_index : -1,
      match_status: p.match_status === "matched" || p.match_status === "no_model_line" || p.match_status === "scope_mismatch"
        ? p.match_status : "no_model_line",
      matched_label: typeof p.matched_label === "string" ? p.matched_label : null,
      matched_period: typeof p.matched_period === "string" ? p.matched_period : null,
      mismatch_reason: typeof p.mismatch_reason === "string" ? p.mismatch_reason : null,
    }));
  } catch {
    console.warn(`[Reconciliation] Failed to parse match proposals. First 500: ${jsonStr.slice(0, 500)}`);
    return [];
  }
}
