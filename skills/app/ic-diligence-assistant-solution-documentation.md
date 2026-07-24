---
name: IC Diligence Assistant — Solution Documentation
description: Comprehensive documentation of the IC Diligence Assistant covering
  its business purpose, analysis modules, business rules, expected outputs,
  technical architecture, API inventory, data model, and file processing
  pipeline. Reference when onboarding, auditing, extending, or debugging the
  application.
accessType: on_demand
isEnabled: true
createdAt: 2026-06-29T15:41:51.091Z
---

# IC Diligence Assistant — Solution Documentation

## 1. Overall Purpose

The IC Diligence Assistant is an AI-powered due diligence platform for private equity investment committees (ICs). It automates the review of deal data rooms — the collections of documents (CIMs, IC memos, financial models, legal agreements, consultant reports, customer data) that inform an investment decision.

**Problem it solves:** Senior PE professionals spend 40–80 hours per deal manually reading data rooms, identifying gaps, cross-referencing claims against data, and preparing IC questions. This tool compresses that work into minutes by running 9 specialized AI analysis modules across every document in the data room simultaneously.

**Target users:** Deal team associates, VPs, and Managing Directors preparing for Investment Committee meetings.

**Core workflow:**
1. Create a deal with metadata (name, sector, entry EV, equity check, IC date)
2. Upload data room documents (PDF, Excel, CSV) and tag them by type
3. Run one or all analysis modules — each produces an IC-ready report with prioritized findings
4. Ask follow-up questions via the live Q&A panel (RAG over indexed documents)
5. Review run history and re-run modules as new documents are added

---

## 2. Analysis Modules & Business Rules

### 2.1 Module Inventory (9 modules)

| # | Module ID | Display Name | Purpose |
|---|-----------|-------------|--------|
| 1 | `omission_audit` | Omission Audit | Identifies missing information, data gaps, and absent sections against PE diligence standards |
| 2 | `contradiction_check` | Narrative vs. Data Check | Finds inconsistencies between narrative docs (CIM, IC Memo) and underlying data (financial model, customer data) |
| 3 | `blind_spot_scanner` | Blind Spot Scanner | Surfaces implicit assumptions in the investment thesis that are never explicitly addressed |
| 4 | `external_risk_overlay` | External Risk Overlay | Deep web research for regulatory, competitive, and macro risks not present in the data room |
| 5 | `social_reputation` | Social & Reputation Intelligence | Web research across Glassdoor, LinkedIn, X/Twitter, review platforms. Cross-references deal team claims against public signals |
| 6 | `ic_challenge_mode` | IC Questions | Generates the hard questions an IC member is likely to ask |
| 7 | `model_assumptions_stress` | Model Assumptions Stress Test | Stress-tests financial model assumptions against data and benchmarks |
| 8 | `diligence_completeness` | Diligence Completeness Score | Scores the data room across 10 standard PE diligence dimensions |
| 9 | `executive_summary` | Executive Summary | Synthesizes all module outputs into a single IC-ready executive brief |

### 2.2 Business Rules

**Document tagging & routing:**
- Every uploaded document is tagged: `cim`, `ic_memo`, `customer_data`, `consultant_report`, `financial_model`, `legal`, or `other`
- Documents tagged `other` are routed to ALL modules (safe default)
- Each module has a defined relevance set (see `chunkRouting.ts`). For example, `model_assumptions_stress` receives `ic_memo`, `financial_model`, `cim`, `consultant_report`, and `other` — but not `legal` or `customer_data`
- Omission Audit, Contradiction Check, and Diligence Completeness receive ALL document types (they assess completeness/consistency across the entire data room)

**Extraction & analysis:**
- All documents are processed through a single **Universal Extraction** pass — one API call per chunk extracts data points across ALL module dimensions simultaneously
- Extractions are cached client-side; re-running a module reuses cached extractions unless the document set changes
- Fresh uploads (current session File objects) use the full PDF rendering pipeline (images + text)
- Stored documents (from prior sessions) contribute text-only chunks from their `parsed_text` in the database
- Both fresh uploads and stored documents are combined for analysis; a stored document is skipped only if a fresh upload shares the same filename

**Web research modules:**
- `external_risk_overlay` and `social_reputation` use Anthropic's `web_search_20250305` server-side tool
- External Risk: max 10 research iterations, confidence threshold 8/10, 2 consecutive high-confidence results required to stop
- Social Reputation: max 12 iterations, confidence threshold 8/10, 2 consecutive required
- Research output fields: `query`, `finding`, `confidence`, `category`, `sources` (URLs), `materiality`, `platform` (social_reputation only)
- Research iterations are tree-merged independently; document extractions are prepended as REFERENCE CONTEXT only (not peer nodes)

**Executive Summary:**
- Requires all 8 other modules to complete first
- Auto-runs after "Run All" completes
- Synthesizes all module outputs into a single IC-ready brief

**"Run All" behavior:**
- Runs all 8 non-summary modules in parallel
- Executive Summary auto-triggers once all 8 complete
- Individual module failures don't block other modules

**File processing limits:**
- Max 30 chunks total across all files
- PDFs: 10 pages per chunk, 120 DPI JPEG rendering, JPEG quality 0.45
- Excel: 40,000 chars per chunk, cell formulas preserved as `[=FORMULA]`
- CSV: parsed via PapaParse, re-emitted as clean CSV
- Curly braces sanitized to Unicode equivalents (`﹛` / `﹜`) to prevent Superblocks binding parser conflicts

### 2.3 Expected Outputs

Each module run produces three artifacts:

1. **Executive Header** — 3–4 sentences for a busy IC chair summarizing the key risk posture
2. **Findings Array** — structured JSON with:
   - `severity`: `critical` | `warning` | `info`
   - `title`: 5–10 word heading
   - `detail`: 2–3 sentence summary with document references
   - `full_analysis`: complete paragraph with reasoning and evidence
   - `source_docs`: array of source filenames
3. **Full Report (Markdown)** — detailed narrative report formatted per module type (e.g., Omission Audit has "Critical Omissions → Elevated Omissions → Watch Items → Recommended Actions")

**Persisted to database:** All three artifacts are stored in the `module_outputs` table linked to a `module_runs` record.

---

## 3. Technical Architecture

### 3.1 Application Structure

- **Framework:** React SPA on Superblocks platform
- **Pages:** 2-page SPA — `DealList` (`/`) and `DealDashboard` (`/deals/:dealId`)
- **Styling:** Tailwind CSS with custom `ic-*` tokens; Codec Pro font family
- **Brand colors:** Dark Blue `#061f42`, Turquoise `#00b8c1`, Coral `#e06448`, Soft Gray `#c6c6bc`

### 3.2 AI Pipeline (Map-Reduce)

The core analysis follows a **map → merge → format** pattern orchestrated client-side in `DealDashboard/index.tsx`:

```
┌─────────────┐
│  Documents   │  (PDF, Excel, CSV files)
└──────┬──────┘
       │ Client-side processing (pdfProcessor.ts)
       ▼
┌─────────────┐
│   Chunks    │  (max 30, each ≤10 PDF pages or ~40K chars)
└──────┬──────┘
       │ UniversalExtract API (1 call per chunk)
       ▼
┌─────────────┐
│ Extractions │  (cached, tagged by document type)
└──────┬──────┘
       │ chunkRouting.ts (filters by module relevance)
       ▼
┌─────────────┐
│   Routed    │  (only relevant extractions per module)
│ Extractions │
└──────┬──────┘
       │ MergeFindings API (tree-reduce: pairs of 2)
       ▼
┌─────────────┐
│  Findings   │  (executive header + structured findings JSON)
└──────┬──────┘
       │ FormatReport API
       ▼
┌─────────────┐
│   Report    │  (full markdown report)
└──────┬──────┘
       │ SaveModuleResult API
       ▼
┌─────────────┐
│  Database   │  (module_runs + module_outputs)
└─────────────┘
```

**Web research modules** follow a variant path:
```
Chunks → UniversalExtract → WebResearch API (iterative search loop)
  → Tree-merge research findings (doc extractions as reference context)
  → FormatReport → SaveModuleResult
```

### 3.2.1 Cancel Gates & Latency Deviation

The server-side pipeline checks for cancellation at 6 discrete gates:

| Gate | Location (pipeline-core.ts) | Max latency before detection |
|------|----------------------------|------------------------------|
| `post_extraction` | Line 1094 | One extraction invocation (~up to 600s worst case, typically <120s) |
| `between_analysis_batches` | Line 1477 | One analysis batch (~30-60s) |
| `post_analysis` | Line 1517 | Instantaneous (no work between prev gate) |
| `merge_round` | Line 1741 | One merge round (~30-60s per group) |
| `pre_absence_verification` | Line 2001 | Instantaneous |
| `pre_formatting` | Line 2100 | One absence verification pass (~120s) |

**Extraction-latency deviation (accepted):** The `post_extraction` gate is the first cancel check. If a cancel is issued while extraction is running, the pipeline will not detect it until extraction either completes or returns `in_progress` (budget exhausted). Worst-case latency: **one full invocation** (~600s cap, but typically much shorter because extraction is internally time-budgeted and returns `in_progress` when budget runs low). This is accepted because:
1. Extraction is purely additive (cached) — no harm in completing an extraction pass
2. The client-side `killedModulesRef` prevents the next invocation from being triggered
3. Adding an intra-extraction gate would complicate the extraction phase for marginal benefit

### 3.3 Client-Side Processing

**File:** `client/lib/pdfProcessor.ts`

| File Type | Library | Processing |
|-----------|---------|------------|
| PDF | `pdfjs-dist` | Render pages to 120 DPI JPEG + extract text; 10 pages per chunk |
| Excel (.xlsx/.xls) | `xlsx` (SheetJS) | Direct cell reading with formula preservation; CSV output format |
| CSV | `papaparse` | Parse, validate, re-emit as clean CSV |
| Other | Native `TextDecoder` | Plain text extraction |

### 3.4 Chunk Routing

**File:** `client/lib/chunkRouting.ts`

After universal extraction, each extraction carries a `documentTag`. The routing table maps tags to modules:
- **All tags → all modules:** `omission_audit`, `contradiction_check`, `diligence_completeness`
- **Selective routing:** e.g., `model_assumptions_stress` skips `legal` and `customer_data`
- **Safe default:** `other` tag goes to every module

This reduces merge calls significantly — a 30-chunk data room with diverse document types sends ~15–20 extractions per module instead of 30.

---

## 4. API Inventory

### 4.1 AI Pipeline APIs

| API | File | Integration | Purpose |
|-----|------|-------------|--------|
| `UniversalExtract` | `server/apis/modules/universal-extract.ts` | Anthropic (Sonnet) | Single-pass extraction across all module dimensions for one chunk |
| `AnalyzeChunk` | `server/apis/modules/analyze-chunk.ts` | Anthropic (Sonnet) | Per-module chunk analysis (retained for Executive Summary) |
| `MergeFindings` | `server/apis/modules/merge-findings.ts` | Anthropic (Sonnet*) | Tree-reduce merge: deduplicates, prioritizes → executive header + findings JSON |
| `FormatReport` | `server/apis/modules/format-report.ts` | Anthropic (Sonnet*) | Formats structured findings into detailed markdown report |
| `WebResearch` | `server/apis/modules/web-research.ts` | Anthropic (Sonnet) | Iterative web research using `web_search_20250305` tool |

\* *Intended to use Opus for higher-quality synthesis, blocked by platform 120s query timeout.*

### 4.2 Module Persistence APIs

| API | File | Integration | Purpose |
|-----|------|-------------|--------|
| `SaveModuleResult` | `server/apis/modules/save-module-result.ts` | PostgreSQL | Inserts `module_runs` + `module_outputs` records |
| `LoadModuleResults` | `server/apis/modules/load-module-results.ts` | PostgreSQL | Loads latest run + output per module for a deal |
| `GetRunHistory` | `server/apis/modules/get-run-history.ts` | PostgreSQL | Fetches full run history with finding/critical counts |

### 4.3 Deal CRUD APIs

| API | File | Integration | Purpose |
|-----|------|-------------|--------|
| `ListDeals` | `server/apis/deals/list-deals.ts` | PostgreSQL | Lists all deals with document counts and finding summaries; supports search |
| `GetDeal` | `server/apis/deals/get-deal.ts` | PostgreSQL | Fetches single deal with computed counts |
| `CreateDeal` | `server/apis/deals/create-deal.ts` | PostgreSQL | Creates new deal with metadata |
| `UpdateDeal` | `server/apis/deals/update-deal.ts` | PostgreSQL | Updates deal fields (COALESCE-based partial update) |
| `DeleteDeal` | `server/apis/deals/delete-deal.ts` | PostgreSQL | Deletes deal with cascade to all related data |

### 4.4 Document APIs

| API | File | Integration | Purpose |
|-----|------|-------------|--------|
| `ListDocuments` | `server/apis/documents/list-documents.ts` | PostgreSQL | Lists documents for a deal (metadata only, no parsed_text) |
| `SaveDocument` | `server/apis/documents/save-document.ts` | PostgreSQL | Saves document metadata + parsed text after upload |
| `UpdateDocument` | `server/apis/documents/update-document.ts` | PostgreSQL | Updates document tag and source |
| `DeleteDocument` | `server/apis/documents/delete-document.ts` | PostgreSQL | Deletes a document |
| `GetDocumentTexts` | `server/apis/documents/get-document-texts.ts` | PostgreSQL | Fetches parsed_text for all documents in a deal (used for DB-backed analysis) |

### 4.5 Q&A / RAG APIs

| API | File | Integration | Purpose |
|-----|------|-------------|--------|
| `IndexDocumentChunks` | `server/apis/qa/index-document-chunks.ts` | PostgreSQL | Inserts text chunks into `document_chunks` table with tsvector for full-text search |
| `SearchChunks` | `server/apis/qa/search-chunks.ts` | PostgreSQL | Full-text search over `document_chunks` using `websearch_to_tsquery` |
| `AskDataRoom` | `server/apis/qa/ask-data-room.ts` | Anthropic + PostgreSQL | RAG Q&A: reranks candidate chunks, builds context, generates answer with source citations |

### 4.6 Infrastructure APIs

| API | File | Integration | Purpose |
|-----|------|-------------|--------|
| `SetupSchema` | `server/apis/db/setup-schema.ts` | PostgreSQL | Creates all tables/indexes/enums if they don't exist |

---

## 5. Data Model

### Database Tables (PostgreSQL)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `deals` | Deal metadata | `id`, `name`, `sector`, `status`, `entry_ev`, `entry_multiple`, `equity_check`, `ic_date` |
| `documents` | Uploaded document metadata + parsed text | `id`, `deal_id`, `file_name`, `file_type`, `document_tag`, `document_source`, `parsed_text` |
| `module_runs` | Analysis execution records | `id`, `deal_id`, `module_id`, `status` (enum), `triggered_at`, `completed_at`, `documents_included` |
| `module_outputs` | Analysis results | `id`, `module_run_id`, `executive_header`, `findings` (JSONB), `full_report_markdown` |
| `sub_agent_extractions` | Individual chunk extractions | `id`, `module_run_id`, `document_id`, `chunk_index`, `extraction_json` (JSONB) |
| `document_chunks` | Q&A search index | `id`, `document_id`, `deal_id`, `chunk_index`, `file_name`, `content`, `tsv` (generated tsvector) |

### Relationships
```
deals 1──* documents
deals 1──* module_runs 1──* module_outputs
                      1──* sub_agent_extractions
deals 1──* document_chunks
documents 1──* document_chunks
```

All child tables cascade on deal deletion.

---

## 6. Integrations

| Integration | Type | ID | Usage |
|-------------|------|-----|-------|
| Anthropic Claude | AI | `8ccd43c8-5340-4ae2-8eee-7cbb3896df53` | All AI analysis, extraction, merging, reporting, web research, Q&A |
| PostgreSQL | Database | `ba09e2b9-2715-4460-8131-896f50b0c414` | All persistence — deals, documents, module runs/outputs, Q&A chunks |

### AI Models

| Model | Current Usage | Intended Usage |
|-------|--------------|----------------|
| `claude-sonnet-4-6` | All steps (extraction, merge, format, research, Q&A) | Sub-agent work (extraction, per-chunk analysis, research iterations) |
| `claude-opus-4-7` | Defined but not active (120s platform timeout) | Synthesis steps (MergeFindings, FormatReport) for higher-quality output |
