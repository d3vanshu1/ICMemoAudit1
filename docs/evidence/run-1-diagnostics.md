# Run #1 Diagnostics — Deal SCG (c46b4129)

**Run ID:** `0e4cc96d-1c81-4289-8de9-d538ccbf4cf4`
**Module:** `omission_audit`
**Triggered:** 2026-07-24T23:36:44.939Z (7:36 PM ET)
**Final observed status:** transitioned out of "running" between 00:05–00:18 ET on 2026-07-25

---

## 1. DiagMergeFunnel

```
                    376 analysis nodes
                          │
              ┌───────────┴───────────┐
              │     MERGE_GROUP_SIZE=4     │
              └───────────┬───────────┘
                          ▼
Round 1:   94 groups  (376/4 = 94)      ← timeoutCap = 165,000 ms
Round 2:   24 groups  ( 94/4 = 24, ceil) ← timeoutCap = 180,000 ms
Round 3:    6 groups  ( 24/4 =  6)      ← timeoutCap = 180,000 ms
Round 4:    2 groups  (  6/4 =  2, ceil) ← timeoutCap = 180,000 ms
Round 5:    1 group   (  2/4 =  1, ceil) ← timeoutCap = 180,000 ms (final)
                          │
                          ▼
               TOTAL: 127 merge groups
```

### Checkpoint Progression (observed this session)

| Timestamp (ET)  | mergeCheckpointCount | Notes                                |
|-----------------|---------------------|--------------------------------------|
| ~10:30 PM       | 5                   | Initial after FE#2 deployed          |
| ~10:45 PM       | 37                  | Post FE#3 (timeout raised to 165s)   |
| ~11:00 PM       | 42                  | Still Round 1, pre-false-kill fix    |
| ~11:30 PM       | 42                  | Stalled — client kill trap active    |
| ~11:40 PM       | 42+                 | FE#4 + false-kill fix deployed       |
| 00:05 AM (7/25) | 109                 | Round 1 done (94) + Round 2: 15/24   |
| 00:18 AM (7/25) | N/A                 | Run no longer in "running" filter    |

**Final merge checkpoint count (last observed):** 109 of 127 total
**Round 1 (94/94):** Complete
**Round 2 (15/24):** In progress at last read — run likely completed shortly after

---

## 2. Absence-Verification Log

Absence verification did not execute during this session's observation window.
The module was `omission_audit` (single-module run). Absence verification is a
post-merge phase that fires after the final merge node is produced.

**Status:** Deferred to run-#2 observation. If the run completed between 00:05–00:18 ET,
absence verification may have run within the final invocation (minimum budget = 120s).

---

## 3. Final Counters

| Counter                   | Value | Notes                                                         |
|---------------------------|-------|---------------------------------------------------------------|
| `extractionCount`         | 381   | From GetRunProgress (5 more than 376 analysis = re-extractions)|
| `analysisCheckpointCount` | 376   | All analysis nodes completed                                  |
| `mergeCheckpointCount`    | 109   | Last observed (94 R1 + 15 R2). Run likely finished at 127.    |
| `checkpointErrors`        | `[]`  | Zero errors at last observation                               |
| `truncatedMerges`         | TBD   | Not queryable via current APIs — value stored in final output |
| `mergeGroupsFallenBack`   | ≥1    | FE#3 disclosure active (⚠️ emitted in report). Exact count stored in final output. |

**Note:** `truncatedMerges` and `mergeGroupsFallenBack` are only readable from the
final pipeline result (returned to client) or by querying `module_run_results`.
These values will be confirmed from run-#2 telemetry where they are explicitly logged.

---

## 4. Intermediate Housekeeping Emission

**Observation method:** Code inspection (runtime data not directly queryable).

The merge prompt includes `<housekeeping_appendix>` as a mandatory output tag.
Whether intermediate (non-final) nodes emitted non-empty housekeeping arrays
depends on the model's judgment at each merge step.

**Expected behavior:** Intermediate rounds SHOULD produce housekeeping items as
sub-materiality findings are encountered. The pre-run-#2 prompt now makes emission
mandatory (even if empty), so run-#2 will provide definitive evidence.

**Run-#1 gap:** No mechanism to query intermediate checkpoint housekeeping content
without reading the `merge_checkpoints.result_json` column directly. This is a
run-#2 observability improvement candidate.

---

## 5. Telemetry Table — Incidents 1–4

| # | Freeze Exception | Time (ET) | Commit | Diagnosis | Fix |
|---|------------------|-----------|--------|-----------|-----|
| 1 | FE#1 | ~8:30 PM | (pre-session) | Pipeline stalling at analysis phase — `callAnthropic` timeout too low for large prompts | Raised analysis timeout, added retry budgets |
| 2 | FE#2 | ~9:15 PM | (pre-session) | Merge checkpoints failing — MERGE_GROUP_SIZE tuning, checkpoint schema | Checkpoint schema fix + group size adjustment |
| 3 | FE#3 | ~10:30 PM | `06fa62de` | Merge Round 0-1 groups timing out at 120s ceiling — prompt growth from coverage map + numeric block exceeded budget | Raised `timeoutCap` 120→165s (R0-1). Added `mergeGroupsFallenBack` counter + ⚠️ disclosure in report. |
| 4 | FE#4 | ~11:45 PM | `89660cd2` | **Two-part.** (a) `callLLMWithHeadroom` retries starting with insufficient headroom → doomed clamped call → platform kill disguised as network error. (b) Client `resumeFailureCountRef` threshold=2 with permanent kill — no self-recovery. | (a) Budget-aware retry: `attempt > 1 && remainingHeadroom < maxPerCallTimeout` → HeadroomExhaustedError. (b) Kill threshold 2→5, permanent kill replaced with 2-min backoff + progress check + final resume attempt. |

### Root Cause Summary (Incident 4 — the structural finding)

The platform's 300s hard kill was being triggered NOT by slow model responses alone,
but by the interaction of:

1. **Retry-within-batch amplification:** A group timing out at 150s would retry using
   `remainingHeadroom` (up to 95s more), pushing total batch time to ~267s
2. **Post-batch DB writes:** 5 sequential checkpoint INSERTs + heartbeat UPDATE at 5-8s
   each under Supabase load → 30-40s
3. **Total: 267 + 35 = 302s > 300s kill**

The graceful exit check (`timeRemaining() < 60s`) was structurally unreachable at its
designed point (140s elapsed) because it only ran between batches, and any batch launched
at t=20s with retries could run until t=267s.

**Fix deployed in this commit:** Batch-aware exit guard uses `EFFECTIVE_CAP_MS - elapsed`
(real platform clock) and checks against worst-case batch duration (2×timeoutCap + 5s + 40s reserve).
Exit fires at the RIGHT time, before any batch whose worst case could breach the kill.

---

## 6. Acceptance Criteria for Run #2

| Criterion | Measurement |
|-----------|-------------|
| Graceful-exit log lines present | `[pipeline:graceful-exit]` appears in server logs for every invocation that exits early |
| Zero platform kills observed | Client never enters resume-failure handler due to network timeout during merge/analysis |
| Report quality: housekeeping appendix always emitted | Every merge checkpoint's `result_json` contains `<housekeeping_appendix>` tag |
| Mitigation-carry rule respected | Findings citing graded DD items include source grade + mitigation |
| `mergeGroupsFallenBack` = 0 | No timeout-induced fallbacks with the batch-aware exit preventing overruns |
| Two-sided pass: completeness + no false positives | Existing SCG acceptance criteria from gate review |
| Watchdog log line fires when expected | `[watchdog] Module {id} is DB-running with no client driver` appears if/when dead-spot occurs; ideally NEVER appears (heartbeat suffices) |

---

## 7. Handoff-Readiness Ledger — §5: Reliability Guarantee Assessment

The watchdog closes the "stuck until refresh" failure mode. A module that becomes orphaned
(DB says running, no client poll loop driving it) will be detected and re-attached within
one watchdog interval (~60s) plus the time for the resumed `handleRunModule` to connect
to the server pipeline (~5-15s). Total recovery window: **~60-90 seconds** from the moment
the orphaning occurs, provided the tab is open and visible.

**Precise guarantee:**
- ✅ Recovers within ~60-90s of the tab being **open and visible**
- ✅ Survives pipeline-call failures, network timeouts, and heartbeat dead-spots
- ✅ Does not resurrect deliberately killed modules (`killedModulesRef` respected)
- ✅ Does not conflict with active polling or in-progress resumes (checks both flags)
- ❌ Does **NOT** survive a closed tab
- ❌ Does **NOT** survive a fully backgrounded/throttled tab (Chrome suspends timers after ~5 min)
- ❌ Does **NOT** provide "one-click-walk-away" reliability — that requires server-side orchestration

**What true walk-away reliability requires:**
A client-resident poll loop is structurally incapable of achieving "start run → close laptop → come
back to finished report" reliability. That requires one of:
1. **Superblocks Scheduled Jobs** (pre-GA) — server-side cron that monitors run state and invokes
   `RunModulePipeline` independently of any browser session
2. **External cron** (e.g., GitHub Actions, AWS EventBridge) — hitting the Superblocks API on a
   schedule to resume orphaned modules

The watchdog is the best-achievable client-side fix. It solves "my module is stuck and I have to
refresh the page" — it does NOT solve "I can close my laptop and walk away." The latter is a
platform capability gap, not a code bug.
