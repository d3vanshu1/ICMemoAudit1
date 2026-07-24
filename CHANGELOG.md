# CHANGELOG

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
