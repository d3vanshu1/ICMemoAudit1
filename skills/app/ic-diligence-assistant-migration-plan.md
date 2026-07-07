---
name: IC Diligence Assistant — Migration Plan
description: Phased migration plan for porting IC Diligence Assistant from
  reference Express/Supabase app into Superblocks. Tracks phase completion
  status, what's verified, and what's deferred.
accessType: on_demand
isEnabled: true
createdAt: 2026-04-22T22:16:54.219Z
---

## Migration Phases

| Phase | Description | Status |
|-------|-------------|--------|
| **1** | Foundation (CSS, types, utils, dummy data) | ✅ Complete & verified |
| **2** | UI Primitives (ICButton, ICBadge, ICModal, ICSpinner, StatCard, StreamingText) | ✅ Complete & verified |
| **3** | Deal List Page (DealCard, DealForm, search, create/delete) | ✅ Complete & screenshot verified |
| **4** | Dashboard Layout (Sidebar, DashboardHeader, AppShell) | ✅ Complete & screenshot verified |
| **5** | Dashboard Content (ModuleCard, ModuleGrid, ModuleOutput, RunAllModal, RunHistory, QAPanel, StatsRow, AlertBanner) | ✅ Complete & screenshot verified |
| **6** | Polish (NotFound page, Skeleton loaders, ErrorBanner, responsive tweaks, brand audit) | ✅ Complete & verified |
| **7** | Cleanup (delete Page1, reference/) | ⏸️ Deferred |
| **8** | Anthropic AI pipeline (Omission Audit) | ✅ Complete — 3-API split, tested end-to-end |
| **9** | All 9 module prompts + web research | ✅ Complete — all modules wired, external risk & social reputation use web research |
| **10** | Database integration (PostgreSQL) for persistence | 🔄 In progress |
| **11** | Live Q&A with Anthropic | ❌ Not started |

## API Architecture

The analysis pipeline uses 4 APIs with client-side orchestration:

1. **AnalyzeChunk** (`server/apis/modules/analyze-chunk.ts`) — Sonnet, one chunk at a time, ~30-60s
2. **MergeFindings** (`server/apis/modules/merge-findings.ts`) — Sonnet, deduplicates & prioritizes → executive header + findings JSON
3. **FormatReport** (`server/apis/modules/format-report.ts`) — Sonnet, formats findings → detailed markdown report
4. **WebResearch** (`server/apis/modules/web-research.ts`) — Sonnet + web_search_20250305 tool, iterative web research for external_risk_overlay and social_reputation modules

Client orchestrates in `DealDashboard/index.tsx`:
- Standard modules: `handleRunModule()` — chunk → analyze → tree-merge → report
- Web research modules: `runWebResearchModule()` — chunk → analyze → research loop → tree-merge (research only, doc context as reference) → report
- "Run All" runs all 8 non-summary modules simultaneously, then Executive Summary auto-runs

## Web Research Architecture (Phase 9)

- **Modules using web research**: `external_risk_overlay`, `social_reputation` (stored in `WEB_RESEARCH_MODULES` Set)
- **Anthropic web_search_20250305**: Server-side tool — single API call per iteration, no multi-turn needed
- **External Risk**: Max 10 iterations, confidence threshold 8/10, 2 consecutive required
- **Social Reputation**: Max 12 iterations, confidence threshold 8/10, 2 consecutive required
- **Research output fields**: `query`, `finding`, `confidence`, `category`, `sources` (URL array), `materiality`, `platform` (social_reputation only)
- **Prompt philosophy**: Categories are guidance (launchpad), not constraints. OTHER category for unexpected findings. Agent encouraged to follow curiosity.
- **Merge approach**: Only research iterations go into tree-reduce. Document extractions are prepended as REFERENCE CONTEXT (not peer nodes) so merge doesn't restate deal doc content as findings.
- **Report format**: Dynamic categories driven by actual findings, cross-reference summary table, source attribution per finding

## File Processing

- PDFs: client-side via `pdfjs-dist` — 10-page chunks, 120 DPI JPEG + text, canvas dimension capping
- Excel (xlsx): client-side via `xlsx` (SheetJS) — converts sheets to CSV text
- CSV: client-side via `papaparse` — parses and formats as text
- Max chunks: 30 total across all files
- Curly brace sanitization: `{` → `﹛`, `}` → `﹜` (both client & server)

> ⚠️ **TODO: Switch back to Opus** — MergeFindings and FormatReport use `claude-sonnet-4-6` as a workaround for the platform's 120-second block query limit. Once Superblocks support raises this quota, change `COORDINATOR_MODEL` in both files back to `claude-opus-4-6` for higher-quality synthesis.

## Key Decisions
- **Models**: `claude-sonnet-4-6` for all steps currently
- **Desired models**: Sonnet for sub-agents, **Opus for synthesis** (blocked by 120s platform limit)
- **Prompts**: Embedded directly in API code
- **Anthropic integration ID**: `8ccd43c8-5340-4ae2-8eee-7cbb3896df53`
- **Server VM limitation**: Cannot import npm packages (only `@superblocksteam/sdk-api` and built-ins)

## Deferred Items
- Phase 7: Cleanup (delete Page1/index.tsx, reference/ directory)
- RerunSuggestionModal (Phase 5 — non-critical)
- **Opus upgrade**: Contact Superblocks support to raise 120s block query limit

## Architecture Notes
- 2-page SPA: DealList (`/`) and DealDashboard (`/deals/:dealId`)

## API Call Optimization (Shared Extraction + Smart Routing)
- **UniversalExtract API** (`server/apis/modules/universal-extract.ts`): Replaces per-module `AnalyzeChunk` calls with a single comprehensive extraction per chunk. Extracts all data points across all module dimensions in one pass. Cached in `universalExtractionsCache` ref so re-runs reuse results.
- **Chunk Routing** (`client/lib/chunkRouting.ts`): Maps document tags (CIM, IC Memo, Financial Model, etc.) to relevant modules. "Other" tagged docs go to all modules as safe default. Routing only affects which extractions feed each module's merge phase — all chunks are still extracted universally.
- **Impact**: ~240 AnalyzeChunk calls → ~30 UniversalExtract calls (8× reduction). Merges also reduced because fewer routed chunks per module. Total: ~60% reduction in API calls.
- **AnalyzeChunk API retained**: Not deleted — still used by the Executive Summary module which has its own extraction needs.
- 9 AI analysis modules with map-reduce pattern
- Brand: Codec Pro font, Dark Blue #061f42, Turquoise #00b8c1, Coral #e06448, Soft Gray #c6c6bc
- All ic-* Tailwind tokens defined in index.css @theme block
- `AnalysisProgress` type exported from `ModuleGrid.tsx`
- Progress UI: turquoise bar for chunk analysis, amber bar for research, coral bar for synthesis
