import { useState, useRef, useCallback, useMemo, type DragEvent, type ChangeEvent } from "react";
import { Upload, FileText, CheckCircle, AlertTriangle, RefreshCw, Eye, X } from "lucide-react";
import { toast } from "sonner";
import { useApi } from "@/hooks/useApi.js";
import { extractTextFromFile } from "@/lib/pdfProcessor";
import ICModal from "../ui/ICModal";
import ICButton from "../ui/ICButton";
import ICSpinner from "../ui/ICSpinner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExistingDocument {
  id: string;
  file_name: string;
}

/** Per-file status during the re-parse workflow */
interface ReparseFileState {
  file: File;
  /** Matched document from the DB (by filename) */
  matchedDoc: ExistingDocument | null;
  /** Status of parsing */
  parseStatus: "pending" | "parsing" | "parsed" | "error";
  /** New parsed text (after spatial-clustering fix) */
  newText: string | null;
  /** Error message if parsing failed */
  error: string | null;
  /** Whether this file's updated text has been written to DB */
  committed: boolean;
  /** True if parsed_text was written but re-index failed (half-applied state) */
  needsReindex: boolean;
}

interface ReparseDocumentsModalProps {
  open: boolean;
  onClose: () => void;
  /** Deal ID — needed for re-indexing and extraction purge */
  dealId: string;
  /** Current documents in this deal (from DB) */
  existingDocuments: ExistingDocument[];
  /** Called after successful commit so parent can refetch */
  onCommitComplete?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ReparseDocumentsModal({
  open,
  onClose,
  dealId,
  existingDocuments,
  onCommitComplete,
}: ReparseDocumentsModalProps) {
  const [fileStates, setFileStates] = useState<ReparseFileState[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [committing, setCommitting] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeComplete, setPurgeComplete] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  const { run: updateParsedText } = useApi("UpdateParsedText");
  const { run: indexDocumentChunks } = useApi("IndexDocumentChunks");
  const { run: purgeDocumentExtractions } = useApi("PurgeDocumentExtractions");

  // -------------------------------------------------------------------------
  // File selection
  // -------------------------------------------------------------------------

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const validExts = new Set(["pdf"]);
      const incoming = Array.from(files).filter((f) => {
        const ext = f.name.toLowerCase().split(".").pop() ?? "";
        return validExts.has(ext);
      });

      if (incoming.length === 0) {
        toast.info("Only PDF files can be re-parsed (Excel/CSV text is already structured).");
        return;
      }

      const newStates: ReparseFileState[] = incoming.map((file) => {
        const matched = existingDocuments.find(
          (d) => d.file_name === file.name
        ) ?? null;
        return {
          file,
          matchedDoc: matched,
          parseStatus: "pending" as const,
          newText: null,
          error: null,
          committed: false,
          needsReindex: false,
        };
      });

      setFileStates((prev) => [...prev, ...newStates]);
    },
    [existingDocuments]
  );

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  };
  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setDragActive(false);
  };
  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeFile = useCallback((index: number) => {
    setFileStates((prev) => prev.filter((_, i) => i !== index));
    setPreviewIndex(null);
  }, []);

  // -------------------------------------------------------------------------
  // Parse all files (client-side, using new extractPageText)
  // -------------------------------------------------------------------------

  const parseAll = useCallback(async () => {
    const pending = fileStates.filter(
      (s) => s.parseStatus === "pending" && s.matchedDoc
    );
    if (pending.length === 0) {
      toast.info("No matched files to parse. Ensure filenames match existing documents.");
      return;
    }

    for (let i = 0; i < fileStates.length; i++) {
      const state = fileStates[i];
      if (state.parseStatus !== "pending" || !state.matchedDoc) continue;

      setFileStates((prev) =>
        prev.map((s, idx) =>
          idx === i ? { ...s, parseStatus: "parsing" as const } : s
        )
      );

      try {
        const text = await extractTextFromFile(state.file);
        setFileStates((prev) =>
          prev.map((s, idx) =>
            idx === i
              ? { ...s, parseStatus: "parsed" as const, newText: text }
              : s
          )
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setFileStates((prev) =>
          prev.map((s, idx) =>
            idx === i
              ? { ...s, parseStatus: "error" as const, error: msg }
              : s
          )
        );
      }
    }

    toast.success("Parsing complete — review the results before committing.");
  }, [fileStates]);

  // -------------------------------------------------------------------------
  // Commit parsed text to DB
  // -------------------------------------------------------------------------

  const commitAll = useCallback(async () => {
    const ready = fileStates.filter(
      (s) => s.parseStatus === "parsed" && s.matchedDoc && !s.committed
    );
    if (ready.length === 0) return;

    setCommitting(true);
    let successCount = 0;

    for (let i = 0; i < fileStates.length; i++) {
      const state = fileStates[i];
      if (state.parseStatus !== "parsed" || !state.matchedDoc || state.committed || !state.newText) continue;

      try {
        // 1. Update parsed_text in documents table
        if (!state.needsReindex) {
          await updateParsedText({
            documentId: state.matchedDoc.id,
            parsedText: state.newText,
          });
        }

        // 2. Re-index document_chunks so Q&A, checklist-scan, and
        //    absence-verification all search the corrected text
        try {
          await indexDocumentChunks({
            documentId: state.matchedDoc.id,
            dealId,
            fileName: state.file.name,
            parsedText: state.newText,
          });
        } catch (reindexErr) {
          // parsed_text written but chunks stale — flag for retry
          setFileStates((prev) =>
            prev.map((s, idx) => (idx === i ? { ...s, needsReindex: true } : s))
          );
          const msg = reindexErr instanceof Error ? reindexErr.message : String(reindexErr);
          toast.error(`"${state.file.name}": parsed_text saved but re-index failed (retry available): ${msg}`);
          continue;
        }

        successCount++;
        setFileStates((prev) =>
          prev.map((s, idx) => (idx === i ? { ...s, committed: true, needsReindex: false } : s))
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Failed to update "${state.file.name}": ${msg}`);
      }
    }

    setCommitting(false);
    if (successCount > 0) {
      toast.success(
        `Updated parsed_text + re-indexed chunks for ${successCount} document${successCount > 1 ? "s" : ""}. ` +
        `Purge stale extractions below to complete the refresh.`
      );
      onCommitComplete?.();
    }
  }, [fileStates, updateParsedText, indexDocumentChunks, dealId, onCommitComplete]);

  // -------------------------------------------------------------------------
  // Purge stale extractions for committed documents
  // -------------------------------------------------------------------------

  const handlePurgeExtractions = useCallback(async () => {
    const committedDocIds = fileStates
      .filter((s) => s.committed && s.matchedDoc)
      .map((s) => s.matchedDoc!.id);

    if (committedDocIds.length === 0) return;

    setPurging(true);
    try {
      const result = await purgeDocumentExtractions({ documentIds: committedDocIds });
      const count = result?.extractionsDeleted ?? 0;
      setPurgeComplete(true);
      toast.success(
        `Purged ${count} stale extraction${count !== 1 ? "s" : ""} for ${committedDocIds.length} document${committedDocIds.length > 1 ? "s" : ""}. ` +
        `Next pipeline run will re-extract from the improved text.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Purge failed: ${msg}`);
    }
    setPurging(false);
  }, [fileStates, purgeDocumentExtractions]);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  const matchedCount = useMemo(
    () => fileStates.filter((s) => s.matchedDoc).length,
    [fileStates]
  );
  const unmatchedCount = useMemo(
    () => fileStates.filter((s) => !s.matchedDoc).length,
    [fileStates]
  );
  const parsedCount = useMemo(
    () => fileStates.filter((s) => s.parseStatus === "parsed").length,
    [fileStates]
  );
  const committedCount = useMemo(
    () => fileStates.filter((s) => s.committed).length,
    [fileStates]
  );
  const needsRetryCount = useMemo(
    () => fileStates.filter((s) => s.needsReindex && !s.committed).length,
    [fileStates]
  );
  const isParsing = useMemo(
    () => fileStates.some((s) => s.parseStatus === "parsing"),
    [fileStates]
  );

  // -------------------------------------------------------------------------
  // Preview panel
  // -------------------------------------------------------------------------

  const previewState = previewIndex !== null ? fileStates[previewIndex] : null;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <ICModal
      open={open}
      onClose={onClose}
      title="Re-parse Documents"
      maxWidth="max-w-4xl"
    >
      <div className="space-y-4">
        {/* Instructions */}
        <div className="text-xs text-ic-muted space-y-1">
          <p>
            Re-parse PDF documents using the improved spatial-clustering text extractor.
            Select the <strong>same PDF files</strong> you originally uploaded — they'll be matched
            to existing documents by filename.
          </p>
          <p className="text-ic-coral/80">
            ⚠ Review the parsed output before committing. Once committed, purge extractions
            and re-run the pipeline to regenerate findings from the improved text.
          </p>
        </div>

        {/* Drop zone */}
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => fileInputRef.current?.click()}
          className={`flex flex-col items-center justify-center py-4 px-3 border-2 border-dashed rounded-lg
            cursor-pointer transition-colors ${
              dragActive
                ? "border-ic-turquoise bg-ic-turquoise/10"
                : "border-ic-border hover:border-ic-soft-gray hover:bg-ic-surface-light/50"
            }`}
        >
          <Upload
            className={`w-5 h-5 mb-1.5 ${dragActive ? "text-ic-turquoise" : "text-ic-muted"}`}
          />
          <p className="text-xs text-ic-muted text-center">
            Drop PDF files or <span className="text-ic-turquoise">browse</span>
          </p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf"
          onChange={handleFileSelect}
          className="hidden"
        />

        {/* File list */}
        {fileStates.length > 0 && (
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {fileStates.map((state, index) => (
              <div
                key={`${state.file.name}-${index}`}
                className="flex items-center gap-2 p-2 bg-ic-surface-light rounded-md border border-ic-border"
              >
                <FileText className="w-3.5 h-3.5 text-ic-muted flex-shrink-0" />
                <span className="text-xs text-ic-text/80 truncate flex-1" title={state.file.name}>
                  {state.file.name}
                </span>

                {/* Match indicator */}
                {state.matchedDoc ? (
                  <span className="text-[10px] text-ic-turquoise">matched</span>
                ) : (
                  <span className="text-[10px] text-ic-coral" title="No matching document found by filename">
                    unmatched
                  </span>
                )}

                {/* Parse status */}
                {state.parseStatus === "parsing" && (
                  <ICSpinner size="sm" />
                )}
                {state.parseStatus === "parsed" && !state.committed && (
                  <CheckCircle className="w-3.5 h-3.5 text-green-400" />
                )}
                {state.committed && (
                  <span className="text-[10px] font-bold text-ic-turquoise">saved</span>
                )}
                {state.needsReindex && !state.committed && (
                  <span className="text-[10px] font-bold text-ic-coral" title="parsed_text written but re-index failed — retry via Commit">
                    needs retry
                  </span>
                )}
                {state.parseStatus === "error" && (
                  <span title={state.error ?? ""}>
                    <AlertTriangle className="w-3.5 h-3.5 text-ic-coral" />
                  </span>
                )}

                {/* Preview button */}
                {state.parseStatus === "parsed" && (
                  <button
                    onClick={() => setPreviewIndex(index)}
                    className="p-0.5 text-ic-muted hover:text-ic-turquoise transition-colors cursor-pointer"
                    title="Preview parsed text"
                  >
                    <Eye className="w-3.5 h-3.5" />
                  </button>
                )}

                {/* Remove */}
                {!state.committed && (
                  <button
                    onClick={() => removeFile(index)}
                    className="p-0.5 text-ic-muted hover:text-ic-text transition-colors cursor-pointer"
                    aria-label="Remove file"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Summary stats */}
        {fileStates.length > 0 && (
          <div className="flex items-center gap-4 text-[11px] text-ic-muted">
            <span>{matchedCount} matched</span>
            {unmatchedCount > 0 && (
              <span className="text-ic-coral">{unmatchedCount} unmatched</span>
            )}
            {parsedCount > 0 && (
              <span className="text-green-400">{parsedCount} parsed</span>
            )}
            {committedCount > 0 && (
              <span className="text-ic-turquoise">{committedCount} saved</span>
            )}
          </div>
        )}

        {/* Action buttons */}
        {fileStates.length > 0 && (
          <div className="flex items-center gap-3">
            <ICButton
              size="sm"
              variant="secondary"
              onClick={parseAll}
              loading={isParsing}
              disabled={matchedCount === 0 || isParsing}
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Parse All ({matchedCount} files)
            </ICButton>

            {(parsedCount > committedCount || needsRetryCount > 0) && (
              <ICButton
                size="sm"
                variant="primary"
                onClick={commitAll}
                loading={committing}
                disabled={committing}
              >
                {needsRetryCount > 0
                  ? `Retry Re-index (${needsRetryCount} failed)`
                  : `Commit to DB (${parsedCount - committedCount} files)`}
              </ICButton>
            )}

            {committedCount > 0 && !purgeComplete && (
              <ICButton
                size="sm"
                variant="secondary"
                onClick={handlePurgeExtractions}
                loading={purging}
                disabled={purging}
              >
                Purge Stale Extractions ({committedCount} docs)
              </ICButton>
            )}

            {purgeComplete && (
              <span className="text-[11px] text-ic-turquoise font-bold">
                ✓ Extractions purged — next pipeline run will use corrected text
              </span>
            )}
          </div>
        )}

        {/* Preview panel */}
        {previewState && previewState.newText && (
          <div className="mt-4 border border-ic-border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 bg-ic-surface-light border-b border-ic-border">
              <span className="text-xs font-bold text-ic-text">
                Preview: {previewState.file.name}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-ic-muted">
                  {previewState.newText.length.toLocaleString()} chars
                </span>
                <button
                  onClick={() => setPreviewIndex(null)}
                  className="p-0.5 text-ic-muted hover:text-ic-text transition-colors cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <pre className="p-3 text-[11px] text-ic-text/80 max-h-64 overflow-auto whitespace-pre-wrap font-mono leading-relaxed bg-ic-dark/50">
              {previewState.newText.slice(0, 20_000)}
              {previewState.newText.length > 20_000 && (
                <span className="text-ic-muted italic">
                  {"\n\n"}[…truncated — showing first 20,000 of {previewState.newText.length.toLocaleString()} chars]
                </span>
              )}
            </pre>
          </div>
        )}
      </div>
    </ICModal>
  );
}
