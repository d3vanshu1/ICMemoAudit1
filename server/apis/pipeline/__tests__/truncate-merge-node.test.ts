/**
 * Unit test for truncateMergeNodeText
 *
 * Run via: npx tsx server/apis/pipeline/__tests__/truncate-merge-node.test.ts
 *
 * The ONE guarantee this function must uphold:
 * When the input contains N flags, the output MUST contain all N flags intact —
 * even when data_points/key_claims are trimmed to fit the cap.
 *
 * Real sub-agent output is bare JSON (no fenced block). These tests verify
 * the bare-JSON path activates correctly and never falls through to hard slice.
 */
import { _truncateMergeNodeText as truncateMergeNodeText } from "../pipeline-core.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${msg}`);
  }
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${msg}\n     Expected: ${expected}\n     Actual:   ${actual}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture builder — shape matches real analyze-chunk sub-agent output
// (DENSE_SUFFIX format: bare JSON, no fencing)
// ---------------------------------------------------------------------------

function makeBareJsonOutput(opts: {
  flagCount?: number;
  dataPointCount?: number;
  claimCount?: number;
} = {}): string {
  const { flagCount = 3, dataPointCount = 20, claimCount = 5 } = opts;

  const flags = Array.from({ length: flagCount }, (_, i) => ({
    flag_type: i % 2 === 0 ? "omission" : "inconsistency",
    severity: i % 3 === 0 ? "high" : "medium",
    description: `Flag ${i + 1}: Potential issue detected in revenue recognition methodology for Q${i + 1} period adjustments`,
    evidence: `"Revenue for the period was adjusted by ${(i + 1) * 1.5}M without supporting documentation in the financial statements"`,
    affected_sections: [`Section ${i + 1}.${i + 2}`],
  }));

  const data_points = Array.from({ length: dataPointCount }, (_, i) => ({
    label: `Data Point ${i + 1}: Revenue adjustment item ${i + 1}`,
    value: `$${((i + 1) * 2.5).toFixed(1)}M adjustment applied in Q${(i % 4) + 1} FY2024`,
    context: `Found in financial statements section ${i + 1}, paragraph ${i + 3}. This represents a ${((i + 1) * 0.3).toFixed(1)}% change from prior period.`,
    page_reference: `p.${i + 10}`,
  }));

  const key_claims = Array.from({ length: claimCount }, (_, i) => ({
    claim: `Company claims ${(i + 1) * 15}% YoY growth driven by organic expansion in segment ${i + 1}`,
    source: `Management Discussion, p.${i + 5}`,
    confidence: i % 2 === 0 ? "high" : "medium",
  }));

  const output = {
    document_name: "Q4_2024_Financial_Statements.pdf",
    document_type: "financial_statement",
    raw_summary:
      "The document presents Q4 2024 consolidated financial statements showing $142.3M total revenue with multiple period adjustments. Several revenue recognition items lack supporting documentation.",
    key_claims,
    data_points,
    flags,
  };

  return JSON.stringify(output);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("=== truncateMergeNodeText — Bare-JSON Flags Preservation Tests ===\n");

// Test 1: Returns input unchanged when under cap
console.log("--- Test 1: Input under cap returned unchanged ---");
{
  const input = makeBareJsonOutput({ flagCount: 2, dataPointCount: 2, claimCount: 1 });
  const result = truncateMergeNodeText(input, input.length + 1000);
  assertEq(result, input, "Result equals input when under cap");
}

// Test 2: ALL flags preserved when data_points are trimmed (bare JSON)
console.log("\n--- Test 2: All flags preserved when data_points trimmed ---");
{
  const flagCount = 4;
  const input = makeBareJsonOutput({ flagCount, dataPointCount: 30, claimCount: 5 });

  // Cap that forces data_points trimming but leaves room for flags
  const cap = Math.floor(input.length * 0.4);
  const result = truncateMergeNodeText(input, cap);

  assert(!result.includes("[...TRUNCATED"), "No hard-truncation marker");

  // Parse the JSON from the result (strip trailing NOTE)
  const jsonEnd = result.lastIndexOf("}");
  const jsonPart = result.slice(0, jsonEnd + 1);
  const parsed = JSON.parse(jsonPart);

  assertEq(parsed.flags?.length, flagCount, `All ${flagCount} flags survived`);
  for (let i = 0; i < flagCount; i++) {
    assert(
      parsed.flags[i].description.includes(`Flag ${i + 1}`),
      `Flag ${i + 1} content intact`
    );
    assert(parsed.flags[i].flag_type !== undefined, `Flag ${i + 1} has flag_type`);
    assert(parsed.flags[i].severity !== undefined, `Flag ${i + 1} has severity`);
    assert(parsed.flags[i].evidence !== undefined, `Flag ${i + 1} has evidence`);
  }
}

// Test 3: ALL flags preserved when BOTH data_points and key_claims removed
console.log("\n--- Test 3: Flags survive when data_points AND key_claims removed ---");
{
  const flagCount = 5;
  const input = makeBareJsonOutput({ flagCount, dataPointCount: 50, claimCount: 10 });

  // Tight cap forcing removal of both data_points and key_claims, but enough for flags+summary
  // With 5 flags pretty-printed (JSON.stringify null,2) the minimal object is ~2000-2400 chars
  const cap = 3000;
  const result = truncateMergeNodeText(input, cap);

  assert(!result.includes("[...TRUNCATED"), "No hard-truncation marker");

  const jsonEnd = result.lastIndexOf("}");
  const jsonPart = result.slice(0, jsonEnd + 1);
  const parsed = JSON.parse(jsonPart);

  assertEq(parsed.flags?.length, flagCount, `All ${flagCount} flags survived`);
  for (const f of parsed.flags) {
    assert(!!f.flag_type, "flag has flag_type");
    assert(!!f.severity, "flag has severity");
    assert(!!f.description, "flag has description");
  }
  assertEq(parsed.data_points, undefined, "data_points removed");
}

// Test 4: Works with header prefix before bare JSON
console.log("\n--- Test 4: Header prefix + bare JSON ---");
{
  const flagCount = 3;
  const bareJson = makeBareJsonOutput({ flagCount, dataPointCount: 25, claimCount: 4 });
  const input = `### Extraction from: Q4_2024_Financial_Statements.pdf\n\n${bareJson}`;

  const cap = Math.floor(input.length * 0.35);
  const result = truncateMergeNodeText(input, cap);

  assert(!result.includes("[...TRUNCATED"), "No hard-truncation marker");
  assert(result.includes("### Extraction from:"), "Prefix preserved");

  const jsonStart = result.indexOf("{");
  const jsonEnd = result.lastIndexOf("}");
  const parsed = JSON.parse(result.slice(jsonStart, jsonEnd + 1));
  assertEq(parsed.flags?.length, flagCount, `All ${flagCount} flags survived with prefix`);
}

// Test 5: Hard truncation only when flags alone exceed cap
console.log("\n--- Test 5: Hard truncation when cap impossibly tight ---");
{
  const input = makeBareJsonOutput({ flagCount: 2, dataPointCount: 5, claimCount: 2 });
  const cap = 50; // Way too small for even minimal output
  const result = truncateMergeNodeText(input, cap);

  assert(result.includes("[...TRUNCATED"), "Hard truncation used (expected for impossible cap)");
}

// Test 6: Fenced JSON still works (backward compat)
console.log("\n--- Test 6: Fenced JSON backward compat ---");
{
  const flagCount = 3;
  const bareJson = makeBareJsonOutput({ flagCount, dataPointCount: 20, claimCount: 4 });
  const fenced = "Here is the analysis:\n\n```json\n" + bareJson + "\n```\n\nDone.";

  const cap = Math.floor(fenced.length * 0.4);
  const result = truncateMergeNodeText(fenced, cap);

  assert(!result.includes("[...TRUNCATED"), "No hard-truncation marker");
  const jsonStart = result.indexOf("{");
  const jsonEnd = result.lastIndexOf("}");
  const parsed = JSON.parse(result.slice(jsonStart, jsonEnd + 1));
  assertEq(parsed.flags?.length, flagCount, `All ${flagCount} flags survived (fenced input)`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== ${failed === 0 ? "ALL PASS ✅" : "FAILED ❌"} — ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  throw new Error(`truncateMergeNodeText test: ${failed} assertion(s) failed`);
}
