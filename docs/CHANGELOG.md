# CHANGELOG

## Freeze Exception #3 — 2026-07-24

**Cause:** Run `0e4cc96d` merge phase — all Round 1 groups timing out at 120s ceiling. Root cause: system prompt growth (+4–5K chars from materiality gate, housekeeping appendix, evidence arrays, numeric trace-back, six-point rubric) accumulated since the prior successful run. Per-call merge input is ~32–36K chars / ~9–10K tokens — within the model's context budget, but the 120s response-time ceiling is too tight given current API latency at that payload size.

**Diagnosis (verbatim errors from `merge_checkpoints`):**
```
"LLM call timed out after 120s: Merge R1 G1/94"
"LLM call timed out after 120s: Merge R1 G2/94"
"LLM call timed out after 120s: Merge R1 G3/94"
"LLM call timed out after 120s: Merge R1 G4/94"
"LLM call timed out after 120s: Merge R1 G5/94"
```
5 of 94 planned groups attempted before invocation time-budget expired. All 5 timed out. `failureCount` per group = 1 (well under `MAX_MERGE_GROUP_FAILURES=5`).

**Fix (two parts):**
1. **Timeout cap bump:** Round 0–1 `timeoutCap` raised from `120_000` → `165_000` ms. Round 2+ remains at `180_000`. The `Math.min(timeoutCap, Math.max(30_000, timeRemaining() - 30_000))` structure is unchanged — only the hard ceiling moves.
2. **Fallback disclosure:** If any merge group exhausts `MAX_MERGE_GROUP_FAILURES` and falls back to unconsolidated first-member text, the formatted report now carries a visible `⚠️` warning in its disclosure header: "N merge group(s) fell back to unconsolidated text after repeated timeouts." Degraded merges are never silent.

**Expected behavior post-deploy:** On next invocation, the 5 failed groups retry with `perCallTimeout` up to 165s (assuming sufficient time budget). If they complete, the merge proceeds normally. If they still timeout at 165s, the problem is model-side latency (not a tuning issue), and the next move is prompt workload descoping (e.g., split materiality/dedup into a separate lighter pass).

**Run status:** `0e4cc96d` NOT touched. Existing checkpoints (376 analysis + 5 error-only merge) remain intact.

---

## Freeze Exception #2 — 2026-07-24

**Cause:** Run `0e4cc96d` invocation 2 hit resume-status-check failure at pipeline-core.ts:738. The catch-level SDK error carried no Postgres detail — string-discrimination (`42703` / `does not exist`) was blind to the actual failure mode. Platform demonstrably strips error structure from integration responses.

**Exhibit (verbatim):** Integration error with no SQLSTATE or column reference — only generic `Integration "ba09e2b9..." failed during "query"`.

**Fix:** Replaced string-matching gate with fallback-probe pattern:
1. On ANY caught error → dump full error object (`JSON.stringify(err, Object.getOwnPropertyNames(err))`) for future forensics
2. Attempt status-only fallback: `SELECT status FROM module_runs WHERE id = $1`
3. Fallback succeeds → proceed with `isCancelled = false` (failure was column-related or transient)
4. Fallback also fails → rethrow original (integration genuinely down)

**Post-gate queue:** The same string-discrimination pattern exists at ~10 other sites (all fail-soft). Scheduled for wholesale replacement with fallback-probe in hygiene pass, informed by whatever the error-object dump reveals.

**Run status:** `0e4cc96d` NOT touched. Invocation 1's extraction work banked in checkpoints. This resume IS the checkpoint-recovery demonstration.

---

## Clear Runway Protocol — 2026-07-24

**Executed by:** Clark (consent record: Devanshu, this session)

### Evidence Preserved
- `docs/evidence/262-run-report-32087fa4.md` — 233,334-char report from completed run `72a682bd` (module: omission_audit, 262 findings)
- DiagMergeFunnel baseline verified in CHANGELOG: 826 → 434 → 350 → 350 → 350

### Purge Results (SCG deal `c46b4129`)

| Table | Rows Deleted |
|-------|-------------|
| `universal_extractions` | 381 |
| `pipeline_analysis` | 792 |
| `doc_tables` | 39 |
| `module_outputs` | 1 |
| `merge_checkpoints` | 256 |
| `module_runs` | 3 |

**Tables untouched:** `documents`, `parsed_text`, `parsed_text_backups`, `document_tag`, `sub_agent_prompts`, deal record.

### Invocation 1 Timing Expectation

> **By design, the first pipeline invocation post-purge will be the longest.**
> - `doc_tables` regeneration (Step 0.6): 30–90 seconds
> - First extraction pass follows immediately: ~200–260 seconds total for invocation 1
> - Subsequent invocations will not incur `doc_tables` cost (data persists once generated)
> - This is expected behaviour, not a stall.

---

## Fixes Zip — 2026-07-24

### Gate Item (RunMigration008)

**Verbatim error:**
```
Integration "ba09e2b9-2715-4460-8131-896f50b0c414" failed during "execute"
```

**Executor:** Clark via `testApi` in Build mode.

**Context:** ALTER TYPE on `module_status` enum attempted via RunMigration008. Failed due to Superblocks platform constraint — DDL operations cannot execute through any Superblocks API path (query, execute, or executeRequestToIntegration). Migration 008 deleted; replaced by boolean approach (Migration 009, also requires manual DB execution by Devanshu).

---

### Fixes Delivered

#### Fix 1 — Coverage-Map Snippet Anchoring
`checklist-scan-phase.ts` → `formatCoverageMapForPrompt` now includes top-3 verbatim source snippets (300-char `snippet` field already captured) for each "covered" category. The merge layer receives actual quoted text, not just filename/count metadata.

**Code (verbatim, lines 214–226 of `checklist-scan-phase.ts`):**
```typescript
  // Fix 1: Include verbatim source snippets so the merge layer can anchor findings
  // against actual extracted text rather than just category counts.
  ...
      // Include top 3 verbatim snippets as anchoring evidence
      const topHits = cat.hits.slice(0, 3);
      for (const hit of topHits) {
        if (hit.snippet) {
          lines.push(`  > [${hit.fileName}, chunk ${hit.chunkIndex}]: "${hit.snippet}"`);
        }
      }
```

#### Fix 2 — Retrieval Verification Gate (Six-Point Rubric)
Added to `MERGE_OUTPUT_STRUCTURE` in `merge-findings.ts`. Every finding must pass all six checks:
1. Quote-anchored
2. Fact-of-process not emphasis-judgment
3. Two-sided verified
4. Numbers traced
5. Post-IC staging respected
6. IC-chair materiality

Findings failing any check → demoted to `human_review_flag` (severity info) or dropped.

#### Fix 3 — Numeric Trace-Back
- `EvidenceItemSchema` added: `{figure, source_doc, verbatim_snippet, verified}`
- `evidence` array added to `FindingSchema`
- `numeric_unverified` boolean added — findings with this flag capped at severity "info" (enforced in parser)
- Adversarial Numeric Trace-Back pass added to prompt: identifies all figures, requires verbatim source match, labels failures
- Known failure patterns documented: NPS transposition, revenue fabrication (£250m→£194m vs actual growth £144.8→168.2→192.5), coupon mismatch (12%/14%)

#### Fix 4 — Materiality Gate
- `materiality_rationale` field (REQUIRED) added to every finding
- `category` field added: `"principal_finding" | "housekeeping" | "human_review_flag"`
- IC-chair standard verbatim: "Would this plausibly change an IC member's assessment of a £655m transaction?"
- Target envelope: single digits to low teens of principal findings
- Sub-threshold items demoted to `<housekeeping_appendix>` XML section (parsed and returned as `housekeepingFindings`)

#### Fix 5 — Deal-Process Context Injection
- `pipeline-core.ts` now queries `document_chunks` for DD/adviser table content mentioning "post IC", "kick off", workstream staging
- Top 5 results injected as `## DEAL-PROCESS CONTEXT — Staged Workstreams (Ground Truth)` into merge input
- Instruction: items listed here MUST be reclassified as `open_item_acknowledged`, never as omission

#### Fix 6 — Semantic Deduplication
- `## SEMANTIC DEDUPLICATION` section added to `MERGE_OUTPUT_STRUCTURE`
- Instruction: cluster by issue identity (not title string), merge duplicates, keep highest severity + combined evidence
- Known dedup targets documented: verbatim tax-doc triples (#211/212/213), stale-legal-DD + no-reliance pairs, five-way dealer-buyout cluster
- Size guideline: >15 principal findings signals unresolved duplicates (per DiagMergeFunnel: 95 leaves → 6 nodes at level 3)

#### Fix 7 — Taxonomy: `open_item_acknowledged`
- Added to `gap_type` enum in `FindingSchema`, `MergedFinding` interface, `MERGE_OUTPUT_STRUCTURE`
- Added to `ABSENCE_VERIFICATION_PROTOCOL` in `analyze-chunk.ts` as a classification option
- Semantics: the record itself discloses the item as open/pending — distinct from omission

#### Cross-Cutting
- **ResetModuleMerge refusal message** now reads: "use ResurrectModuleRun to revive a cancelled run, or pass override:true to force"
- **Emphasis-judgment demotion**: findings containing "underweighted", "de-emphasised", "insufficiently stressed", "could have been more prominent" → demoted to `human_review_flag` category with severity "info"
- **`<housekeeping_appendix>`** XML tag: parsed by `MergeFindings` API, returned as optional `housekeepingFindings` array in output

---

### Paper Traces — Falsified Findings → Fix Mapping

| Falsified Finding | Root Cause | Fix That Kills It |
|---|---|---|
| NPS scores transposed (49/13/54/75 cited in wrong segment order) | No source-snippet verification on numeric claims | **Fix 3** — Adversarial numeric trace-back rejects figures not matched to verbatim source text |
| Fabricated £250m→£194m revenue decline (actual P&L: £144.8→168.2→192.5m growth) | AI-generated arithmetic passed as fact | **Fix 3** — Source retrieval step finds no snippet containing "£250m" or "£194m"; finding labeled `numeric_unverified` and capped at info |
| 12%-vs-14% A-Pref coupon confusion | Cross-document figure transposition | **Fix 3** — Evidence array requires exact per-figure source match; mismatch → verified=false |
| Legal DD staleness / no-reliance / bring-down cluster (4 "critical omissions") | Post-IC staged workstreams flagged as missing | **Fix 5** — DD/adviser table injected as ground truth; "kick off post IC" rows → `open_item_acknowledged`; **Fix 7** — taxonomy classifies correctly |
| FTI "results TBD" flagged as diligence gap | Record explicitly acknowledges open item | **Fix 7** — `open_item_acknowledged` gap_type; **Fix 5** — deal-process context surfaces the "TBD" disclosure |
| "Underweighted" / "de-emphasised" emphasis-judgment findings | Subjective editorial opinion, not factual gap | **Fix 2** — Rubric point 2 (fact-of-process not emphasis-judgment) demotes to `human_review_flag` |
| Tax-documentation finding appearing 3× verbatim (#211/212/213) | No semantic dedup at merge | **Fix 6** — Same-issue consolidation clusters by identity; known dedup target documented |
| Five-way dealer-buyout cluster (same contractual feature, 5 findings) | Title-string-only dedup misses semantic equivalence | **Fix 6** — Semantic clustering instruction + size guideline (>15 = unresolved dupes) |
| Immaterial process-stage items in principal findings (standard DD tracking) | No materiality threshold | **Fix 4** — IC-chair test demotes to housekeeping appendix; below-threshold items carry `category: "housekeeping"` |
| "Customer cube never reported" (claim of omission — analysis actually exists in deal documents) | Absence claim not cross-verified against all extracted source text | **Fix 2** — Retrieval verification gate: Call A generates alternate search terms (conclusions/findings/completed/validated); retrieval scans `document_chunks` with expanded queries, hits 3rd memo pp.19–21 containing the customer analysis; Call B issues verdict REVISED → finding removed from principal set |

---

### Diagnostic Outputs (Owed Items)

#### DiagRawFlagAggregate
All `flags`/`data_points`/`key_claims` = 0 in `universal_extractions`. The extraction layer stores unstructured markdown text, not structured flag arrays. Structured findings emerge only in the merge phase. This confirms Fix 4's materiality gate must operate at merge level (not extraction).

#### DiagMergeFunnel (run 32087fa4)
| Level | Nodes | Findings | Collapse Ratio |
|---|---|---|---|
| 1 (leaves) | 95 | 826 | — |
| 2 | 24 | 434 | 53% |
| 3 | 6 | 350 | 81% |
| 4 | 2 | 350 | 100% (no collapse) |
| 5 (root) | 1 | 350 | 100% (no collapse) |

**Key insight**: Collapse stops at level 3. 826→350 findings survive (58% pass-through). Fix 6's semantic dedup targets this exact locus — the level where combinatorial explosion stops but semantic duplicates persist. Target: 350 → single digits to low teens via materiality gate + dedup.

---

### Files Modified

- `server/apis/pipeline/checklist-scan-phase.ts` — Fix 1: snippets in coverage map
- `server/apis/modules/merge-findings.ts` — Fixes 2–4, 6–7: rubric, schemas, prompts, parser, housekeeping appendix
- `server/apis/modules/build-merged-text.ts` — Fix 7: `open_item_acknowledged` in MergedFinding interface
- `server/apis/modules/analyze-chunk.ts` — Fix 7: `open_item_acknowledged` in ABSENCE_VERIFICATION_PROTOCOL
- `server/apis/pipeline/pipeline-core.ts` — Fix 5: deal-process context extraction + injection
- `server/apis/pipeline/reset-module-merge.ts` — Cross-cutting: refusal message update

---

## Addendum — 2026-07-24

### Changes

1. **BLOCKING: Demote-delete hole closed end-to-end**
   - `MergeNode` interface gains `housekeepingFindings?: MergedFinding[]`
   - `housekeeping_appendix` XML tag parsed in pipeline-core's merge parser (alongside `findings_json`)
   - Housekeeping findings persisted in checkpoint `merged_json`
   - Accumulated across merge rounds (like principal findings)
   - `formatReportInline` renderer adds two sections after principal findings:
     - **"Housekeeping Appendix"** — sub-materiality items with demotion rationale
     - **"Human Review Flags"** — emphasis-judgment findings
   - Disclosure header updated: "N principal, M housekeeping, K human-review flags"

2. **Prompt self-contradiction resolved**
   - Line ~109 `gap_type`: consolidated from two conflicting entries to single three-value instruction (`diligence_gap | memo_omission | open_item_acknowledged`)

3. **Code backstop on absence gate**
   - Both parsers (pipeline-core + merge-findings.ts): `memo_omission`/`open_item_acknowledged` findings arriving WITHOUT `absence_confidence` → automatically set to `"unverified"` and severity capped at `"info"`
   - The verification gate cannot be bypassed by field omission

4. **Fail-open visibility**
   - `verificationPhaseErrored` flag set in Step 5.5 catch block
   - Passed to renderer → disclosure line injected: "⚠️ Absence claims in this report were not adversarially verified (phase error)."
   - A failed verification is visually distinct from a passed one in the artifact itself

5. **Paper trace row 10 + Fix-1 code quote**
   - "Customer cube never reported" → Fix 2 mechanism documented (Call A alternate terms → retrieval hit → Call B REVISED)
   - Fix-1 snippet-injection code quoted verbatim from `checklist-scan-phase.ts`

---

## Hot-Fix — Line 738 Guard + Site Audit — 2026-07-24

### Incident

`RunModulePipeline` DOA on resume path pre-migration: unguarded `SELECT status, COALESCE(is_cancelled, FALSE) AS is_cancelled` at `pipeline-core.ts:738` throws `column "is_cancelled" does not exist` (Postgres error 42703). The `checkCancelled()` helper (line 598) was properly guarded; this separate status-check on the resume-existing-run path was not wrapped in try/catch.

### Fix Applied

`pipeline-core.ts` line 738 now wrapped in identical pattern:
- try → COALESCE query (happy path)
- catch → discriminate 42703 / "does not exist" → fallback `SELECT status` only, `isCancelled = false`
- other errors → `console.error` loud, proceed with `status = "running"`, `isCancelled = false`

### `is_cancelled` Site Audit — All Server References

Every `is_cancelled` occurrence in `server/` examined. Each site classified as:
- **Query** = SQL referencing `is_cancelled`
- **DML** = SQL writing `is_cancelled`
- **JS** = JavaScript/TypeScript comparison of the value
- **DDL** = Schema definition (migration)

| # | File | Line(s) | Type | Guard Status |
|---|------|---------|------|-------------|
| 1 | `pipeline/pipeline-core.ts` | 598–606 | Query + JS | ✅ try/catch + 42703 discrimination |
| 2 | `pipeline/pipeline-core.ts` | 738–749 | Query + JS | ✅ **FIXED** — try/catch + 42703 discrimination (this commit) |
| 3 | `checkpoints/check-run-cancelled.ts` | 30–40 | Query + JS | ✅ try/catch + status-only fallback |
| 4 | `checkpoints/cancel-module-run.ts` | 65–82 | DML (`SET is_cancelled = TRUE`) | ✅ try/catch + status-only fallback |
| 5 | `checkpoints/resurrect-module-run.ts` | 55–65 | DML (`SET is_cancelled = FALSE`) | ✅ try/catch + without-column fallback |
| 6 | `checkpoints/resume-completed-run.ts` | 27–37 | Query + JS | ✅ try/catch + status-only fallback |
| 7 | `checkpoints/update-run-status.ts` | 35–40 | Query + JS | ✅ try/catch + empty catch (silent proceed) |
| 8 | `pipeline/reset-module-merge.ts` | 35–43 | Query + JS | ✅ try/catch + status-only fallback |
| 9 | `modules/get-run-history.ts` | 33–52 | Query (SELECT expr) | ✅ try/catch + `FALSE AS is_cancelled` fallback |
| 10 | `modules/load-module-results.ts` | 85–98 | Query (template replacement) | ✅ try/catch + template swaps to `FALSE AS` |
| 11 | `pipeline/run-migration-009.ts` | 38–64 | DDL + introspection | ✅ Safe-by-construction (IS the migration itself) |

**Result: 11 sites total. All 11 guarded (10 explicit try/catch, 1 safe-by-construction). Zero unguarded references remain.**

### Deploy Gate

This commit is deploy-gated pending Devanshu's `RunMigration009` execution:
- **If 009 succeeds** → guard + audit ride the post-gate hygiene zip; deploy freeze holds.
- **If 009 fails** → deploy this as pre-run hot-fix (deploy-freeze exception); paste verbatim 009 error here for escalation record.

### Testing Note

The addendum-era "tested both pass" exercised admin APIs against all-zeros UUIDs — it never exercised the resume path a real client invocation takes. Line 738 escaped because no integration test runs `RunModulePipeline` against a pre-existing run_id in a database missing `is_cancelled`. The staged cancel acceptance test now includes a pre-migration-state clause only if 009 fails; otherwise this class of gap dies with the migration.
