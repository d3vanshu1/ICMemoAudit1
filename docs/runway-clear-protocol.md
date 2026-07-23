# Runway Clear Protocol

Standard operating procedure for resetting a deal to first-time IC-member state before a validation run.

## Steps

### 1. DB Purge

Execute `PurgeExtractions` for the target deal:

```
testApi("PurgeExtractions", { dealId: "<deal-uuid>" })
```

This deletes (in FK-safe order):
1. `universal_extractions` — all chunk extraction data
2. `pipeline_analysis` — all sub-agent analysis checkpoints
3. `doc_tables` — structured spreadsheet tables (repopulated by Step 0.6)
4. `module_outputs` — final report outputs
5. `merge_checkpoints` — hierarchical merge tree state
6. `module_runs` — run history (actual DELETE, not status change)

**Preserved (never touched):**
- `documents` table (metadata, file references)
- `parsed_text` (stored in documents table)
- `parsed_text_backups`
- Document tags (`document_tag` column)
- `sub_agent_prompts` (global, not deal-scoped)
- Pipeline config / constants

### 2. Session Reload (MANDATORY)

After purge, **every open app session must be hard-reloaded**.

**Why:** `refetchOnWindowFocus: false` is set on useApiData calls (correct for preventing spurious refetches during normal use), but it means open tabs will display deleted runs/outputs indefinitely until the page is fully remounted.

**Action:**
- Clark's preview: `build_reloadFile()` (no path = full reload)
- User's browser: instruct to hard-reload (Cmd+Shift+R / Ctrl+Shift+R)
- Any other open sessions: same

### 3. Verification Gate

Before declaring runway clear, confirm all four:

| Check | Expected |
|-------|----------|
| `GetExtractionStatus` | `total: 0, extracted: 0` |
| `GetRunProgress` | `runs: [], extractionCount: 0` |
| `ListDocuments` | All documents present with correct tags and `parsed_text_length > 0` |
| Visual dashboard | No module results, no run history, clean module cards |

### 4. doc_tables Repopulation

`doc_tables` is regenerated automatically by **Step 0.6 (`runDocTablesPhase`)** on the first pipeline invocation. It parses spreadsheet data from `parsed_text` — pure CPU, no LLM, completes in seconds.

Confirm after first invocation that `GetDocTablesSummary` shows expected sheet count.

## Notes

- `PurgeExtractions` does actual `DELETE FROM module_runs`, not a status change. Run History panel will show zero entries.
- The concurrent guard (`WHERE status = 'running'`) has nothing to block against — fresh runs proceed immediately.
- If `PurgeDealHistory` exists as a separate API, it is redundant after `PurgeExtractions` (which already covers runs + outputs).
