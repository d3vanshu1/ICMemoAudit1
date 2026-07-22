import { FileText, AlertCircle } from "lucide-react";
import type { Document } from "@/types/document";

interface SubjectSelectorProps {
  documents: Document[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
}

/**
 * Selector for choosing which IC memo(s) are the "subject under review".
 * Only shows ic_memo-tagged documents as candidates.
 * Required before running omission_audit, blind_spot_scanner, etc.
 */
export default function SubjectSelector({
  documents,
  selectedIds,
  onSelectionChange,
}: SubjectSelectorProps) {
  // Only ic_memo-tagged docs can be subjects
  const icMemos = documents.filter((d) => d.document_tag === "ic_memo");

  if (icMemos.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-ic-border/50 bg-ic-surface-light/50 px-4 py-2.5">
        <AlertCircle className="w-3.5 h-3.5 text-ic-coral flex-shrink-0" />
        <span className="text-xs text-ic-muted font-light">
          No documents tagged as <em>IC Memo</em>. Tag your IC memos using the document type dropdown in the file list, then select them here to run analysis.
        </span>
      </div>
    );
  }

  const toggleMemo = (id: string) => {
    if (selectedIds.includes(id)) {
      onSelectionChange(selectedIds.filter((sid) => sid !== id));
    } else {
      onSelectionChange([...selectedIds, id]);
    }
  };

  return (
    <div className="rounded-lg border border-ic-border/50 bg-ic-surface-light/30 px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <FileText className="w-3.5 h-3.5 text-ic-turquoise" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-ic-muted">
          IC memo record under review
        </span>
        {selectedIds.length === 0 && (
          <span className="text-[10px] text-ic-coral font-light ml-1">
            — select at least one before running
          </span>
        )}
        {icMemos.length > 0 && selectedIds.length < icMemos.length && (
          <button
            type="button"
            onClick={() => onSelectionChange(icMemos.map((m) => m.id))}
            className="text-[10px] text-ic-turquoise hover:text-ic-turquoise/80 font-light ml-auto cursor-pointer transition-colors"
          >
            Select all IC memos
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {icMemos.map((memo) => {
          const isSelected = selectedIds.includes(memo.id);
          return (
            <button
              key={memo.id}
              type="button"
              onClick={() => toggleMemo(memo.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-light transition-all border cursor-pointer ${
                isSelected
                  ? "bg-ic-turquoise/15 border-ic-turquoise/50 text-ic-turquoise"
                  : "bg-ic-surface border-ic-border/50 text-ic-muted hover:border-ic-turquoise/30 hover:text-ic-text"
              }`}
              title={memo.file_name}
            >
              <div
                className={`w-3 h-3 rounded-sm border flex items-center justify-center transition-all ${
                  isSelected ? "bg-ic-turquoise border-ic-turquoise" : "border-ic-muted/30"
                }`}
              >
                {isSelected && (
                  <svg className="w-2 h-2 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
              <span className="truncate max-w-[200px]">{memo.file_name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
