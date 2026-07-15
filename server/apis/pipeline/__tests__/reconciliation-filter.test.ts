/**
 * Acceptance test for the fabricated-arithmetic suppression filter.
 * 
 * Bar to ship: all 5 fabricated cases suppressed, legitimate case preserved.
 * Run via: npx tsx server/apis/pipeline/__tests__/reconciliation-filter.test.ts
 */

// --- Test cases (exact text from verified findings) ---

const MUST_SUPPRESS = [
  {
    id: "pt.41",
    label: "Calls & Lines",
    title: "Calls & Lines Sub-Category Volume Fails to Reconcile — ~9.6% Gap Unexplained",
    detail: "Part 41 reports a Calls & Lines volume increase of 554,514 units (4.0% growth, from 13,714,943 to 14,269,457), but the twelve visible sub-category volumes sum to only approximately 501,513 — leaving an unexplained gap of ~53,001 units, or roughly 9.6% of the stated variance. All row and column headers are absent, making individual sub-category identities unresolvable.",
    full_analysis: "",
  },
  {
    id: "pt.110",
    label: "Hosted Enhanced",
    title: "Hosted Enhanced Revenue: Monthly Series Irreconcilable with Period Total",
    detail: "The twelve visible monthly Hosted Enhanced revenue figures (part 110) sum to approximately 134,810, against a stated period total of 1,136,863—a shortfall of roughly 1,002,053 with no bridging explanation. This either indicates the monthly series represents only a sub-segment or sub-period of the aggregate, or there is a structural error in the model's aggregation logic.",
    full_analysis: "",
  },
  {
    id: "pt.223",
    label: "Recent Acquisitions",
    title: "Recent Acquisitions Monthly vs. Aggregate Revenue Irreconcilable",
    detail: "Part 223 presents a 12-month series summing to ~570,859 alongside a stated aggregate of 1,377,560 for the same segment — a gap of ~807,000 (59% of the aggregate) with no bridging explanation, period label, or column header. Any valuation, return, or coverage metric derived from the 1,377,560 figure is unreliable until reconciled.",
    full_analysis: "",
  },
  {
    id: "pt.77",
    label: "Legacy Connectivity",
    title: "Legacy Connectivity 12.2% Growth Commercially Unexplained — Aggregate Irreconcilable",
    detail: "Part 77 shows legacy connectivity revenue growing 12.2% while 12 granular sub-period values summing to approximately 590,695 cannot be reconciled against the 5,605,867 aggregate, leaving a ~5.0M unexplained gap.",
    full_analysis: "",
  },
  {
    id: "pt.229",
    label: "Maintenance",
    title: "Maintenance Monthly Deltas Do Not Reconcile to Annual Variance",
    detail: "The 12 visible monthly maintenance deltas sum to approximately 279,051, while the model states an annual variance of 322,751 — a 43,700 gap with no visible explanation.",
    full_analysis: "",
  },
];

const MUST_PRESERVE = [
  {
    id: "pt.107",
    label: "Reseller (LEGITIMATE)",
    title: "Monthly Reseller Revenue Series Is Incremental, Not Absolute",
    detail: "In part 107, the sum of 12 visible monthly Hosted - to Resellers figures totals 177,484, which reconciles to the stated period variance rather than the current-period revenue total. This confirms the monthly columns represent incremental period-on-period deltas, not absolute monthly revenues.",
    full_analysis: "",
  },
];

// --- Pattern set under test (imported from production code) ---
import { FABRICATED_ARITHMETIC_PATTERNS } from "../fabricated-arithmetic-patterns.js";

// --- Test runner ---

function shouldSuppress(finding: { title: string; detail: string; full_analysis: string }): boolean {
  const text = `${finding.title} ${finding.detail} ${finding.full_analysis}`;
  return FABRICATED_ARITHMETIC_PATTERNS.some(pat => pat.test(text));
}

let allPass = true;

console.log("=== Fabricated Arithmetic Filter — Acceptance Tests ===\n");

console.log("--- Must Suppress (fabricated) ---");
for (const c of MUST_SUPPRESS) {
  const suppressed = shouldSuppress(c);
  const status = suppressed ? "✅ SUPPRESSED" : "❌ MISSED";
  if (!suppressed) allPass = false;
  
  // Show which pattern matched
  const text = `${c.title} ${c.detail} ${c.full_analysis}`;
  const matchedPattern = FABRICATED_ARITHMETIC_PATTERNS.findIndex(pat => pat.test(text));
  console.log(`  ${status} — ${c.id} (${c.label})${suppressed ? ` [pattern ${matchedPattern}]` : ""}`);
}

console.log("\n--- Must Preserve (legitimate) ---");
for (const c of MUST_PRESERVE) {
  const suppressed = shouldSuppress(c);
  const status = suppressed ? "❌ FALSE POSITIVE" : "✅ PRESERVED";
  if (suppressed) allPass = false;
  
  if (suppressed) {
    const text = `${c.title} ${c.detail} ${c.full_analysis}`;
    const matchedPattern = FABRICATED_ARITHMETIC_PATTERNS.findIndex(pat => pat.test(text));
    console.log(`  ${status} — ${c.id} (${c.label}) [matched pattern ${matchedPattern}: ${FABRICATED_ARITHMETIC_PATTERNS[matchedPattern]}]`);
  } else {
    console.log(`  ${status} — ${c.id} (${c.label})`);
  }
}

console.log(`\n=== ${allPass ? "ALL PASS ✅" : "FAILED ❌"} ===`);
if (!allPass) throw new Error("Acceptance test failed");
