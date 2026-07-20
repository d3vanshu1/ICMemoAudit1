/**
 * API Registry - Central export for all APIs.
 *
 * This file is the single source of truth for API definitions.
 * Add new APIs here to get full TypeScript support in the frontend.
 *
 * Usage:
 * 1. Import your API: `import MyApi from './MyApi/api.js';`
 * 2. Add it to the apis object below
 * 3. That's it! Types automatically flow to useApi via client/hooks/useApi.ts
 *
 * IMPORTANT: Use .js extension for imports (required for ESM compatibility)
 */

// AI pipeline
import AnalyzeChunk from './modules/analyze-chunk.js';
import UniversalExtract from './modules/universal-extract.js';
import MergeFindings from './modules/merge-findings.js';
import FormatReport from './modules/format-report.js';
import WebResearch from './modules/web-research.js';
import SaveModuleResult from './modules/save-module-result.js';
import LoadModuleResults from './modules/load-module-results.js';
import GetRunHistory from './modules/get-run-history.js';
import GetRunOutput from './modules/get-run-output.js';

// Server-side pipeline
import RunModulePipeline from './pipeline/run-module-pipeline.js';
import ResumeStalePipelines from './pipeline/resume-stale-pipelines.js';
import DiagnoseParsedText from './pipeline/diagnose-parsed-text.js';
import CleanParsedTextDryRun from './pipeline/clean-parsed-text-api.js';
import CountSheets from './pipeline/count-sheets.js';
import DiagnoseChunks from './pipeline/diagnose-chunks.js';
import ResetDealRun from './pipeline/reset-deal-run.js';
import ResetModuleMerge from './pipeline/reset-module-merge.js';
import DiagnoseRuns from './pipeline/diagnose-runs.js';
import DiagnoseChunkCoverage from './pipeline/diagnose-chunk-coverage.js';
import DiagnoseChunkDetail from './pipeline/diagnose-chunk-detail.js';
import DiagnoseRunEvidence from './pipeline/diagnose-run-evidence.js';
import DiagnoseFindingTrace from './pipeline/diagnose-finding-trace.js';
import DiagnoseExtractionRaw from './pipeline/diagnose-extraction-raw.js';
import RunMigration004 from './pipeline/run-migration.js';
import RunMigration005 from './pipeline/run-migration-005.js';
import RunMigration006 from './pipeline/run-migration-006.js';
import RunMigration007 from './pipeline/run-migration-007.js';

// Database setup
import SetupSchema from './db/setup-schema.js';
import RunCheckpointMigration from './db/run-checkpoint-migration.js';
import CreatePipelineTable from './db/create-pipeline-table.js';
import CheckSchemaHealth from './db/check-schema-health.js';
import AddConcurrentRunIndex from './db/add-concurrent-run-index.js';

// Deals CRUD
import ListDeals from './deals/list-deals.js';
import GetDeal from './deals/get-deal.js';
import CreateDeal from './deals/create-deal.js';
import UpdateDeal from './deals/update-deal.js';
import DeleteDeal from './deals/delete-deal.js';

// Documents
import ListDocuments from './documents/list-documents.js';
import SaveDocument from './documents/save-document.js';
import UpdateDocument from './documents/update-document.js';
import DeleteDocument from './documents/delete-document.js';
import GetDocumentTexts from './documents/get-document-texts.js';
import SaveDocTables from './documents/save-doc-tables.js';
import GetDocTables from './documents/get-doc-tables.js';
import BackfillDocTablesFromText from './documents/backfill-doc-tables-from-text.js';
import GetDocTablesSummary from './documents/get-doc-tables-summary.js';
import UpdateParsedText from './documents/update-parsed-text.js';

// Numeric verification
import NumericVerify from './numeric/numeric-verify.js';
import GetNumericReport from './numeric/get-numeric-report.js';
import SearchNumericFindings from './numeric/search-numeric-findings.js';
import DiagSharedFormulas from './numeric/diag-shared-formulas.js';
import DiagFormulaExtraction from './numeric/diag-formula-extraction.js';

// Q&A
import IndexDocumentChunks from './qa/index-document-chunks.js';
import SearchChunks from './qa/search-chunks.js';
import AskDataRoom from './qa/ask-data-room.js';

// Checkpoints (crash-recovery)
import SaveExtractions from './checkpoints/save-extractions.js';
import LoadExtractions from './checkpoints/load-extractions.js';
import SaveMergeCheckpoint from './checkpoints/save-merge-checkpoint.js';
import LoadMergeCheckpoints from './checkpoints/load-merge-checkpoints.js';
import UpdateRunStatus from './checkpoints/update-run-status.js';
import GetRunProgress from './checkpoints/get-run-progress.js';
import SaveRunCoverage from './checkpoints/save-run-coverage.js';
import LoadRunCoverage from './checkpoints/load-run-coverage.js';
import CancelModuleRun from './checkpoints/cancel-module-run.js';
import CheckRunCancelled from './checkpoints/check-run-cancelled.js';
import PurgeStaleRuns from './checkpoints/purge-stale-runs.js';
import ResurrectModuleRun from './checkpoints/resurrect-module-run.js';
import ReconcileFindings from './checkpoints/reconcile-findings.js';
import GetExtractionStatus from './checkpoints/get-extraction-status.js';
import PurgeExtractions from './checkpoints/purge-extractions.js';
import DiagFailedExtractions from './checkpoints/diag-failed-extractions.js';

// Audit
import ExtractReportSnippets from './audit/extract-report-snippets.js';
import FramingPatternAudit from './audit/framing-pattern-audit.js';

const apis = {
  // AI pipeline
  AnalyzeChunk, UniversalExtract, MergeFindings, FormatReport, WebResearch,
  SaveModuleResult, LoadModuleResults, GetRunHistory, GetRunOutput,
  // Server-side pipeline
  RunModulePipeline, ResumeStalePipelines, DiagnoseParsedText, CleanParsedTextDryRun, CountSheets, DiagnoseChunks, DiagnoseRuns, DiagnoseChunkCoverage, DiagnoseChunkDetail, DiagnoseRunEvidence, DiagnoseFindingTrace, DiagnoseExtractionRaw, ResetDealRun, ResetModuleMerge, RunMigration004, RunMigration005, RunMigration006, RunMigration007,
  // DB setup
  SetupSchema, RunCheckpointMigration, CreatePipelineTable, CheckSchemaHealth, AddConcurrentRunIndex,
  // Deals
  ListDeals, GetDeal, CreateDeal, UpdateDeal, DeleteDeal,
  // Documents
  ListDocuments, SaveDocument, UpdateDocument, DeleteDocument, GetDocumentTexts,
  SaveDocTables, GetDocTables, BackfillDocTablesFromText, GetDocTablesSummary, UpdateParsedText,
  // Numeric verification
  NumericVerify, GetNumericReport, SearchNumericFindings, DiagSharedFormulas, DiagFormulaExtraction,
  // Q&A
  IndexDocumentChunks, SearchChunks, AskDataRoom,
  // Checkpoints
  SaveExtractions, LoadExtractions, SaveMergeCheckpoint, LoadMergeCheckpoints,
  UpdateRunStatus, GetRunProgress, SaveRunCoverage, LoadRunCoverage,
  CancelModuleRun, CheckRunCancelled, PurgeStaleRuns, ResurrectModuleRun, ReconcileFindings, GetExtractionStatus, PurgeExtractions, DiagFailedExtractions,
  // Audit
  ExtractReportSnippets, FramingPatternAudit,
} as const;

export default apis;

/** Type for useApi inference - exported for client type-only imports */
export type ApiRegistry = typeof apis;
