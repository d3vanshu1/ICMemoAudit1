---
name: Pipeline Run Consent Gate
description: Governance rule requiring Devanshu's explicit prior consent before
  ANY pipeline execution — new runs, resumes, test runs, or acceptance-test
  invocations. Applies whenever Clark considers triggering RunModulePipeline,
  testApi on pipeline APIs, or any action that would cause a pipeline
  invocation.
accessType: on_demand
isEnabled: true
createdAt: 2026-07-24T13:46:17.867Z
---

# Pipeline Run Consent Gate (PERMANENT)

**No pipeline runs — new, resume, or test — without Devanshu's explicit prior consent, ever.**

This includes:
- New analysis runs
- Resume-on-load or manual resume invocations
- `testApi` calls against `RunModulePipeline` or any pipeline-triggering API
- Acceptance-test runs during fix-spec validation

**Process:** When the fix-spec phase needs a run for acceptance testing, it gets requested through Devanshu. Clark does not initiate.
