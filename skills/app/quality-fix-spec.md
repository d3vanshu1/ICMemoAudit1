# Quality Fix Spec — Seven Fixes

## Diagnosis Inputs (sizing data)

### DiagRawFlagAggregate
- 381 total chunks across 8 documents, 0 failed
- `flags`/`data_points`/`key_claims` all zero — universal_extractions stores unstructured markdown text, not structured flags
- Structured findings only emerge in the merge phase

### DiagMergeFunnel (run 32087fa4)
- Level 1 (leaves): 95 nodes, 826 total findings
- Level 2: 24 nodes, 434 findings (53% collapse)
- Level 3: 6 nodes, 350 findings (81% retention from 434)
- Level 4: 2 nodes, 350 findings (100% — no further collapse)
- Level 5 (root): 1 node, 350 findings (100%)
- Overall: 826 → 350 (42% survival)
- Key: collapse stops at level 3+. Rounds 3→4→5 pass everything. This is where retrieval verification must intervene.

---

## Fix 1 — Coverage-Map Snippets (not counts)

Instead of just counting which chunks were analyzed, provide the merge layer with actual text snippets from the coverage map. This feeds the retrieval verification gate (Fix 2).

**Implementation:** When the merge step prepares context for a finding asserting absence, retrieve and include verbatim text snippets from all chunks in the subject document(s) that match the claim's key terms. The merge layer sees actual source text, not just "25 chunks analyzed."

---

## Fix 2 — Retrieval Verification Gate

Before the merge (or Step 5.5) emits any finding asserting memo-wide or deal-room-wide absence:

1. Targeted retrieval runs across all subject-document chunks for the claim's key terms and synonyms
2. Retrieved snippets enter the prompt
3. Six-point rubric adjudicates

### Six-Point Rubric (verbatim, binding in verification prompt)

1. **Quote-anchored** — Every factual claim in a finding must be traceable to a verbatim quote from source text
2. **Fact-of-process not emphasis-judgment** — Findings state what IS or IS NOT in the documents; they do NOT judge whether the document "underweights" or "de-emphasises" a topic
3. **Two-sided verified** — Before asserting absence, the system verifies the claim is not covered under alternate terminology, indirect references, or in other documents
4. **Numbers traced** — Every numeric figure in a finding is backed by a verbatim source snippet containing that number (see Fix 3)
5. **Post-IC staging respected** — Work the record explicitly stages post-IC is classified `open_item`, never an omission (see Fix 5)
6. **IC-chair materiality** — Would this plausibly change an IC member's assessment of the transaction? (see Fix 4)

### Emphasis-judgment demotion
Findings using language like "underweighted," "de-emphasised," "insufficient emphasis," "not given enough prominence" are demoted to a `human_review_flag` category or dropped entirely. These are subjective editorial judgments, not factual gap assertions.

---

## Fix 3 — Numeric Trace-Back

Every number appearing in any finding must be backed by a verbatim source snippet containing that number, stored in the finding's `evidence` array.

**Rules:**
- A figure with no textual match anywhere in extracted source text (i.e., chart/vision-derived) is labeled `numeric_unverified` or dropped
- An adversarial numeric pass runs over every drafted finding pre-merge-output: re-retrieve source text for each figure, reject on mismatch

**Paper traces (falsified findings this kills):**
- The NPS transposition (real values 49/13/54/75-segment)
- The fabricated £250m→£194m revenue decline (actual P&L grows 144.8→168.2→192.5)
- The 12%-vs-14% A-Pref coupon

---

## Fix 4 — Materiality Gate

Prompt-level standard at both analysis and merge, verbatim:

> "Would this plausibly change an IC member's assessment of a £655m transaction, or is it a standard DD-workstream, post-close housekeeping, or process-stage item?"

**Implementation:**
- Every surviving finding carries a one-line `materiality_rationale` field
- Merge demotes sub-threshold items to a **housekeeping appendix section** rather than deleting them
- Target envelope: **single digits to low teens** of principal findings
- Demotion threshold sized against DiagRawFlagAggregate output (381 chunks → currently 350 findings surviving merge = far too many; target ~10-15 principal + appendix)

---

## Fix 5 — Deal-Process Context

Extract the memo's own DD/adviser table — specifically the "kick off post IC" rows (White & Case legal DD, tax, legal docs, financing docs) — and inject it into analysis and verification prompts as ground truth.

**Rule:** Work the record explicitly stages post-IC is classified `open_item_acknowledged` (Fix 7), never an omission.

**Paper trace:** The legal-DD staleness/reliance/bring-down cluster reframes from four critical "omissions" to one staged-process register item.

---

## Fix 6 — Semantic Dedup at Merge

Same-underlying-issue consolidation: merge-prompt instruction plus a final normalization pass that clusters findings by issue identity, not title string.

**Known targets from the corpus:**
- One tax-documentation finding appearing three times verbatim (#211/212/213)
- The stale-legal-DD and no-reliance pairs
- The five-way dealer-buyout cluster

**Sizing:** DiagMergeFunnel shows collapse stops at level 3 (collapseRatio=1.0 at levels 4–5). This means findings at that level are "different enough" by string to survive pairwise dedup, but many are the same underlying issue worded differently. The semantic dedup pass must operate on issue identity (what is the actual concern?) not string similarity.

---

## Fix 7 — Taxonomy Addition: `open_item_acknowledged`

New `gap_type` value: **`open_item_acknowledged`** — for findings whose content the record itself discloses as open.

**Canonical example:** The FTI "results TBD" line.

**Distinct from `omission` in:**
- Schema (separate enum value)
- Merge prompt (instructions to classify, not promote)
- Report rendering (separate section, informational tone, not flagged as risk)

---

## Cross-Cutting Requirements

1. The six-point rubric is the verbatim core of the verification prompt (Fix 2)
2. Emphasis-judgment findings are demoted to `human_review_flag` or dropped
3. ResetModuleMerge refusal message must say: "use ResurrectModuleRun to revive a cancelled run" — so the flag-not-cleared design can't strand an operator
4. CHANGELOG.md opens with verbatim RunMigration008 error text + executor
5. Paper-executed traces map each falsified finding to the fix that kills it
6. DiagRawFlagAggregate and DiagMergeFunnel outputs included in delivery

---

## Delivery Checklist

- [x] CHANGELOG.md (gate item + fix descriptions)
- [x] Paper traces per falsified finding → fix mapping
- [x] DiagRawFlagAggregate output
- [x] DiagMergeFunnel output
- [x] ResetModuleMerge refusal message updated
- [x] All seven fixes implemented and tested
