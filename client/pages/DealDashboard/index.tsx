import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useParams, useNavigate } from "react-router";
import { toast } from "sonner";
import { useApi } from "@/hooks/useApi.js";
import { useApiData } from "@/hooks/useApiData.js";
import { executeApi } from "@/lib/executeApi.js";
import { processAllFiles, extractTextFromFile, parseExcelToTables, parseCsvToTable } from "@/lib/pdfProcessor";
import type { DocumentChunk, ProcessedFileInfo, ExcludedFile, StructuredCell } from "@/lib/pdfProcessor";
import { MODULE_DEFINITIONS, MODULE_MAP, NUMERIC_MODULES } from "@/lib/moduleConfig";
import { CHUNK_CHARS, CHUNK_CONCURRENCY, EXTRACTION_MODEL, isSpreadsheetFile } from "@/lib/pipelineConfig";
import { getExtractionsForModule } from "@/lib/chunkRouting";
import type { TaggedExtraction } from "@/lib/chunkRouting";
import type { Document, DocumentTag, DocumentSource } from "@/types/document";
import type { ModuleRun, ModuleStatus } from "@/types/module";
import type { AnalysisProgress } from "@/components/ic/modules/ModuleGrid";

import Sidebar from "@/components/ic/layout/Sidebar";
import DashboardHeader from "@/components/ic/layout/DashboardHeader";
import StatsRow from "@/components/ic/stats/StatsRow";
import AlertBanner from "@/components/ic/alerts/AlertBanner";
import ModuleGrid from "@/components/ic/modules/ModuleGrid";
import RunAllModal from "@/components/ic/modules/RunAllModal";

import RerunSuggestionModal from "@/components/ic/modules/RerunSuggestionModal";
import RunHistory from "@/components/ic/modules/RunHistory";
import QAPanel from "@/components/ic/qa/QAPanel";
import ReparseDocumentsModal from "@/components/ic/documents/ReparseDocumentsModal";

export { DealDashboardPage as Component };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MergeNode = {
  text: string;
  executiveHeader: string;
  findings: Array<{
    severity: "critical" | "warning" | "info";
    title: string;
    detail: string;
    full_analysis: string;
    source_docs: string[];
    claim_ids?: string[];
  }>;
};

// Concurrency imported from @/lib/pipelineConfig

/** Combined chunk-processing result with coverage tracking */
interface CoverageResult {
  chunks: DocumentChunk[];
  totalPages: number;
  filesProcessed: ProcessedFileInfo[];
  filesExcluded: ExcludedFile[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DealDashboardPage() {
  const { dealId } = useParams<{ dealId: string }>();
  const navigate = useNavigate();

  // --- Live data from database ---
  const { data: dealData, loading: dealLoading, isError: dealError } = useApiData(
    "GetDeal",
    { dealId: dealId ?? "" },
    { enabled: !!dealId }
  );
  const deal = (dealData?.deal as import("@/types/deal").Deal | undefined) ?? null;

  const { data: docsData, refetch: refetchDocs } = useApiData(
    "ListDocuments",
    { dealId: dealId ?? "" },
    { enabled: !!dealId }
  );

  const { data: moduleData, refetch: refetchModules } = useApiData(
    "LoadModuleResults",
    { dealId: dealId ?? "" },
    { enabled: !!dealId, staleTime: 30_000, refetchOnWindowFocus: false }
  );

  const [docs, setDocs] = useState<Document[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ModuleStatus>>({});
  const [runningModules, setRunningModules] = useState<Set<string>>(new Set());
  const [showRunAll, setShowRunAll] = useState(false);
  const [historyModule, setHistoryModule] = useState<string | null>(null);
  const [progressMap, setProgressMap] = useState<Record<string, AnalysisProgress>>({});
  const [rerunModal, setRerunModal] = useState<{ fileNames: string[]; suggestedIds: string[] } | null>(null);
  const [useOpus, setUseOpus] = useState(false);
  const [showReparseModal, setShowReparseModal] = useState(false);
  // Subject memo selection — IDs of ic_memo docs chosen as "memo(s) under review"
  const [selectedSubjectIds, setSelectedSubjectIds] = useState<string[]>([]);

  // Sync DB docs into local state — only on initial load
  const docsInitialized = useRef(false);
  useEffect(() => {
    if (docsData?.documents && !docsInitialized.current) {
      docsInitialized.current = true;
      const mappedDocs = docsData.documents.map((d: Record<string, unknown>) => ({
        id: d.id as string,
        deal_id: d.deal_id as string,
        file_name: d.file_name as string,
        file_type: d.file_type as string,
        document_tag: (d.document_tag ?? "other") as DocumentTag,
        document_source: (d.document_source ?? "sellside") as DocumentSource,
        uploaded_at: d.uploaded_at as string,
      }));
      setDocs(mappedDocs);
      // Auto-preselect all IC memo docs on initial load (user can untick)
      const icMemoIds = mappedDocs
        .filter((d) => d.document_tag === "ic_memo")
        .map((d) => d.id);
      if (icMemoIds.length > 0 && selectedSubjectIds.length === 0) {
        setSelectedSubjectIds(icMemoIds);
      }
    }
  }, [docsData]);

  // Sync DB module results into local state
  useEffect(() => {
    if (moduleData?.modules && moduleData.modules.length > 0) {
      const loaded: Record<string, ModuleStatus> = {};
      for (const m of moduleData.modules) {
        loaded[m.moduleId] = {
          moduleId: m.moduleId,
          latestRun: m.latestRun
            ? {
                id: m.latestRun.id,
                deal_id: dealId!,
                module_id: m.moduleId,
                status: m.latestRun.status as ModuleRun["status"],
                isCancelled: m.latestRun.isCancelled ?? false,
                triggered_at: m.latestRun.triggeredAt,
                completed_at: m.latestRun.completedAt,
                documents_included: [],
                findings_count: m.latestOutput?.findings?.length ?? 0,
                critical_count: m.latestOutput?.findings?.filter((f: Record<string, unknown>) => f.severity === "critical").length ?? 0,
              }
            : null,
          latestOutput: m.latestOutput
            ? {
                id: crypto.randomUUID(),
                module_run_id: m.latestRun?.id ?? "",
                executive_header: m.latestOutput.executiveHeader,
                findings: m.latestOutput.findings,
                full_report_markdown: m.latestOutput.fullReport,
                created_at: m.latestOutput.createdAt,
              }
            : null,
        };
      }

      // CRITICAL: Do NOT overwrite modules that are actively being driven by
      // the pipeline polling loop. Their local state (progress, "running" status)
      // is authoritative. Overwriting with DB state causes premature "complete"
      // flicker when LoadModuleResults refetches (e.g., after tab focus or when
      // another module finishes and triggers refetchModules()).
      setStatuses((prev) => {
        const merged = { ...prev };
        for (const [id, status] of Object.entries(loaded)) {
          // CRITICAL: DB 'is_cancelled' flag ALWAYS overrides client state.
          // Cancellation is server-authoritative and must survive reload, other tabs,
          // and the anti-flicker guard. cancelledRunsRef is UX-only.
          if (status.latestRun?.isCancelled) {
            merged[id] = status;
            continue;
          }
          if (runningModules.has(id) && pipelinePollingActive.current.has(id)) {
            // This module is actively being polled by the pipeline loop — skip DB overwrite.
            // Exception: if DB also says "running", allow the update (keeps run ID in sync).
            if (status.latestRun?.status !== "running") continue;
          }
          merged[id] = status;
        }
        return merged;
      });

      // If any module has a "running" status in DB, reflect it in the UI immediately
      // so the card shows progress state even before the resume logic kicks in
      const dbRunningModuleIds = Object.entries(loaded)
        .filter(([, s]) => s.latestRun?.status === "running")
        .map(([id]) => id)
        .filter((id) => !killedModulesRef.current.has(id));
      if (dbRunningModuleIds.length > 0) {
        setRunningModules((prev) => {
          // Only create a new Set if there are actually new IDs to add
          const hasNew = dbRunningModuleIds.some((id) => !prev.has(id));
          if (!hasNew) return prev; // no-op — preserve reference identity
          const next = new Set(prev);
          dbRunningModuleIds.forEach((id) => next.add(id));
          return next;
        });
        // Set a generic progress message until the resume loop provides real data
        setProgressMap((prev) => {
          const updated = { ...prev };
          for (const id of dbRunningModuleIds) {
            if (!updated[id]) {
              updated[id] = { message: "Running (server-side)…", detail: null, chunkErrors: [] };
            }
          }
          return updated;
        });
      }
    }
  // NOTE: runningModules intentionally excluded — reading it inside setStatuses
  // callback. Including it causes infinite loop because setRunningModules below
  // creates a new Set reference on every call → effect re-fires → infinite depth.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleData, dealId]);

  // Cached chunks so we only process PDFs once even when multiple modules run
  const chunksCache = useRef<CoverageResult | null>(null);
  const chunksCacheKey = useRef<string>("");

  // Tracks document IDs for which structured tables have been saved (keyed by cacheKey)
  const docTablesCacheKey = useRef<string>("");
  const docIdsForVerification = useRef<string[]>([]);

  // Coverage manifest — populated after chunk processing, read by all module runs
  const coverageRef = useRef<{
    filesProcessed: ProcessedFileInfo[];
    filesExcluded: ExcludedFile[];
    chunkCount: number;
    pagesProcessed: number;
  } | null>(null);

  // Shared universal extraction cache — extract once, reuse across all modules
  const universalExtractionsCache = useRef<TaggedExtraction[] | null>(null);
  const universalExtractionsCacheKey = useRef<string>("");

  const { run: analyzeChunk } = useApi("AnalyzeChunk");
  const { run: universalExtract } = useApi("UniversalExtract");
  const { run: mergeFindings } = useApi("MergeFindings");
  const { run: formatReport } = useApi("FormatReport");
  const { run: saveModuleResultApi } = useApi("SaveModuleResult");
  const { run: saveDocumentApi } = useApi("SaveDocument");
  const { run: updateDocumentApi } = useApi("UpdateDocument");
  const { run: deleteDocumentApi } = useApi("DeleteDocument");
  const { run: getRunHistoryApi } = useApi("GetRunHistory");
  const { run: indexDocumentChunks } = useApi("IndexDocumentChunks");
  const { run: getDocumentTexts } = useApi("GetDocumentTexts");

  // Checkpoint APIs (crash-recovery)
  const { run: saveExtractionsApi } = useApi("SaveExtractions");
  const { run: loadExtractionsApi } = useApi("LoadExtractions");
  const { run: saveMergeCheckpointApi } = useApi("SaveMergeCheckpoint");
  const { run: loadMergeCheckpointsApi } = useApi("LoadMergeCheckpoints");
  const { run: updateRunStatusApi } = useApi("UpdateRunStatus");
  const { run: getRunProgressApi } = useApi("GetRunProgress");
  const { run: saveRunCoverageApi } = useApi("SaveRunCoverage");
  const { run: loadRunCoverageApi } = useApi("LoadRunCoverage");
  const { run: saveDocTablesApi } = useApi("SaveDocTables");
  const { run: numericVerifyApi } = useApi("NumericVerify");
  const { run: cancelModuleRunApi } = useApi("CancelModuleRun");
  const { run: checkRunCancelledApi } = useApi("CheckRunCancelled");
  const { run: purgeStaleRunsApi } = useApi("PurgeStaleRuns");
  const { run: backfillDocTablesApi } = useApi("BackfillDocTablesFromText");
  const { run: getDocTablesSummaryApi } = useApi("GetDocTablesSummary");
  const { run: runModulePipelineApi } = useApi("RunModulePipeline");

  // Cancellation tracking — stores run IDs that have been cancelled
  const cancelledRunsRef = useRef<Set<string>>(new Set());
  // Maps moduleId → active runId so we know what to cancel
  const activeRunIdRef = useRef<Record<string, string>>({});
  // Modules permanently killed this session — never auto-resume
  const killedModulesRef = useRef<Set<string>>(new Set());
  // Track consecutive resume failures per module — kill after threshold
  const resumeFailureCountRef = useRef<Record<string, number>>({});
  // Last-known checkpoint count per module — used to detect server progress
  // despite client-side fetch timeouts. If checkpoints advance between resume
  // attempts, the server is working and we should NOT count the timeout as a failure.
  const lastKnownCheckpointsRef = useRef<Record<string, number>>({});
  // Consecutive progress poll failures (persists across effect re-runs)
  const pollFailureCountRef = useRef(0);

  const completedModules = useMemo(
    () =>
      Object.entries(statuses)
        .filter(([, s]) => s.latestRun?.status === "completed")
        .map(([id]) => id),
    [statuses]
  );

  const stats = useMemo(() => {
    const totalFindings = Object.values(statuses).reduce(
      (sum, s) => sum + (s.latestOutput?.findings.length ?? 0),
      0
    );
    const criticalFindings = Object.values(statuses).reduce(
      (sum, s) =>
        sum +
        (s.latestOutput?.findings.filter((f) => f.severity === "critical").length ?? 0),
      0
    );
    return {
      documents: docs.length,
      modulesComplete: completedModules.length,
      totalModules: MODULE_DEFINITIONS.length,
      totalFindings,
      criticalFindings,
    };
  }, [docs, statuses, completedModules]);

  // --- Run gate: both subject and evidence pools must be non-empty ---
  const evidenceDocs = useMemo(
    () => docs.filter((d) => !selectedSubjectIds.includes(d.id)),
    [docs, selectedSubjectIds]
  );
  const canRunAnalysis = selectedSubjectIds.length > 0 && evidenceDocs.length > 0;
  const runDisabledReason = !canRunAnalysis
    ? "Select the memo under review and upload at least one reference document to run modules."
    : undefined;

  // ---------------------------------------------------------------------------
  // Progress helpers — scoped per module
  // ---------------------------------------------------------------------------

  const setModuleProgress = useCallback(
    (moduleId: string, update: Partial<AnalysisProgress>) => {
      setProgressMap((prev) => ({
        ...prev,
        [moduleId]: {
          message: prev[moduleId]?.message ?? null,
          detail: prev[moduleId]?.detail ?? null,
          chunkErrors: prev[moduleId]?.chunkErrors ?? [],
          ...update,
        },
      }));
    },
    []
  );

  const clearModuleProgress = useCallback((moduleId: string) => {
    setProgressMap((prev) => {
      const next = { ...prev };
      delete next[moduleId];
      return next;
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Chunk processing — shared across modules
  // ---------------------------------------------------------------------------

  /**
   * Build text-only chunks from database-stored parsed_text.
   * Accepts an optional set of file names to skip (already covered by fresh uploads).
   */
  const buildChunksFromDbText = useCallback(
    async (moduleId: string, skipFileNames?: Set<string>): Promise<CoverageResult> => {
      if (!dealId) return { chunks: [], totalPages: 0, filesProcessed: [], filesExcluded: [] };

      setModuleProgress(moduleId, {
        message: "Loading stored documents from database…",
      });

      const result = await getDocumentTexts({ dealId });
      const dbDocs = result?.documents;
      const loadWarnings = (result as any)?.warnings as string[] | undefined;
      if (loadWarnings && loadWarnings.length > 0) {
        console.warn("[doc-load]", loadWarnings.join("; "));
      }

      if (!dbDocs || dbDocs.length === 0) {
        return { chunks: [], totalPages: 0, filesProcessed: [], filesExcluded: [] };
      }

      // CHUNK_CHARS imported from @/lib/pipelineConfig
      const chunks: DocumentChunk[] = [];
      const dbFilesProcessed: ProcessedFileInfo[] = [];
      const dbFilesExcluded: ExcludedFile[] = [];

      for (const doc of dbDocs) {
        // Skip if a fresh upload with the same name already exists
        if (skipFileNames && skipFileNames.has(doc.file_name)) {
          dbFilesExcluded.push({ fileName: doc.file_name, reason: "superseded", detail: "Replaced by a fresh upload" });
          continue;
        }

        // Skip spreadsheet files — their data goes through doc_tables/NumericVerify, not LLM extraction
        if (isSpreadsheetFile(doc.file_name)) {
          dbFilesExcluded.push({ fileName: doc.file_name, reason: "spreadsheet", detail: "Routed to doc_tables/NumericVerify (no LLM extraction needed)" });
          continue;
        }

        const text = doc.parsed_text;
        if (!text || text.trim().length === 0) {
          // Use skip_reason from API if available, otherwise default to parse_failure
          const reason = (doc as any).skip_reason === "too_large" ? "too_large" as const
            : (doc as any).skip_reason === "load_error" ? "parse_failure" as const
            : "parse_failure" as const;
          const detail = reason === "too_large"
            ? "Document exceeds 50MB size limit"
            : "Empty or missing parsed text";
          dbFilesExcluded.push({ fileName: doc.file_name, reason, detail });
          continue;
        }

        if (text.length <= CHUNK_CHARS) {
          chunks.push({
            label: doc.file_name,
            sourceFile: doc.file_name,
            text,
            pageImages: [],
          });
        } else {
          // Split into multiple chunks
          let start = 0;
          let chunkIdx = 1;
          while (start < text.length) {
            const end = Math.min(start + CHUNK_CHARS, text.length);
            chunks.push({
              label: `${doc.file_name} (part ${chunkIdx})`,
              sourceFile: doc.file_name,
              text: text.slice(start, end),
              pageImages: [],
            });
            start = end;
            chunkIdx++;
          }
        }

        const chunkCountForDoc = text.length <= CHUNK_CHARS ? 1 : Math.ceil(text.length / CHUNK_CHARS);
        dbFilesProcessed.push({ fileName: doc.file_name, chunkCount: chunkCountForDoc, pageCount: chunkCountForDoc });
      }

      return { chunks, totalPages: chunks.length, filesProcessed: dbFilesProcessed, filesExcluded: dbFilesExcluded };
    },
    [dealId, getDocumentTexts, setModuleProgress]
  );

  const getOrProcessChunks = useCallback(
    async (moduleId: string) => {
      // Build a combined cache key from both sources
      const uploadKey = uploadedFiles.map((f) => f.name + f.size).join("|");
      const dbKey = docs.map((d) => d.id).sort().join(",");
      const cacheKey = `${uploadKey}||${dbKey}`;

      if (chunksCache.current && chunksCacheKey.current === cacheKey) {
        return chunksCache.current;
      }

      let uploadedChunks: DocumentChunk[] = [];
      let uploadFilesProcessed: ProcessedFileInfo[] = [];
      let uploadFilesExcluded: ExcludedFile[] = [];

      // Process fresh File objects with the full PDF rendering pipeline
      if (uploadedFiles.length > 0) {
        setModuleProgress(moduleId, {
          message: "Processing uploaded documents — rendering pages...",
        });

        const result = await processAllFiles(uploadedFiles, (info) => {
          if (info.phase === "rendering" && info.currentPage % 5 === 0) {
            setModuleProgress(moduleId, {
              message: `Rendering ${info.file}: page ${info.currentPage}/${info.totalPages}`,
            });
          }
        });

        uploadedChunks = result.chunks;
        uploadFilesProcessed = result.filesProcessed;
        uploadFilesExcluded = result.filesExcluded;
      }

      // Build a set of file names covered by fresh uploads
      const uploadedFileNames = new Set(uploadedFiles.map((f) => f.name));

      // Fetch DB documents, skipping any that share a name with a fresh upload
      const dbResult = await buildChunksFromDbText(moduleId, uploadedFileNames);

      // Combine both sources — no cap; process everything
      const allChunks = [...uploadedChunks, ...dbResult.chunks];
      const allFilesProcessed = [...uploadFilesProcessed, ...dbResult.filesProcessed];
      const allFilesExcluded = [...uploadFilesExcluded, ...dbResult.filesExcluded];

      if (allFilesExcluded.length > 0) {
        const reasons = allFilesExcluded.filter(f => f.reason !== "superseded");
        if (reasons.length > 0) {
          toast.warning(
            `${reasons.length} file(s) excluded from analysis. Check the coverage manifest for details.`
          );
        }
      }

      const totalPages = allFilesProcessed.reduce((sum, f) => sum + f.pageCount, 0);
      const combined: CoverageResult = { chunks: allChunks, totalPages, filesProcessed: allFilesProcessed, filesExcluded: allFilesExcluded };
      chunksCache.current = combined;
      chunksCacheKey.current = cacheKey;

      // Persist coverage manifest ref for downstream module runs
      coverageRef.current = {
        filesProcessed: allFilesProcessed,
        filesExcluded: allFilesExcluded,
        chunkCount: allChunks.length,
        pagesProcessed: totalPages,
      };

      // Extract and save structured tables from Excel/CSV files (async, non-blocking)
      if (cacheKey !== docTablesCacheKey.current) {
        docTablesCacheKey.current = cacheKey;
        const docIdByName: Record<string, string> = {};
        for (const doc of docs) docIdByName[doc.file_name] = doc.id;

        const tablesPayload: Array<{ documentId: string; sheetOrPage: string; caption: string | null; data: { row_headers: string[]; col_headers: string[]; cells: StructuredCell[] } }> = [];
        const docsWithTables: string[] = [];

        for (const file of uploadedFiles) {
          const docId = docIdByName[file.name];
          if (!docId) continue; // not yet in DB — skip
          const lower = file.name.toLowerCase();
          if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".xlsm")) {
            try {
              const buf = await file.arrayBuffer();
              const tables = parseExcelToTables(buf, file.name);
              for (const t of tables) {
                tablesPayload.push({
                  documentId: docId,
                  sheetOrPage: t.sheetOrPage,
                  caption: t.caption,
                  data: { row_headers: t.rowHeaders, col_headers: t.colHeaders, cells: t.cells },
                });
              }
              if (tables.length > 0 && !docsWithTables.includes(docId)) docsWithTables.push(docId);
            } catch (err) {
              console.warn(`[doc_tables] Failed to parse ${file.name}:`, err);
            }
          } else if (lower.endsWith(".csv")) {
            try {
              const buf = await file.arrayBuffer();
              const csvText = new TextDecoder("utf-8").decode(buf);
              const t = parseCsvToTable(csvText, file.name);
              if (t) {
                tablesPayload.push({
                  documentId: docId,
                  sheetOrPage: t.sheetOrPage,
                  caption: t.caption,
                  data: { row_headers: t.rowHeaders, col_headers: t.colHeaders, cells: t.cells },
                });
                if (!docsWithTables.includes(docId)) docsWithTables.push(docId);
              }
            } catch (err) {
              console.warn(`[doc_tables] Failed to parse ${file.name}:`, err);
            }
          }
        }

        if (tablesPayload.length > 0) {
          docIdsForVerification.current = docsWithTables;
          // Await the save so doc_tables are persisted BEFORE NumericVerify runs.
          // Previously this was fire-and-forget, causing a race where NumericVerify
          // could query doc_tables before the INSERT completed — or worse, the save
          // could fail silently and NumericVerify would find nothing.
          try {
            await saveDocTablesApi({ tables: tablesPayload });
          } catch (err) {
            console.error("[doc_tables] Failed to save structured tables:", err);
            // Clear the doc IDs so NumericVerify doesn't run against empty tables
            docIdsForVerification.current = [];
          }
        } else {
          // No fresh uploads — check if stored spreadsheet docs have doc_tables,
          // and backfill if missing. Never assume doc_tables is pre-populated.
          const storedSpreadsheetDocs = docs.filter((d) =>
            /\.(xlsx|xls|xlsm|csv)$/i.test(d.file_name)
          );
          if (storedSpreadsheetDocs.length > 0 && dealId) {
            try {
              setModuleProgress(moduleId, { message: "Checking structured table data…" });
              const summary = await getDocTablesSummaryApi({ dealId });
              if (summary && summary.totalRows > 0) {
                // doc_tables already populated — use those document IDs
                const docIdsWithTables = [...new Set(summary.sheets.map((s) => s.documentId))];
                docIdsForVerification.current = docIdsWithTables;
              } else {
                // No doc_tables — run backfill
                setModuleProgress(moduleId, { message: "Backfilling structured tables from stored spreadsheets…" });
                const backfillResult = await backfillDocTablesApi({ dealId });
                if (backfillResult && backfillResult.totalTables > 0) {
                  docIdsForVerification.current = backfillResult.perDocument.map((d) => d.documentId);
                  toast.info(`Backfilled ${backfillResult.totalTables} table(s) from ${backfillResult.perDocument.length} spreadsheet(s).`);
                } else {
                  console.warn("[doc_tables] Backfill returned no tables — spreadsheets may lack parseable content.");
                  docIdsForVerification.current = [];
                }
              }
            } catch (err) {
              console.error("[doc_tables] Check/backfill failed:", err);
              docIdsForVerification.current = storedSpreadsheetDocs.map((d) => d.id);
            }
          }
        }
      }

      return combined;
    },
    [uploadedFiles, docs, dealId, setModuleProgress, buildChunksFromDbText, saveDocTablesApi, getDocTablesSummaryApi, backfillDocTablesApi]
  );

  // ---------------------------------------------------------------------------
  // Universal extraction — extract all chunks once, reuse across modules
  // ---------------------------------------------------------------------------

  /**
   * Build a map from sourceFile (filename) → documentTag using the
   * docs state. Chunks carry sourceFile which matches doc.file_name.
   */
  const getDocTagMap = useCallback((): Record<string, DocumentTag> => {
    const tagMap: Record<string, DocumentTag> = {};
    for (const doc of docs) {
      tagMap[doc.file_name] = doc.document_tag;
    }
    return tagMap;
  }, [docs]);

  /**
   * Simple hash for chunk content — used to detect when a chunk has changed
   * so cached extractions can be invalidated. Uses djb2 algorithm (fast, no crypto needed).
   */
  function computeContentHash(text: string): string {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }

  /**
   * Run universal extraction on all chunks in parallel.
   * Results are cached in memory AND persisted to the universal_extractions
   * table. On subsequent runs with unchanged content, extractions are loaded
   * from the DB — zero new LLM calls.
   */
  const getOrRunUniversalExtractions = useCallback(
    async (progressLabel: string): Promise<TaggedExtraction[]> => {
      // Build combined cache key from both fresh uploads and DB docs
      const uploadKey = uploadedFiles.map((f) => f.name + f.size).join("|");
      const dbKey = docs.map((d) => d.id).sort().join(",");
      const cacheKey = `${uploadKey}||${dbKey}`;

      // Return in-memory cached extractions if files haven't changed
      if (
        universalExtractionsCache.current &&
        universalExtractionsCacheKey.current === cacheKey
      ) {
        return universalExtractionsCache.current;
      }

      // Step 1: Get or process raw chunks (PDF rendering etc.)
      const { chunks } = await getOrProcessChunks(progressLabel);
      if (chunks.length === 0) return [];

      // Step 2: Load cached extractions from DB
      const tagMap = getDocTagMap();
      // Build a lookup: documentId by filename
      const docIdByName: Record<string, string> = {};
      for (const doc of docs) {
        docIdByName[doc.file_name] = doc.id;
      }

      let cachedByKey: Record<string, { contentHash: string; extraction: TaggedExtraction }> = {};
      if (dealId) {
        try {
          setModuleProgress(progressLabel, {
            message: "Checking for cached extractions…",
          });
          const cached = await loadExtractionsApi({ dealId });
          for (const row of (cached?.extractions ?? [])) {
            const key = `${row.documentId}:${row.chunkIndex}`;
            cachedByKey[key] = {
              contentHash: row.contentHash,
              extraction: {
                label: row.extraction.label,
                extraction: row.extraction.extraction,
                chunkIndex: row.extraction.chunkIndex,
                sourceFile: row.extraction.sourceFile,
                documentTag: row.extraction.documentTag as DocumentTag,
                ...(row.extraction.failed ? { failed: true } : {}),
              },
            };
          }
        } catch {
          // Ignore load errors — just re-extract everything
          cachedByKey = {};
        }
      }

      // Step 3: Determine which chunks need extraction vs. can be served from cache
      const extractions: TaggedExtraction[] = new Array(chunks.length);
      const chunksToExtract: Array<{ index: number; chunk: DocumentChunk; docId: string; hash: string }> = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const docId = docIdByName[chunk.sourceFile] ?? "";
        const hash = computeContentHash(chunk.text);
        const cacheHit = cachedByKey[`${docId}:${i}`];

        if (cacheHit && cacheHit.contentHash === hash && !cacheHit.extraction.failed) {
          // Cache hit — use stored extraction, apply current tag (skip failed entries)
          const tag = tagMap[chunk.sourceFile] ?? "other";
          extractions[i] = { ...cacheHit.extraction, documentTag: tag };
        } else {
          chunksToExtract.push({ index: i, chunk, docId, hash });
        }
      }

      const cachedCount = chunks.length - chunksToExtract.length;
      if (cachedCount > 0) {
        toast.info(`${cachedCount} chunk(s) loaded from cache — ${chunksToExtract.length} need extraction.`);
      }

      if (chunksToExtract.length === 0) {
        const validExtractions = extractions.filter(Boolean);
        universalExtractionsCache.current = validExtractions;
        universalExtractionsCacheKey.current = cacheKey;
        return validExtractions;
      }

      // Step 4: Run extraction only on chunks that need it
      const errors: string[] = [];
      let completed = 0;
      const totalToExtract = chunksToExtract.length;

      setModuleProgress(progressLabel, {
        message: `Extracting 0/${totalToExtract} chunks (${cachedCount} cached)…`,
        detail: { current: 0, total: totalToExtract, phase: "analyzing" },
      });

      // Accumulate newly extracted results for bulk save
      const newExtractions: Array<{
        documentId: string;
        chunkIndex: number;
        contentHash: string;
        extraction: TaggedExtraction;
      }> = [];

      for (let batchStart = 0; batchStart < chunksToExtract.length; batchStart += CHUNK_CONCURRENCY) {
        const batchEnd = Math.min(batchStart + CHUNK_CONCURRENCY, chunksToExtract.length);
        const batch = chunksToExtract.slice(batchStart, batchEnd);

        const batchPromises = batch.map(async ({ index: i, chunk, docId, hash }) => {
          try {
            // Fix #1: Retry extraction with exponential backoff (same as callAnthropic / withRetry)
            const result = await withRetry(
              () => universalExtract({
                chunkIndex: i,
                totalChunks: chunks.length,
                chunk,
                model: EXTRACTION_MODEL,
              }),
              `extract-chunk-${i}`
            );
            const tag = tagMap[chunk.sourceFile] ?? "other";
            const tagged: TaggedExtraction = {
              label: result?.label ?? chunk.label,
              extraction: result?.extraction ?? "",
              chunkIndex: result?.chunkIndex ?? i,
              sourceFile: result?.sourceFile ?? chunk.sourceFile,
              documentTag: tag,
            };
            extractions[i] = tagged;

            // Queue for DB persistence
            if (docId) {
              newExtractions.push({ documentId: docId, chunkIndex: i, contentHash: hash, extraction: tagged });
            }
          } catch (err) {
            // Fix #2: Mark failed extractions — do NOT bake error text into extraction content
            // and do NOT cache them as valid (failed: true excluded from cache-hit check)
            const msg =
              err && typeof err === "object" && "message" in err
                ? String((err as { message: unknown }).message)
                : String(err);
            errors.push(`Chunk "${chunk.label}": ${msg}`);
            const tag = tagMap[chunk.sourceFile] ?? "other";
            extractions[i] = {
              label: chunk.label,
              extraction: "",
              chunkIndex: i,
              sourceFile: chunk.sourceFile,
              documentTag: tag,
              failed: true,
            };
          } finally {
            completed++;
            setModuleProgress(progressLabel, {
              message: `Extracting ${completed}/${totalToExtract} chunks (${cachedCount} cached)…`,
              detail: { current: completed, total: totalToExtract, phase: "analyzing" },
            });
          }
        });

        await Promise.all(batchPromises);

        // Check for cancellation after each batch
        if (cancelledRunsRef.current.size > 0) {
          // If any active run for the current progressLabel (moduleId) was cancelled, abort
          const activeRunId = activeRunIdRef.current[progressLabel];
          if (activeRunId && cancelledRunsRef.current.has(activeRunId)) {
            toast.info("Run cancelled — stopping extraction.");
            break;
          }
        }

        // Fix #3: Await the extraction checkpoint save and surface failures via toast
        if (dealId && newExtractions.length > 0) {
          const batchToSave = newExtractions.splice(0, newExtractions.length);
          try {
            await saveExtractionsApi({
              dealId,
              extractions: batchToSave.map((e) => ({
                documentId: e.documentId,
                chunkIndex: e.chunkIndex,
                contentHash: e.contentHash,
                extraction: {
                  label: e.extraction.label,
                  extraction: e.extraction.extraction,
                  chunkIndex: e.extraction.chunkIndex,
                  sourceFile: e.extraction.sourceFile,
                  documentTag: e.extraction.documentTag,
                  ...(e.extraction.failed ? { failed: true } : {}),
                },
              })),
            });
          } catch (err: unknown) {
            const errMsg = err && typeof err === "object" && "message" in err
              ? String((err as { message: unknown }).message)
              : String(err);
            console.error("Failed to save extraction checkpoint:", err);
            toast.error(`Extraction checkpoint save failed: ${errMsg}`);
          }
        }
      }

      if (errors.length > 0) {
        toast.warning(
          `${errors.length} chunk(s) had extraction errors — partial results will be used.`
        );
      }

      // Cache the results in memory
      const validExtractions = extractions.filter(Boolean);
      universalExtractionsCache.current = validExtractions;
      universalExtractionsCacheKey.current = cacheKey;
      return validExtractions;
    },
    [uploadedFiles, docs, dealId, getOrProcessChunks, getDocTagMap, universalExtract, setModuleProgress, loadExtractionsApi, saveExtractionsApi]
  );

  // ---------------------------------------------------------------------------
  // Tree-reduce merge (shared across all modules)
  // ---------------------------------------------------------------------------

  const MERGE_CONCURRENCY = 10;
  const MERGE_GROUP_SIZE = 4;
  const MAX_RETRIES = 3;

  /** Retry helper — retries on 503/rate-limit/connection errors with exponential backoff */
  async function withRetry<T>(
    fn: () => Promise<T>,
    label: string,
    retries = MAX_RETRIES
  ): Promise<T> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const msg =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
        const isRetryable = /503|429|rate.?limit|service.?unavailable|connection.?termination|overloaded/i.test(msg);
        if (!isRetryable || attempt === retries) {
          throw err;
        }
        const delay = Math.min(2000 * Math.pow(2, attempt - 1), 15000); // 2s, 4s, 8s... max 15s
        console.warn(`[${label}] Attempt ${attempt}/${retries} failed (${msg}), retrying in ${delay}ms…`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error("Unreachable");
  }

  const treeMerge = useCallback(
    async (
      moduleId: string,
      extractions: Array<{ label: string; extraction: string; chunkIndex: number }>,
      moduleRunId?: string,
      numericReport?: { figures: unknown[]; discrepancies: unknown[] } | null,
      numericPartial?: boolean
    ) => {
      let nodes: MergeNode[] = extractions.map((e) => ({
        text: e.extraction,
        executiveHeader: "",
        findings: [],
      }));

      if (nodes.length === 1) {
        nodes.push({ ...nodes[0] });
      }

      // Load existing merge checkpoints so we can skip completed nodes
      let existingCheckpoints: Record<string, MergeNode> = {};
      if (moduleRunId) {
        try {
          const loaded = await loadMergeCheckpointsApi({ moduleRunId });
          const checkpoints = loaded?.checkpoints ?? [];
          for (const cp of checkpoints) {
            // Skip error checkpoints — they need to be re-run
            if (cp.mergedNode.error) continue;
            const key = `${cp.treeLevel}:${cp.nodeIndex}`;
            existingCheckpoints[key] = {
              text: cp.mergedNode.text ?? "",
              executiveHeader: cp.mergedNode.executiveHeader ?? "",
              findings: cp.mergedNode.findings ?? [],
            };
          }
          if (checkpoints.length > 0) {
            toast.info(`Resuming merge — ${checkpoints.length} node(s) already completed.`);
          }
        } catch {
          existingCheckpoints = {};
        }
      }

      const totalMergeRounds = Math.ceil(Math.log(Math.max(nodes.length, 2)) / Math.log(MERGE_GROUP_SIZE));
      let currentRound = 0;

      while (nodes.length > 1) {
        currentRound++;
        const groups: Array<{ idx: number; members: MergeNode[] }> = [];
        for (let g = 0; g < Math.ceil(nodes.length / MERGE_GROUP_SIZE); g++) {
          const members = nodes.slice(g * MERGE_GROUP_SIZE, (g + 1) * MERGE_GROUP_SIZE);
          groups.push({ idx: g, members });
        }

        // Separate singletons (groups with 1 member) from real groups needing merge
        const singletons = groups.filter((g) => g.members.length === 1);
        const realGroups = groups.filter((g) => g.members.length > 1);
        const nextNodes: MergeNode[] = new Array(groups.length);

        // Pass through singletons immediately
        for (const s of singletons) {
          nextNodes[s.idx] = s.members[0];
        }

        setModuleProgress(moduleId, {
          message: `Merging findings (round ${currentRound}/${totalMergeRounds}, ${realGroups.length} groups in parallel)…`,
          detail: {
            current: currentRound,
            total: totalMergeRounds + 1,
            phase: "synthesizing",
          },
        });

        // Process real groups in parallel with bounded concurrency
        let completed = 0;
        for (let bStart = 0; bStart < realGroups.length; bStart += MERGE_CONCURRENCY) {
          const batch = realGroups.slice(bStart, bStart + MERGE_CONCURRENCY);

          const batchPromises = batch.map(async (group) => {
            // Check if this node is already checkpointed
            const cpKey = `${currentRound}:${group.idx}`;
            if (existingCheckpoints[cpKey]) {
              nextNodes[group.idx] = existingCheckpoints[cpKey];
              completed++;
              return;
            }

            try {
              // Pass numericReport on EVERY merge round for numeric modules,
              // so early rounds can cross-reference against verified figures too.
              // The report is small (capped at 30 figures) — negligible token impact.
              const mergeNumericReport = (NUMERIC_MODULES.has(moduleId) && numericReport) ? numericReport : undefined;

              const merged = await withRetry(
                () => mergeFindings({
                  moduleId,
                  batches: group.members.map((m) => m.text),
                  roundLabel: `Round ${currentRound}, group ${group.idx + 1}/${groups.length}`,
                  useOpus,
                  isFinalRound: currentRound === totalMergeRounds,
                  ...(mergeNumericReport ? { numericReport: mergeNumericReport, numericPartial: numericPartial || undefined } : {}),
                }),
                `Merge R${currentRound} G${group.idx + 1}`
              );

              const node: MergeNode = {
                text: merged?.mergedText ?? "",
                executiveHeader: merged?.executiveHeader ?? "",
                findings: merged?.findings ?? [],
              };
              nextNodes[group.idx] = node;

              // Persist checkpoint
              if (moduleRunId) {
                saveMergeCheckpointApi({
                  moduleRunId,
                  treeLevel: currentRound,
                  nodeIndex: group.idx,
                  mergedNode: node,
                }).catch((err: unknown) =>
                  console.error("Failed to save merge checkpoint:", err)
                );
              }
            } catch (err) {
              const msg =
                err && typeof err === "object" && "message" in err
                  ? String((err as { message: unknown }).message)
                  : String(err);
              toast.error(`[${MODULE_MAP[moduleId]?.displayName}] Merge failed: ${msg}`);
              // Fallback: concatenate all members in the group
              nextNodes[group.idx] = {
                text: group.members.map((m) => m.text).join("\n\n---\n\n"),
                executiveHeader: group.members.find((m) => m.executiveHeader)?.executiveHeader ?? "",
                findings: group.members.flatMap((m) => m.findings),
              };
            } finally {
              completed++;
              setModuleProgress(moduleId, {
                message: `Merging findings (round ${currentRound}/${totalMergeRounds}, ${completed}/${realGroups.length} done)…`,
                detail: {
                  current: currentRound,
                  total: totalMergeRounds + 1,
                  phase: "synthesizing",
                },
              });
            }
          });

          await Promise.all(batchPromises);
        }

        nodes = nextNodes.filter(Boolean);
      }

      return nodes[0];
    },
    [mergeFindings, setModuleProgress, useOpus, loadMergeCheckpointsApi, saveMergeCheckpointApi]
  );

  // ---------------------------------------------------------------------------
  // Coverage line builder
  // ---------------------------------------------------------------------------

  function buildCoverageLine(): string {
    const cov = coverageRef.current;
    if (!cov) return "";
    const incCount = cov.filesProcessed.length;
    const excCount = cov.filesExcluded.length;
    const totalDocs = incCount + excCount;
    let line = `Analyzed ${incCount} of ${totalDocs} documents (${cov.pagesProcessed} pages, ${cov.chunkCount} chunks).`;
    if (excCount > 0) {
      const excSummary = cov.filesExcluded
        .map((f) => `${f.fileName} (${f.reason}${f.detail ? ": " + f.detail : ""})`)
        .join("; ");
      line += ` Excluded: ${excSummary}.`;
    }
    return line;
  }

  // ---------------------------------------------------------------------------
  // Format report (shared across all modules)
  // ---------------------------------------------------------------------------

  const generateReport = useCallback(
    async (
      moduleId: string,
      finalMerge: MergeNode,
      totalSteps: number,
      coverageLine?: string,
      numericReport?: { figures: unknown[]; discrepancies: unknown[] } | null
    ) => {
      setModuleProgress(moduleId, {
        message: "Formatting final report…",
        detail: { current: totalSteps, total: totalSteps, phase: "synthesizing" },
      });

      const report = await withRetry(
        () => formatReport({
          moduleId,
          executiveHeader: finalMerge.executiveHeader,
          findings: finalMerge.findings,
          useOpus,
          coverageLine: coverageLine ?? null,
          ...(numericReport ? { numericReport } : {}),
        }),
        `FormatReport ${moduleId}`
      );

      return report?.fullReport ?? "";
    },
    [formatReport, setModuleProgress, useOpus]
  );

  // ---------------------------------------------------------------------------
  // Save module result
  // ---------------------------------------------------------------------------

  const saveModuleResult = useCallback(
    async (
      moduleId: string,
      result: {
        executiveHeader: string;
        findings: MergeNode["findings"];
        fullReport: string;
      },
      /** When provided, attaches output to this existing run (server-pipeline path). */
      existingRunId?: string
    ) => {
      // Update local state immediately for instant UI feedback
      setStatuses((prev) => ({
        ...prev,
        [moduleId]: {
          moduleId,
          latestRun: {
            id: existingRunId ?? crypto.randomUUID(),
            deal_id: dealId!,
            module_id: moduleId,
            status: "completed",
            triggered_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            documents_included: uploadedFiles.length > 0
              ? uploadedFiles.map((f) => f.name)
              : docs.map((d) => d.file_name),
            findings_count: result.findings.length,
            critical_count: result.findings.filter(
              (f) => f.severity === "critical"
            ).length,
          },
          latestOutput: {
            id: crypto.randomUUID(),
            module_run_id: existingRunId ?? crypto.randomUUID(),
            executive_header: result.executiveHeader,
            findings: result.findings,
            full_report_markdown: result.fullReport,
            created_at: new Date().toISOString(),
          },
        },
      }));

      // Persist to database in background
      if (dealId) {
        try {
          await saveModuleResultApi({
            dealId,
            moduleId,
            executiveHeader: result.executiveHeader,
            findings: result.findings,
            fullReport: result.fullReport,
            documentsIncluded: uploadedFiles.length > 0
              ? uploadedFiles.map((f) => f.name)
              : docs.map((d) => d.file_name),
            runId: existingRunId ?? null,
          });
        } catch (err) {
          console.error("Failed to persist module result:", err);
          // Don't toast — local state is already updated, user sees results
        }
      }
    },
    [dealId, uploadedFiles, docs, saveModuleResultApi]
  );

  // ---------------------------------------------------------------------------
  // Standard module pipeline: chunk → analyze → tree-merge → report
  // ---------------------------------------------------------------------------

  /**
   * Analyze chunks in parallel with bounded concurrency.
   * Returns extractions array (in chunk order) and any errors.
   */
  const analyzeChunksParallel = useCallback(
    async (
      moduleId: string,
      chunks: Array<{ label: string; sourceFile: string; text: string; pageImages: Array<{ pageNumber: number; text: string; imageBase64: string; mediaType: "image/jpeg" }> }>,
      progressPrefix = "Analyzing"
    ) => {
      const extractions: Array<{ label: string; extraction: string; chunkIndex: number }> = new Array(chunks.length);
      const errors: string[] = [];
      let completed = 0;

      setModuleProgress(moduleId, {
        message: `${progressPrefix} 0/${chunks.length} chunks…`,
        detail: { current: 0, total: chunks.length, phase: "analyzing" },
      });

      // Process in batches of CHUNK_CONCURRENCY
      for (let batchStart = 0; batchStart < chunks.length; batchStart += CHUNK_CONCURRENCY) {
        const batchEnd = Math.min(batchStart + CHUNK_CONCURRENCY, chunks.length);
        const batch = chunks.slice(batchStart, batchEnd);

        const batchPromises = batch.map(async (chunk, batchIdx) => {
          const i = batchStart + batchIdx;
          try {
            const result = await analyzeChunk({
              moduleId,
              chunkIndex: i,
              totalChunks: chunks.length,
              chunk,
            });
            extractions[i] = result ?? { label: chunk.label, extraction: "", chunkIndex: i };
          } catch (err) {
            const msg =
              err && typeof err === "object" && "message" in err
                ? String((err as { message: unknown }).message)
                : String(err);
            errors.push(`Chunk "${chunk.label}": ${msg}`);
            extractions[i] = {
              label: chunk.label,
              extraction: `### Extraction from: ${chunk.label}\n\n[Error: ${msg}]`,
              chunkIndex: i,
            };
          } finally {
            completed++;
            setModuleProgress(moduleId, {
              message: `${progressPrefix} ${completed}/${chunks.length} chunks…`,
              detail: { current: completed, total: chunks.length, phase: "analyzing" },
            });
          }
        });

        await Promise.all(batchPromises);
      }

      return { extractions, errors };
    },
    [analyzeChunk, setModuleProgress]
  );

  const runStandardModule = useCallback(
    async (moduleId: string, existingRunId?: string) => {
      const docsIncluded = uploadedFiles.length > 0
        ? uploadedFiles.map((f) => f.name)
        : docs.map((d) => d.file_name);

      // Create or reuse a run record with status "running"
      let runId = existingRunId;
      if (!runId && dealId) {
        try {
          const res = await updateRunStatusApi({
            runId: null,
            dealId,
            moduleId,
            status: "running",
            documentsIncluded: docsIncluded,
          });
          runId = res?.runId;
        } catch {
          // Non-fatal — continue without checkpointing
        }
      }

      // Track active run for cancellation
      if (runId) {
        activeRunIdRef.current[moduleId] = runId;
      }

      // Phase 1: Get or run universal extractions (shared across all modules)
      const allExtractions = await getOrRunUniversalExtractions(moduleId);

      // Check cancellation after extraction (may have been cancelled during batch loop)
      if (runId && cancelledRunsRef.current.has(runId)) {
        return; // Already cleaned up by handleCancelModule
      }

      if (allExtractions.length === 0) {
        toast.error("No processable content found. Check your files.");
        if (runId) updateRunStatusApi({ runId, dealId: dealId!, moduleId, status: "failed" }).catch(() => {});
        return;
      }

      // Phase 2: Route — only send relevant chunks to this module
      const routed = getExtractionsForModule(allExtractions, moduleId);
      if (routed.length === 0) {
        toast.warning(
          `[${MODULE_MAP[moduleId]?.displayName}] No relevant document types found for this module. Tag your documents appropriately or tag as "Other" to include them.`
        );
        if (runId) updateRunStatusApi({ runId, dealId: dealId!, moduleId, status: "failed" }).catch(() => {});
        return;
      }

      const displayName = MODULE_MAP[moduleId]?.displayName ?? moduleId;
      setModuleProgress(moduleId, {
        message: `${routed.length} of ${allExtractions.length} chunks routed to ${displayName}…`,
      });

      // Convert TaggedExtraction[] to the format treeMerge expects
      const extractions = routed.map((ext) => ({
        label: ext.label,
        extraction: ext.extraction,
        chunkIndex: ext.chunkIndex,
      }));

      // Phase 3: Numeric Verification (numeric-eligible modules only)
      let numericReport: { figures: unknown[]; discrepancies: unknown[] } | null = null;
      let numericPartialFlag = false;
      if (NUMERIC_MODULES.has(moduleId) && docIdsForVerification.current.length > 0 && runId) {
        try {
          setModuleProgress(moduleId, { message: "Running deterministic numeric verification…" });
          const verifyResult = await numericVerifyApi({
            moduleRunId: runId,
            documentIds: docIdsForVerification.current,
          });
          if (verifyResult && (verifyResult.figureCount > 0 || verifyResult.discrepancyCount > 0)) {
            numericReport = {
              figures: verifyResult.figures ?? [],
              discrepancies: verifyResult.discrepancies ?? [],
            };
            numericPartialFlag = verifyResult.partial ?? false;
            if (verifyResult.criticalCount > 0) {
              toast.warning(
                `Numeric verification: ${verifyResult.criticalCount} critical discrepancy(ies) found — will be reported as findings.`
              );
            } else if (verifyResult.discrepancyCount > 0) {
              toast.info(`Numeric verification: ${verifyResult.discrepancyCount} discrepancy(ies) flagged.`);
            }
          } else {
            // No doc_tables data found — NumericVerify had nothing to verify.
            // This means the LLM will NOT receive any code-verified figures,
            // and the prompt guard will prevent it from hallucinating [Code-Verified] labels.
            console.warn(
              `[NumericVerify] Returned empty for ${docIdsForVerification.current.length} document(s). ` +
              `No structured tables found in doc_tables. Re-upload Excel/CSV files to enable numeric verification.`
            );
          }
        } catch (err) {
          // Non-fatal — log and continue without numeric report
          console.warn("[NumericVerify] Verification failed, continuing without:", err);
        }
      }

      // Phase 4: Tree-reduce merge (with checkpoint support)
      const finalMerge = await treeMerge(moduleId, extractions, runId, numericReport, numericPartialFlag);

      // Phase 3.5: Save coverage manifest and build coverage line
      const coverageLine = buildCoverageLine();
      if (runId && coverageRef.current) {
        saveRunCoverageApi({
          moduleRunId: runId,
          documentsIncluded: coverageRef.current.filesProcessed,
          documentsExcluded: coverageRef.current.filesExcluded,
          chunkCount: coverageRef.current.chunkCount,
          pagesProcessed: coverageRef.current.pagesProcessed,
        }).catch((err: unknown) => console.error("Failed to save coverage manifest:", err));
      }

      // Phase 5: Format report (with coverage line and numeric report)
      const totalMergeRounds = Math.ceil(Math.log2(Math.max(extractions.length, 2)));
      const fullReport = await generateReport(moduleId, finalMerge, totalMergeRounds + 1, coverageLine, numericReport);

      await saveModuleResult(moduleId, {
        executiveHeader: finalMerge.executiveHeader,
        findings: finalMerge.findings,
        fullReport,
      });

      // Mark run completed
      if (runId) updateRunStatusApi({ runId, dealId: dealId!, moduleId, status: "completed" }).catch(() => {});

      toast.success(`${displayName} complete!`);
    },
    [dealId, uploadedFiles, docs, getOrRunUniversalExtractions, treeMerge, generateReport, saveModuleResult, setModuleProgress, updateRunStatusApi, saveRunCoverageApi, numericVerifyApi]
  );

  // ---------------------------------------------------------------------------
  // Executive Summary pipeline: uses prior module outputs
  // ---------------------------------------------------------------------------

  const runExecutiveSummary = useCallback(async () => {
    const moduleId = "executive_summary";

    // Gather completed module outputs (excluding executive_summary itself)
    const priorModules = Object.entries(statuses).filter(
      ([id, s]) => id !== "executive_summary" && s.latestRun?.status === "completed" && s.latestOutput
    );

    if (priorModules.length === 0) {
      toast.error("Run at least one analysis module before generating the Executive Summary.");
      return;
    }

    // Build chunks from prior module outputs
    const execChunks = priorModules.map(([id, s]) => {
      const displayName = MODULE_MAP[id]?.displayName ?? id;
      const output = s.latestOutput!;
      return {
        label: displayName,
        sourceFile: `Module: ${displayName}`,
        text: `Module: ${displayName}\n\nExecutive Header: ${output.executive_header}\n\nFindings (${output.findings.length}):\n${output.findings
          .map(
            (f: { severity: string; title: string; detail: string }, fi: number) =>
              `${fi + 1}. [${f.severity}] ${f.title}: ${f.detail}`
          )
          .join("\n")}\n\nFull Report:\n${output.full_report_markdown}`,
        pageImages: [] as Array<{ pageNumber: number; text: string; imageBase64: string; mediaType: "image/jpeg" }>,
      };
    });

    // Analyze all module outputs in parallel
    const { extractions } = await analyzeChunksParallel(
      moduleId,
      execChunks,
      "Synthesizing module outputs"
    );

    // Tree-reduce merge
    const finalMerge = await treeMerge(moduleId, extractions);

    // Format report (with coverage line if available from prior runs)
    const coverageLine = buildCoverageLine();
    const totalMergeRounds = Math.ceil(Math.log2(Math.max(extractions.length, 2)));
    const fullReport = await generateReport(moduleId, finalMerge, totalMergeRounds + 1, coverageLine || undefined);

    await saveModuleResult(moduleId, {
      executiveHeader: finalMerge.executiveHeader,
      findings: finalMerge.findings,
      fullReport,
    });

    toast.success("Executive Summary complete!");
  }, [statuses, analyzeChunksParallel, treeMerge, generateReport, saveModuleResult, setModuleProgress]);

  // ---------------------------------------------------------------------------
  // Server-side pipeline: kick-off → poll → format report
  // The pipeline runs entirely on the server and survives browser tab closure.
  // ---------------------------------------------------------------------------

  const runServerPipeline = useCallback(
    async (moduleId: string, resumeRunId?: string) => {
      const displayName = MODULE_MAP[moduleId]?.displayName ?? moduleId;

      // Ensure universal extractions exist on the server
      // (they were saved during previous client-side runs or bulk-extract)
      setModuleProgress(moduleId, { message: "Preparing server-side pipeline…" });

      // Numeric verification (client-side, fast — needs doc_tables)
      let numericReport: { figures: unknown[]; discrepancies: unknown[] } | null = null;
      let numericPartial = false;
      if (NUMERIC_MODULES.has(moduleId) && docIdsForVerification.current.length > 0) {
        try {
          setModuleProgress(moduleId, { message: "Running deterministic numeric verification…" });
          const verifyResult = await numericVerifyApi({
            moduleRunId: crypto.randomUUID(), // placeholder — server creates real run
            documentIds: docIdsForVerification.current,
          });
          if (verifyResult && (verifyResult.figureCount > 0 || verifyResult.discrepancyCount > 0)) {
            numericReport = {
              figures: verifyResult.figures ?? [],
              discrepancies: verifyResult.discrepancies ?? [],
            };
            numericPartial = verifyResult.partial ?? false;
          }
        } catch (err) {
          console.warn("[NumericVerify] Verification failed, continuing without:", err);
        }
      }

      // Kick off server pipeline (or resume an existing one)
      setModuleProgress(moduleId, {
        message: resumeRunId ? "Resuming server-side analysis…" : "Starting server-side analysis…",
      });

      // Helper: call RunModulePipeline with network-error retries
      // The server pipeline runs independently — a fetch timeout doesn't mean it failed
      const callPipelineWithRetry = async (runIdArg?: string) => {
        const MAX_RETRIES = 3;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            return await runModulePipelineApi({
              dealId: dealId!,
              moduleId,
              runId: runIdArg ?? undefined,
              useOpus: useOpus || undefined,
              subjectDocumentIds: selectedSubjectIds.length > 0 ? selectedSubjectIds : undefined,
              numericReport,
              numericPartial: numericPartial || undefined,
            });
          } catch (err) {
            const msg = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : String(err);
            const isNetworkError = /failed to fetch|network|timeout|abort|NETWORK_ERROR/i.test(msg);
            if (!isNetworkError || attempt === MAX_RETRIES - 1) throw err;
            // Wait before retry — server pipeline keeps running
            setModuleProgress(moduleId, { message: `Connection interrupted, retrying (${attempt + 2}/${MAX_RETRIES})…` });
            await new Promise(r => setTimeout(r, 10_000));
          }
        }
      };

      let pipelineResult = await callPipelineWithRetry(resumeRunId);

      if (!pipelineResult) throw new Error("Pipeline returned no result");

      const runId = pipelineResult.runId;
      activeRunIdRef.current[moduleId] = runId;

      // Poll loop: re-invoke pipeline if it returned in_progress (time budget)
      const POLL_INTERVAL_MS = 5_000;
      const MAX_POLLS = 120; // 10 min max polling (5s × 120)
      let pollCount = 0;

      // Mark that the pipeline polling loop is now active — the progress-poll
      // effect should stop overwriting progress messages for this module
      if (pipelineResult.status === "in_progress" || pipelineResult.status === "completed") {
        pipelinePollingActive.current.add(moduleId);
      }

      while (pipelineResult.status === "in_progress" && pollCount < MAX_POLLS) {
        // Update progress UI
        const prog = pipelineResult.progress;
        const phase = pipelineResult.phase;
        const failInfo = (pipelineResult as { failedChunks?: number; firstError?: string | null }).failedChunks
          ? ` (${(pipelineResult as { failedChunks?: number }).failedChunks} failed)`
          : "";
        if (phase === "cleanup") {
          setModuleProgress(moduleId, {
            message: `Cleaning documents… ${prog.analysisCompleted}/${prog.analysisTotal}`,
            detail: { current: prog.analysisCompleted, total: prog.analysisTotal, phase: "analyzing" },
          });
        } else if (phase === "extraction") {
          setModuleProgress(moduleId, {
            message: `Extracting documents… ${prog.analysisCompleted}/${prog.analysisTotal}${failInfo}`,
            detail: { current: prog.analysisCompleted, total: prog.analysisTotal, phase: "analyzing" },
          });
        } else if (phase === "web_research") {
          setModuleProgress(moduleId, {
            message: `Web research… iteration ${prog.analysisCompleted}/${prog.analysisTotal}${failInfo}`,
            detail: { current: prog.analysisCompleted, total: prog.analysisTotal, phase: "researching" },
          });
        } else if (phase === "analysis") {
          setModuleProgress(moduleId, {
            message: `Analyzing chunks (server)… ${prog.analysisCompleted}/${prog.analysisTotal}${failInfo}`,
            detail: { current: prog.analysisCompleted, total: prog.analysisTotal, phase: "analyzing" },
          });
        } else if (phase === "merge") {
          const groupInfo = prog.mergeGroupsTotal
            ? ` — ${prog.mergeGroupsDone ?? 0}/${prog.mergeGroupsTotal} groups`
            : "";
          setModuleProgress(moduleId, {
            message: `Merging findings (server)… round ${prog.mergeRound}/${prog.mergeTotal}${groupInfo}`,
            detail: { current: prog.mergeRound, total: prog.mergeTotal, phase: "synthesizing" },
          });
        }

        // Check cancellation
        if (cancelledRunsRef.current.has(runId)) return;

        // Wait before re-invoking
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        pollCount++;

        // Check cancellation again after sleep
        if (cancelledRunsRef.current.has(runId)) return;

        // Re-invoke pipeline to continue from checkpoints
        const pollResult = await callPipelineWithRetry(runId);

        if (!pollResult) throw new Error("Pipeline continuation returned no result");
        pipelineResult = pollResult;

        // Track checkpoint progress so the resume-failure handler knows if the server advanced
        if (pipelineResult.progress) {
          const prog = pipelineResult.progress;
          const total = (prog.analysisCompleted ?? 0) + (prog.mergeRound ?? 0);
          if (total > 0) lastKnownCheckpointsRef.current[moduleId] = total;
        }
      }

      if (pipelineResult.status === "cancelled") {
        // Server confirmed cancellation — exit cleanly without error toast
        console.log(`[pipeline] Run ${runId} confirmed cancelled at gate: ${pipelineResult.phase}`);
        return;
      }

      if (pipelineResult.status === "in_progress") {
        throw new Error("Pipeline timed out after maximum poll attempts");
      }

      if (pipelineResult.status === "failed") {
        const errDetail = (pipelineResult as { firstError?: string | null }).firstError;
        throw new Error(
          `Server pipeline failed during ${pipelineResult.phase}${errDetail ? `: ${errDetail}` : ""}`
        );
      }

      // Pipeline completed — format report
      const finalResult = pipelineResult.result;
      if (!finalResult) {
        // The server returns result:null when the run was already completed (synthetic response).
        // Fall back to loading the persisted output from module_outputs via GetRunOutput.
        console.log("[pipeline] result:null on completed — loading from GetRunOutput");
        const stored = await executeApi("GetRunOutput", { runId: pipelineResult.runId });
        if (!stored?.output) {
          throw new Error("Pipeline completed but no result returned and no persisted output found");
        }
        // Use the persisted output directly — it already has findings + fullReport
        await saveModuleResult(moduleId, {
          executiveHeader: stored.output.executiveHeader,
          findings: stored.output.findings as MergeNode["findings"],
          fullReport: stored.output.fullReport,
        }, pipelineResult.runId);
        toast.success(`${displayName} complete!`);
        return;
      }

      const finalMerge: MergeNode = {
        text: finalResult.mergedText,
        executiveHeader: finalResult.executiveHeader,
        findings: finalResult.findings as MergeNode["findings"],
      };

      // Use server-side formatted report if available (eliminates client-side FormatReport timeout).
      // Fall back to client-side formatting only when the pipeline didn't produce one.
      let fullReport: string;
      if (finalResult.fullReport) {
        console.log("[pipeline] Using server-side formatted report");
        fullReport = finalResult.fullReport;
      } else {
        const coverageLine = buildCoverageLine();
        const totalMergeRounds = pipelineResult.progress.mergeTotal;
        fullReport = await generateReport(moduleId, finalMerge, totalMergeRounds + 1, coverageLine, numericReport);
      }

      await saveModuleResult(moduleId, {
        executiveHeader: finalMerge.executiveHeader,
        findings: finalMerge.findings,
        fullReport,
      }, runId);

      toast.success(`${displayName} complete!`);
    },
    [dealId, useOpus, selectedSubjectIds, numericVerifyApi, runModulePipelineApi, getRunProgressApi, generateReport, saveModuleResult, setModuleProgress]
  );

  // ---------------------------------------------------------------------------
  // Run single module
  // ---------------------------------------------------------------------------

  const handleRunModule = useCallback(
    async (moduleId: string, resumeRunId?: string) => {
      // Hard kill — never resume a module that was explicitly killed this session
      if (killedModulesRef.current.has(moduleId)) {
        console.warn(`[handleRunModule] ${moduleId} is killed — ignoring`);
        return;
      }

      // Skip the "already running" guard when resuming — we're reconnecting to an existing run
      if (!resumeRunId && runningModules.has(moduleId)) {
        toast.info("This module is already running.");
        return;
      }

      // Executive Summary — special handling
      if (moduleId === "executive_summary") {
        const priorCompleted = Object.entries(statuses).filter(
          ([id, s]) => id !== "executive_summary" && s.latestRun?.status === "completed"
        );
        if (priorCompleted.length === 0) {
          toast.warning("Run at least one other module first before generating the Executive Summary.");
          return;
        }
      } else if (!resumeRunId && uploadedFiles.length === 0 && docs.length === 0) {
        toast.warning("Upload at least one document before running analysis.");
        return;
      }

      setRunningModules((prev) => new Set(prev).add(moduleId));
      // Also update statuses so the progress poll effect includes this module
      // in dbRunningIds (otherwise a prior cancel leaves status as "failed")
      setStatuses((prev) => {
        const current = prev[moduleId];
        return {
          ...prev,
          [moduleId]: {
            ...current,
            latestRun: current?.latestRun
              ? { ...current.latestRun, status: "running" as const }
              : { id: "", deal_id: dealId ?? "", module_id: moduleId, status: "running" as const, triggered_at: new Date().toISOString(), completed_at: null, documents_included: [], findings_count: 0, critical_count: 0 },
          },
        };
      });
      setProgressMap((prev) => ({
        ...prev,
        [moduleId]: { message: "Starting…", detail: null, chunkErrors: [] },
      }));

      // Auto-purge stale runs (>30 min stuck as "running") before starting
      // Exclude the current module so we don't kill its own prior run (we'll resume it instead)
      if (dealId) {
        purgeStaleRunsApi({ dealId, staleMinutes: 30, excludeModuleId: moduleId }).catch(() => {});
      }

      let exitedEarlyForResume = false;

      try {
        if (moduleId === "executive_summary") {
          await runExecutiveSummary();
        } else if (dealId) {
          // Server-side pipeline: survives tab closure, checkpointed
          // (web research modules now use the same server pipeline path)
          await runServerPipeline(moduleId, resumeRunId);
        } else {
          // Fallback: client-side pipeline (no-deal edge case)
          await runStandardModule(moduleId, resumeRunId);
        }
      } catch (err) {
        const message =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
        const isTimeoutOrNetwork = /timeout|timed out|abort|cancel|failed to fetch|network/i.test(message);
        const displayName = MODULE_MAP[moduleId]?.displayName ?? moduleId;

        if (resumeRunId && isTimeoutOrNetwork && dealId) {
          // Before counting as a failure, check if the server actually made progress
          // (wrote new checkpoints). If it did, the server is working — the fetch just
          // timed out at the platform's 300s limit. Reset the counter and let heartbeat retry.
          let serverMadeProgress = false;
          try {
            const progress = await getRunProgressApi({ dealId });
            const runs = progress?.runs ?? [];
            const run = runs.find((r: { moduleId: string }) => r.moduleId === moduleId);
            if (run) {
              const currentCheckpoints = (run.analysisCheckpointCount ?? 0) + (run.mergeCheckpointCount ?? 0);
              const lastKnown = lastKnownCheckpointsRef.current[moduleId] ?? 0;
              if (currentCheckpoints > lastKnown) {
                serverMadeProgress = true;
                lastKnownCheckpointsRef.current[moduleId] = currentCheckpoints;
              }
            }
          } catch {
            // GetRunProgress failed too — can't determine progress, fall through to failure logic
          }

          if (serverMadeProgress) {
            // Server IS working (checkpoints advanced) — reset failure counter, let heartbeat retry
            resumeFailureCountRef.current[moduleId] = 0;
            console.log(`[handleRunModule] ${moduleId}: fetch timed out but server made progress (checkpoints advanced) — will retry`);
            toast.info(`[${displayName}] Server pipeline is making progress. Reconnecting…`);
            pipelinePollingActive.current.delete(moduleId);
            exitedEarlyForResume = true;
            return;
          }

          // Server did NOT advance — count as a genuine failure
          const count = (resumeFailureCountRef.current[moduleId] ?? 0) + 1;
          resumeFailureCountRef.current[moduleId] = count;

          if (count >= 5) {
            // Five consecutive failures with no checkpoint progress — enter backoff-and-retry
            // (Freeze Exception #4): instead of permanently killing, wait 2 minutes and try
            // one last resume. ResumeStalePipelines is idempotent and safe to call speculatively.
            console.warn(`[handleRunModule] ${moduleId}: ${count} consecutive resume failures with no progress — entering 2-min backoff`);
            toast.warning(`[${displayName}] Server appears stalled after ${count} attempts with no progress. Waiting 2 minutes before final retry…`);
            pipelinePollingActive.current.delete(moduleId);
            exitedEarlyForResume = true;

            // Fire-and-forget: backoff then one last attempt
            setTimeout(async () => {
              try {
                // Check progress one more time after the 2-min wait
                let progressAfterWait = false;
                try {
                  const progress = await getRunProgressApi({ dealId: dealId! });
                  const runs = progress?.runs ?? [];
                  const run = runs.find((r: { moduleId: string }) => r.moduleId === moduleId);
                  if (run) {
                    const currentCp = (run.analysisCheckpointCount ?? 0) + (run.mergeCheckpointCount ?? 0);
                    const lastKnown = lastKnownCheckpointsRef.current[moduleId] ?? 0;
                    if (currentCp > lastKnown) {
                      progressAfterWait = true;
                      lastKnownCheckpointsRef.current[moduleId] = currentCp;
                    }
                  }
                } catch { /* ignore */ }

                if (progressAfterWait) {
                  // Server recovered during backoff — reset and let heartbeat continue
                  resumeFailureCountRef.current[moduleId] = 0;
                  console.log(`[handleRunModule] ${moduleId}: progress detected during backoff — recovered`);
                  toast.success(`[${MODULE_MAP[moduleId]?.displayName ?? moduleId}] Server recovered — resuming.`);
                  return;
                }

                // No progress during backoff — attempt one final resume
                console.log(`[handleRunModule] ${moduleId}: backoff complete, attempting final resume`);
                resumeFailureCountRef.current[moduleId] = 0; // Reset for the last attempt
                await handleRunModule(moduleId, resumeRunId);

                // If handleRunModule returned without throw, it's either running or heartbeat handles it
              } catch (backoffErr) {
                // Final attempt also failed — now permanently kill
                console.error(`[handleRunModule] ${moduleId}: post-backoff resume also failed — permanently killing`, backoffErr);
                killedModulesRef.current.add(moduleId);
                toast.error(`[${MODULE_MAP[moduleId]?.displayName ?? moduleId}] Server stalled after backoff retry — stopped. Refresh to retry.`);
                setRunningModules((prev) => {
                  const next = new Set(prev);
                  next.delete(moduleId);
                  return next;
                });
                clearModuleProgress(moduleId);
                pipelinePollingActive.current.delete(moduleId);
              }
            }, 120_000); // 2-minute backoff

            return;
          } else {
            // Not yet at kill threshold — give it another chance
            toast.info(`[${displayName}] Connection to server pipeline timed out. The analysis continues server-side — progress will update automatically.`);
            pipelinePollingActive.current.delete(moduleId);
            exitedEarlyForResume = true;
            return;
          }
        }

        const hint = isTimeoutOrNetwork ? " Try with fewer or smaller files." : "";
        toast.error(`[${displayName}] Analysis failed: ${message}${hint}`);
      } finally {
        if (!exitedEarlyForResume) {
          setRunningModules((prev) => {
            const next = new Set(prev);
            next.delete(moduleId);
            return next;
          });
          clearModuleProgress(moduleId);
          pipelinePollingActive.current.delete(moduleId);
          // Reset resume failure counter on clean exit (success or non-network error)
          delete resumeFailureCountRef.current[moduleId];
          // Clean up cancellation tracking
          const finishedRunId = activeRunIdRef.current[moduleId];
          if (finishedRunId) {
            cancelledRunsRef.current.delete(finishedRunId);
            delete activeRunIdRef.current[moduleId];
          }
        }
      }
    },
    [
      runningModules,
      uploadedFiles,
      docs,
      statuses,
      dealId,
      runStandardModule,
      runServerPipeline,
      runExecutiveSummary,
      clearModuleProgress,
      getRunProgressApi,
    ]
  );

  // ---------------------------------------------------------------------------
  // Cancel a running module
  // ---------------------------------------------------------------------------

  const handleCancelModule = useCallback(
    async (moduleId: string) => {
      // Try activeRunIdRef first (set during live pipeline execution),
      // then fall back to the DB-reported running run ID from statuses
      let runId = activeRunIdRef.current[moduleId];
      if (!runId) {
        const dbRun = statuses[moduleId]?.latestRun;
        if (dbRun?.status === "running") {
          runId = dbRun.id;
        }
      }
      if (!runId) {
        toast.warning("No active run to cancel.");
        return;
      }

      // Mark cancelled locally (immediate — extraction loop checks this ref)
      cancelledRunsRef.current.add(runId);
      // Permanently kill — prevent auto-resume from re-triggering
      killedModulesRef.current.add(moduleId);

      // Mark cancelled server-side (module-scoped: cancels all running/pending for this module)
      try {
        await cancelModuleRunApi({ dealId: dealId ?? undefined, moduleId, runId });
        toast.info(`${MODULE_MAP[moduleId]?.displayName ?? moduleId} cancelled.`);
      } catch (err) {
        console.error("Failed to cancel run in DB:", err);
        toast.error("Cancel request failed — the run may still stop on next batch.");
      }

      // Clean up local state — update statuses so isRunning flips immediately
      // DB is_cancelled flag ALWAYS overrides client state (survives reload).
      // cancelledRunsRef is UX-only for instant button feedback.
      setStatuses((prev) => {
        const current = prev[moduleId];
        if (!current?.latestRun) return prev;
        return {
          ...prev,
          [moduleId]: {
            ...current,
            latestRun: { ...current.latestRun, status: "failed" as const, isCancelled: true },
          },
        };
      });
      setRunningModules((prev) => {
        const next = new Set(prev);
        next.delete(moduleId);
        return next;
      });
      clearModuleProgress(moduleId);
      pipelinePollingActive.current.delete(moduleId);
      delete activeRunIdRef.current[moduleId];
    },
    [cancelModuleRunApi, clearModuleProgress, statuses, dealId]
  );

  // ---------------------------------------------------------------------------
  // Run All — launches all modules simultaneously, exec summary last
  // ---------------------------------------------------------------------------

  const handleRunAll = useCallback(async () => {
    setShowRunAll(false);

    if (uploadedFiles.length === 0 && docs.length === 0) {
      toast.warning("Upload at least one document before running analysis.");
      return;
    }

    // Launch all non-executive-summary modules simultaneously
    const modulesToRun = MODULE_DEFINITIONS.filter(
      (m) => m.id !== "executive_summary" && !runningModules.has(m.id)
    );

    if (modulesToRun.length === 0) {
      toast.info("All modules are already running.");
      return;
    }

    toast.info(`Launching ${modulesToRun.length} modules simultaneously…`);

    // Run all modules in parallel
    const promises = modulesToRun.map((m) => handleRunModule(m.id));
    await Promise.allSettled(promises);

    // After all complete, run Executive Summary automatically
    // Re-check statuses to see what completed (use a timeout to let state settle)
    setTimeout(() => {
      handleRunModule("executive_summary");
    }, 500);
  }, [uploadedFiles, docs, runningModules, handleRunModule]);

  // ---------------------------------------------------------------------------
  // Resume interrupted runs on deal load
  // ---------------------------------------------------------------------------
  const resumeChecked = useRef(false);
  // Track whether the pipeline polling loop has taken over progress updates
  const pipelinePollingActive = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!dealId || resumeChecked.current || !docsInitialized.current) return;
    if (docs.length === 0) return;
    resumeChecked.current = true;
    (async () => {
      try {
        const progress = await getRunProgressApi({ dealId });
        const runs = progress?.runs ?? [];
        const inProgressRuns = runs.filter((r: { status: string }) => r.status === "running");
        if (inProgressRuns.length === 0) return;
        toast.info(`Resuming ${inProgressRuns.length} interrupted run(s)…`);
        for (const run of inProgressRuns) {
          if (run.moduleId === "executive_summary") continue;
          if (killedModulesRef.current.has(run.moduleId)) continue;
          handleRunModule(run.moduleId, run.runId);
        }
      } catch (err) {
        console.error("Failed to check for interrupted runs:", err);
      }
    })();
  }, [dealId, docs, handleRunModule, getRunProgressApi]);

  // ---------------------------------------------------------------------------
  // Auto-resume: re-invokes orphaned pipelines (no active polling loop) when
  // the tab regains focus OR periodically via heartbeat. Covers:
  //   - Tab switch (visibilitychange hidden→visible)
  //   - Laptop sleep/wake (visibilitychange in most browsers)
  //   - Long-running foreground tab where the loop died silently (heartbeat)
  //
  // Guards against double-fire:
  //   - resumingModules ref tracks which modules are currently being resumed
  //   - pipelinePollingActive check before invoking (set by handleRunModule)
  //   - Modules removed from resumingModules only after handleRunModule settles
  //
  // This is a CLIENT-SIDE improvement. The permanent browser-independent fix
  // is a Superblocks Workflow (server-side cron) — this is complementary UX.
  // ---------------------------------------------------------------------------
  const resumingModulesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!dealId) return;

    const attemptResume = async () => {
      // Find modules that DB says are running but the pipeline loop is NOT driving
      const dbRunningIds = Object.entries(statuses)
        .filter(([, s]) => s.latestRun?.status === "running")
        .map(([id]) => id);

      const orphanedModules = dbRunningIds.filter(
        (id) =>
          !pipelinePollingActive.current.has(id) &&
          !resumingModulesRef.current.has(id) &&
          !killedModulesRef.current.has(id)
      );

      if (orphanedModules.length === 0) return;

      // Gate: Do NOT resume until docs are loaded and selectedSubjectIds is populated.
      // Without this, the auto-resume can fire before the useEffect sets subjectIds,
      // sending an empty array that kills the run via the server's subject guard.
      if (!docsInitialized.current) {
        console.log("[auto-resume] Skipping — docs not yet loaded (selectedSubjectIds would be empty)");
        return;
      }

      // Small delay to let browser connections stabilize after wake
      await new Promise((r) => setTimeout(r, 1_000));

      for (const moduleId of orphanedModules) {
        if (moduleId === "executive_summary") continue;
        const runId = statuses[moduleId]?.latestRun?.id;
        if (!runId) continue;
        // Re-check guards after the delay (another resume may have started)
        if (pipelinePollingActive.current.has(moduleId)) continue;
        if (resumingModulesRef.current.has(moduleId)) continue;

        resumingModulesRef.current.add(moduleId);
        console.log(`[auto-resume] Re-invoking orphaned pipeline: ${moduleId} (run ${runId})`);
        // Fire-and-forget: handleRunModule manages its own state
        handleRunModule(moduleId, runId).finally(() => {
          resumingModulesRef.current.delete(moduleId);
        });
      }
    };

    // Visibility change: covers tab switch + most sleep/wake scenarios
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        attemptResume();
      }
    };

    // Heartbeat: catches the edge case where the tab stays foreground but
    // the polling loop died (e.g., laptop sleep without visibility change,
    // or a silent network disconnect that killed the API call)
    const heartbeatInterval = setInterval(() => {
      if (document.visibilityState === "visible") {
        attemptResume();
      }
    }, 30_000);

    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      clearInterval(heartbeatInterval);
    };
  }, [dealId, statuses, handleRunModule]);

  // ---------------------------------------------------------------------------
  // Progress polling for DB-running modules
  // Keeps UI updated independently of the RunModulePipeline call (which can
  // take up to 200s to return). Polls GetRunProgress every 15s and shows
  // checkpoint-based progress until the pipeline polling loop takes over.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!dealId) return;

    // Find modules that are marked running from DB but not yet driven by
    // the pipeline polling loop (which sets real progress messages)
    const dbRunningIds = Object.entries(statuses)
      .filter(([, s]) => s.latestRun?.status === "running")
      .map(([id]) => id)
      .filter((id) => !killedModulesRef.current.has(id));

    if (dbRunningIds.length === 0) return;

    // Bail immediately if the poll has already been killed (ref persists across re-runs)
    if (pollFailureCountRef.current >= 3) return;

    let cancelled = false;

    const pollProgress = async () => {
      if (cancelled) return;
      try {
        const progress = await getRunProgressApi({ dealId });
        if (cancelled) return;
        pollFailureCountRef.current = 0; // reset on success
        const runs = progress?.runs ?? [];
        const extractionCount = progress?.extractionCount ?? 0;

        for (const moduleId of dbRunningIds) {
          // Skip if the pipeline polling loop is now providing real-time progress
          if (pipelinePollingActive.current.has(moduleId)) continue;

          const run = runs.find((r: { moduleId: string; status: string; analysisCheckpointCount?: number; mergeCheckpointCount?: number }) => r.moduleId === moduleId && r.status === "running");
          if (!run) {
            // Run is no longer "running" in DB — it completed or failed while
            // we were polling. Refetch module results to get the final output.
            refetchModules();
            setRunningModules((prev) => {
              const next = new Set(prev);
              next.delete(moduleId);
              return next;
            });
            setProgressMap((prev) => {
              const updated = { ...prev };
              delete updated[moduleId];
              return updated;
            });
            continue;
          }

          // Derive progress from checkpoint counts
          let message: string;
          if (run.mergeCheckpointCount && run.mergeCheckpointCount > 0) {
            message = `Merge phase: ${run.mergeCheckpointCount} nodes merged (server-side)…`;
          } else if (run.analysisCheckpointCount && run.analysisCheckpointCount > 0) {
            message = `Analysis phase: ${run.analysisCheckpointCount} chunks completed (server-side)…`;
          } else if (extractionCount > 0) {
            message = `Preparing analysis: ${extractionCount} extractions available (server-side)…`;
          } else {
            message = "Running (server-side)…";
          }

          setProgressMap((prev) => {
            return { ...prev, [moduleId]: { message, detail: null, chunkErrors: [] } };
          });
        }
      } catch {
        pollFailureCountRef.current++;
        if (pollFailureCountRef.current >= 3) {
          // Server unreachable — stop polling and clear running state to prevent infinite loop
          console.warn(`[progress-poll] 3 consecutive failures — stopping poll and clearing running state`);
          cancelled = true;
          for (const moduleId of dbRunningIds) {
            killedModulesRef.current.add(moduleId);
            setRunningModules((prev) => {
              const next = new Set(prev);
              next.delete(moduleId);
              return next;
            });
            setProgressMap((prev) => {
              const updated = { ...prev };
              delete updated[moduleId];
              return updated;
            });
          }
        }
      }
    };

    // Initial poll immediately
    pollProgress();
    // Then every 15s
    const interval = setInterval(pollProgress, 15_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [dealId, statuses, getRunProgressApi, refetchModules]);

  // ---------------------------------------------------------------------------
  // Watchdog: self-healing invariant for stuck modules
  // Improvement over the heartbeat: queries DB directly (GetRunProgress) rather
  // than relying on `statuses` React state, which may be stale between refetches.
  // Guarantee: recovers within ~60-90s of the tab being open and visible.
  // Does NOT survive a closed tab or fully backgrounded/throttled one.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!dealId) return;

    const WATCHDOG_INTERVAL_MS = 60_000;

    const watchdog = async () => {
      if (document.visibilityState !== "visible") return;

      try {
        const progress = await getRunProgressApi({ dealId });
        const dbRunning = (progress?.runs ?? []).filter(
          (r: { status: string }) => r.status === "running"
        );

        for (const run of dbRunning) {
          const { moduleId, runId } = run as { moduleId: string; runId: string };
          if (moduleId === "executive_summary") continue;
          if (killedModulesRef.current.has(moduleId)) continue;

          const hasActivePolling = pipelinePollingActive.current.has(moduleId);
          const isResuming = resumingModulesRef.current.has(moduleId);

          if (!hasActivePolling && !isResuming) {
            console.log(
              `[watchdog] Module ${moduleId} is DB-running with no client driver — forcing resume (run ${runId})`
            );
            handleRunModule(moduleId, runId);
          }
        }
      } catch {
        // Watchdog failure is non-fatal — next interval will retry
      }
    };

    const interval = setInterval(watchdog, WATCHDOG_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [dealId, handleRunModule, getRunProgressApi]);

  // ---------------------------------------------------------------------------
  // Document management
  // ---------------------------------------------------------------------------

  const handleUpload = useCallback(
    async (files: File[]) => {
      // Deduplicate: separate files that already exist in this deal (by filename)
      // from genuinely new files. Existing files still get added to uploadedFiles
      // so doc_tables extraction runs, but they skip the DB insert.
      const existingFileNames = new Set(docs.map((d) => d.file_name));
      const newFiles = files.filter((f) => !existingFileNames.has(f.name));
      const reuploadedFiles = files.filter((f) => existingFileNames.has(f.name));

      setUploadedFiles((prev) => [...prev, ...files]); // all files for extraction
      // Invalidate caches since files changed
      chunksCache.current = null;
      chunksCacheKey.current = "";
      coverageRef.current = null;
      universalExtractionsCache.current = null;
      universalExtractionsCacheKey.current = "";
      docTablesCacheKey.current = "";
      docIdsForVerification.current = [];

      // Only add genuinely new docs to UI state — skip duplicates
      if (newFiles.length > 0) {
        const newDocs: Document[] = newFiles.map((f) => ({
          id: crypto.randomUUID(),
          deal_id: dealId!,
          file_name: f.name,
          file_type: f.type || "application/octet-stream",
          document_tag: "other" as DocumentTag,
          document_source: "sellside" as DocumentSource,
          uploaded_at: new Date().toISOString(),
        }));
        setDocs((prev) => [...prev, ...newDocs]);
      }

      // User feedback
      if (reuploadedFiles.length > 0 && newFiles.length === 0) {
        toast.info(
          `Re-processing ${reuploadedFiles.length} existing file${reuploadedFiles.length > 1 ? "s" : ""} for structured table extraction (no duplicates created).`
        );
      } else if (reuploadedFiles.length > 0 && newFiles.length > 0) {
        toast.success(
          `Uploaded ${newFiles.length} new document${newFiles.length > 1 ? "s" : ""}. ` +
          `Re-processing ${reuploadedFiles.length} existing file${reuploadedFiles.length > 1 ? "s" : ""} (no duplicates).`
        );
      } else {
        toast.success(`Uploaded ${files.length} document${files.length > 1 ? "s" : ""}`);
      }

      // If there are already completed modules, prompt user to re-run
      if (completedModules.length > 0) {
        setRerunModal({
          fileNames: files.map((f) => f.name),
          suggestedIds: completedModules.filter((id) => id !== "executive_summary"),
        });
      }

      // Persist genuinely new files to database and index for Q&A.
      // Re-uploaded files are skipped — they already exist in the DB
      // and their doc_tables will be extracted via the normal chunk-building path.
      // Track real DB IDs for doc_tables extraction below.
      const savedDbIds: Record<string, string> = {};
      if (dealId) {
        for (const f of newFiles) {
          try {
            // Extract text for Q&A indexing (fast — no image rendering)
            const parsedText = await extractTextFromFile(f);

            const result = await saveDocumentApi({
              dealId,
              fileName: f.name,
              fileType: f.type || "application/octet-stream",
              documentTag: "other",
              documentSource: "sellside",
              parsedText: parsedText || null,
            });

            // Store the real DB ID for doc_tables extraction
            if (result?.document?.id) {
              savedDbIds[f.name] = result.document.id;
              // Update docs state with the real DB ID (replace client-side UUID)
              setDocs((prev) =>
                prev.map((d) =>
                  d.file_name === f.name && !d.uploaded_at.startsWith("20")
                    ? { ...d, id: result.document.id }
                    : d
                )
              );
            }

            // Index chunks for full-text search
            if (parsedText && result?.document?.id) {
              indexDocumentChunks({
                documentId: result.document.id,
                dealId,
                fileName: f.name,
                parsedText,
              }).catch((err: unknown) =>
                console.error("Failed to index document chunks:", err)
              );
            }
          } catch (err) {
            console.error("Failed to save document:", err);
          }
        }
      }

      // Eagerly extract and save structured tables for all uploaded Excel/CSV files.
      // This ensures doc_tables is populated immediately at upload time, not deferred
      // to the module run. Covers both new uploads and re-uploads of existing files.
      // Build docIdByName from: (1) real DB IDs for newly saved files, (2) existing docs for re-uploads
      const docIdByName: Record<string, string> = {};
      // First, map existing docs (covers re-uploaded files)
      for (const doc of docs) docIdByName[doc.file_name] = doc.id;
      // Then, overlay with real DB IDs from the persist loop (overrides client-side UUIDs)
      Object.assign(docIdByName, savedDbIds);

      const tablesPayload: Array<{
        documentId: string;
        sheetOrPage: string;
        caption: string | null;
        data: { row_headers: string[]; col_headers: string[]; cells: StructuredCell[] };
      }> = [];

      for (const f of files) {
        const docId = docIdByName[f.name];
        if (!docId) continue;
        const lower = f.name.toLowerCase();
        if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".xlsm")) {
          try {
            const buf = await f.arrayBuffer();
            const tables = parseExcelToTables(buf, f.name);
            for (const t of tables) {
              tablesPayload.push({
                documentId: docId,
                sheetOrPage: t.sheetOrPage,
                caption: t.caption,
                data: { row_headers: t.rowHeaders, col_headers: t.colHeaders, cells: t.cells },
              });
            }
          } catch (err) {
            console.warn(`[doc_tables] Failed to parse ${f.name} at upload:`, err);
          }
        } else if (lower.endsWith(".csv")) {
          try {
            const buf = await f.arrayBuffer();
            const csvText = new TextDecoder("utf-8").decode(buf);
            const t = parseCsvToTable(csvText, f.name);
            if (t) {
              tablesPayload.push({
                documentId: docId,
                sheetOrPage: t.sheetOrPage,
                caption: t.caption,
                data: { row_headers: t.rowHeaders, col_headers: t.colHeaders, cells: t.cells },
              });
            }
          } catch (err) {
            console.warn(`[doc_tables] Failed to parse ${f.name} at upload:`, err);
          }
        }
      }

      console.info(`[doc_tables] docIdByName keys: ${Object.keys(docIdByName).join(", ")}; files: ${files.map(f=>f.name).join(", ")}; tablesPayload count: ${tablesPayload.length}`);
      if (tablesPayload.length > 0) {
        try {
          await saveDocTablesApi({ tables: tablesPayload });
          console.info(`[doc_tables] Saved ${tablesPayload.length} table(s) at upload time for doc IDs: ${[...new Set(tablesPayload.map(t=>t.documentId))].join(", ")}`);
        } catch (err) {
          console.error("[doc_tables] Failed to save structured tables at upload:", err);
        }
      } else {
        console.warn(`[doc_tables] No tables extracted. Excel/CSV files found: ${files.filter(f => /\.(xlsx|xls|xlsm|csv)$/i.test(f.name)).map(f=>f.name).join(", ") || "none"}`);
      }
    },
    [dealId, docs, saveDocumentApi, saveDocTablesApi, indexDocumentChunks]
  );

  const handleDeleteDoc = useCallback(async (docId: string) => {
    setDocs((prev) => {
      const doc = prev.find((d) => d.id === docId);
      if (doc) {
        setUploadedFiles((uf) => {
          const idx = uf.findIndex((f) => f.name === doc.file_name);
          if (idx >= 0) return uf.filter((_, i) => i !== idx);
          return uf;
        });
      }
      return prev.filter((d) => d.id !== docId);
    });
    // Invalidate caches
    chunksCache.current = null;
    chunksCacheKey.current = "";
    coverageRef.current = null;
    universalExtractionsCache.current = null;
    universalExtractionsCacheKey.current = "";
    docTablesCacheKey.current = "";
    docIdsForVerification.current = [];

    try {
      await deleteDocumentApi({ documentId: docId });
    } catch (err) {
      console.error("Failed to delete document:", err);
    }
    toast.success("Document deleted");
  }, [deleteDocumentApi]);

  const handleUpdateDocTag = useCallback(
    (docId: string, tag: DocumentTag) => {
      setDocs((prev) =>
        prev.map((d) => (d.id === docId ? { ...d, document_tag: tag } : d))
      );
    // Re-tag cached universal extractions so routing picks up the new tag
    // (No need to re-extract — only the tag assignment changes)
    if (universalExtractionsCache.current) {
      const updatedDoc = docs.find((d) => d.id === docId);
      if (updatedDoc) {
        universalExtractionsCache.current = universalExtractionsCache.current.map((ext) =>
          ext.sourceFile === updatedDoc.file_name
            ? { ...ext, documentTag: tag }
            : ext
        );
      }
    }
    // Persist to DB — find current source to pass along
    const doc = docs.find((d) => d.id === docId);
    updateDocumentApi({
      documentId: docId,
      documentTag: tag,
      documentSource: doc?.document_source ?? "sellside",
    }).catch((err: unknown) =>
      console.error("Failed to update document tag:", err)
    );
    },
    [updateDocumentApi, docs]
  );

  const handleUpdateDocSource = useCallback(
    (docId: string, source: DocumentSource) => {
      setDocs((prev) =>
        prev.map((d) => (d.id === docId ? { ...d, document_source: source } : d))
      );
      // Persist to DB — find current tag to pass along
      const doc = docs.find((d) => d.id === docId);
      updateDocumentApi({
        documentId: docId,
        documentTag: doc?.document_tag ?? "other",
        documentSource: source,
      }).catch((err: unknown) =>
        console.error("Failed to update document source:", err)
      );
    },
    [updateDocumentApi, docs]
  );

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  const historyModuleDef = useMemo(
    () =>
      historyModule
        ? MODULE_DEFINITIONS.find((m) => m.id === historyModule)
        : undefined,
    [historyModule]
  );

  const [historyRuns, setHistoryRuns] = useState<Array<{
    id: string;
    module_id: string;
    status: string;
    isCancelled?: boolean;
    triggered_at: string;
    completed_at: string | null;
    finding_count: number;
    critical_count: number;
  }>>([]);

  useEffect(() => {
    if (historyModule && dealId) {
      getRunHistoryApi({ dealId }).then((result) => {
        if (result) {
          setHistoryRuns(
            result.runs
              .filter((r: { module_id: string }) => r.module_id === historyModule)
              .map((r: Record<string, unknown>) => ({
                ...r,
                isCancelled: (r as { is_cancelled?: boolean }).is_cancelled ?? false,
              })) as typeof historyRuns
          );
        }
      }).catch(() => setHistoryRuns([]));
    } else {
      setHistoryRuns([]);
    }
  }, [historyModule, dealId, getRunHistoryApi]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (dealLoading) {
    return (
      <div className="flex items-center justify-center h-full bg-ic-dark">
        <div className="w-8 h-8 border-2 border-ic-turquoise border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!deal || dealError) {
    return (
      <div className="flex items-center justify-center h-full bg-ic-dark">
        <div className="text-center">
          <p className="text-ic-muted text-sm mb-4">Deal not found</p>
          <button
            onClick={() => navigate("/")}
            className="text-ic-turquoise text-sm hover:underline cursor-pointer"
          >
            Back to deals
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-screen bg-ic-dark overflow-hidden">
      {/* Sidebar */}
      <Sidebar
        deal={deal}
        documents={docs}
        completedModules={completedModules}
        totalModules={MODULE_DEFINITIONS.length}
        selectedSubjectIds={selectedSubjectIds}
        onSubjectSelectionChange={setSelectedSubjectIds}
        onUpload={handleUpload}
        onDeleteDoc={handleDeleteDoc}
        onUpdateTag={handleUpdateDocTag}
        onUpdateSource={handleUpdateDocSource}
        onBack={() => navigate("/")}
        onReparse={() => setShowReparseModal(true)}
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-auto">
        <DashboardHeader
          dealName={deal.name}
          status={deal.status}
          useOpus={useOpus}
          onToggleOpus={setUseOpus}
          onRunAll={() => setShowRunAll(true)}
          onBack={() => navigate("/")}
          disableRunAll={!canRunAnalysis}
          disableReason={runDisabledReason}
        />

        <div className="flex-1 px-8 py-8 space-y-8">
          <StatsRow
            documentCount={stats.documents}
            modulesComplete={stats.modulesComplete}
            totalModules={stats.totalModules}
            totalFindings={stats.totalFindings}
            criticalFindings={stats.criticalFindings}
          />

          {stats.criticalFindings > 0 && (
            <AlertBanner count={stats.criticalFindings} />
          )}

          <ModuleGrid
            moduleStatuses={statuses}
            runningModules={runningModules}
            analysisProgressMap={progressMap}
            onRunModule={handleRunModule}
            onCancelModule={handleCancelModule}
            onViewHistory={setHistoryModule}
            disableAnalysis={!canRunAnalysis}
            disableReason={runDisabledReason}
          />

          <QAPanel
            dealId={dealId!}
            dealName={deal.name}
            dealSector={deal.sector ?? null}
            hasDocuments={docs.length > 0}
          />
        </div>
      </div>

      {/* Modals */}
      <RunAllModal
        open={showRunAll}
        onClose={() => setShowRunAll(false)}
        onConfirm={handleRunAll}
        completedModules={completedModules}
      />

      {historyModule && historyModuleDef && (
        <RunHistory
          open
          onClose={() => setHistoryModule(null)}
          moduleTitle={historyModuleDef.displayName}
          runs={historyRuns as unknown as import("@/types/module").ModuleRun[]}
        />
      )}

      {rerunModal && (
        <RerunSuggestionModal
          open
          onClose={() => setRerunModal(null)}
          suggestedModuleIds={rerunModal.suggestedIds}
          uploadedFileNames={rerunModal.fileNames}
          onConfirm={(selectedIds) => {
            setRerunModal(null);
            for (const moduleId of selectedIds) {
              handleRunModule(moduleId);
            }
          }}
        />
      )}

      <ReparseDocumentsModal
        open={showReparseModal}
        onClose={() => setShowReparseModal(false)}
        dealId={dealId ?? ""}
        existingDocuments={docs.map((d) => ({ id: d.id, file_name: d.file_name }))}
        onCommitComplete={() => refetchDocs()}
      />
    </div>
  );
}
