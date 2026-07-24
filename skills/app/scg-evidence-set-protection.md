---
name: SCG Evidence Set Protection
description: Governance rule protecting the SCG deal's runs, checkpoints, and
  outputs from admin API executions. Applies whenever Clark considers calling
  ResetModuleMerge, ResurrectModuleRun, UpdateRunStatus, PurgeDealHistory,
  PurgeExtractions, ResetDealRun, or any destructive API against the SCG deal.
accessType: on_demand
isEnabled: true
createdAt: 2026-07-24T14:48:25.001Z
---

# SCG Evidence Set Protection

The SCG deal's (`c46b4129-8a16-48ae-ad3a-1da061255445`) runs, checkpoints, and outputs are a **protected evidence set**.

## Rule

No admin API executions against SCG data without **Devanshu's explicit prior consent** — same tier as pipeline runs.

Protected APIs (non-exhaustive):
- `ResetModuleMerge`
- `ResurrectModuleRun`
- `UpdateRunStatus`
- `PurgeDealHistory`
- `PurgeExtractions`
- `PurgeStaleRuns`
- `PurgeDocumentExtractions`
- `ResetDealRun`
- `CancelModuleRun`
- Any API that writes to `module_runs`, `merge_checkpoints`, `extraction_results`, or `module_outputs` for this deal

## Testing

Testing happens on **scratch runs or nonexistent IDs only** (e.g. `00000000-0000-0000-0000-000000000000`). The change list must state which IDs were used for testing.

## Scope

This rule is permanent and applies alongside the Pipeline Run Consent Gate.
