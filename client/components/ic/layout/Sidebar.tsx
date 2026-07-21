import { ArrowLeft, CheckCircle2, Circle, RefreshCw } from "lucide-react";
import type { Deal } from "@/types/deal";
import type { Document, DocumentTag, DocumentSource } from "@/types/document";
import { MODULE_DEFINITIONS } from "@/lib/moduleConfig";
import DealMetadata from "../deal/DealMetadata";
import DocumentList from "../documents/DocumentList";
import DocumentUpload from "../documents/DocumentUpload";
import SubjectSelector from "../analysis/SubjectSelector";
import ICButton from "../ui/ICButton";

interface SidebarProps {
  deal: Deal;
  documents: Document[];
  completedModules: string[];
  totalModules: number;
  selectedSubjectIds: string[];
  onSubjectSelectionChange: (ids: string[]) => void;
  onUpload: (files: File[]) => void;
  onDeleteDoc: (docId: string) => void;
  onUpdateTag: (docId: string, tag: DocumentTag) => void;
  onUpdateSource: (docId: string, source: DocumentSource) => void;
  onBack: () => void;
  onReparse?: () => void;
}

export default function Sidebar({
  deal,
  documents,
  completedModules,
  totalModules,
  selectedSubjectIds,
  onSubjectSelectionChange,
  onUpload,
  onDeleteDoc,
  onUpdateTag,
  onUpdateSource,
  onBack,
  onReparse,
}: SidebarProps) {
  const progressPct = totalModules > 0 ? Math.round((completedModules.length / totalModules) * 100) : 0;

  return (
    <aside className="w-80 min-w-80 bg-ic-surface border-r border-ic-border flex flex-col h-full overflow-hidden">
      {/* Back button — pinned */}
      <button
        onClick={onBack}
        className="flex items-center gap-2 px-5 py-3 text-xs text-ic-muted hover:text-ic-turquoise
                   border-b border-ic-border transition-colors cursor-pointer flex-shrink-0"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        All Deals
      </button>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* Deal metadata in a card wrapper */}
        <div className="p-4 border-b border-ic-border">
          <div className="bg-ic-dark/50 rounded-xl p-4 border border-ic-border/50">
            <DealMetadata deal={deal} />
          </div>
        </div>

        {/* Subject Selector */}
        <div className="p-4 border-b border-ic-border">
          <SubjectSelector
            documents={documents}
            selectedIds={selectedSubjectIds}
            onSelectionChange={onSubjectSelectionChange}
          />
        </div>

        {/* Data Room */}
        <div className="p-4 border-b border-ic-border">
          <SectionHeader label="Data Room" count={documents.length} />
          <DocumentList
            documents={documents}
            onDelete={onDeleteDoc}
            onTagChange={onUpdateTag}
            onSourceChange={onUpdateSource}
          />
          <div className="mt-3 space-y-2">
            <DocumentUpload onUpload={onUpload} />
            {onReparse && documents.some((d) => d.file_type === "application/pdf" || d.file_name.toLowerCase().endsWith(".pdf")) && (
              <ICButton size="sm" variant="ghost" onClick={onReparse} className="w-full text-[10px]">
                <RefreshCw className="w-3 h-3" />
                Re-parse PDFs
              </ICButton>
            )}
          </div>
        </div>

        {/* Analysis Progress — timeline style */}
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <SectionHeader label="Analysis Progress" count={completedModules.length} total={totalModules} />
            <span className="text-[10px] text-ic-muted font-light">{progressPct}%</span>
          </div>

          {/* Mini progress bar */}
          <div className="w-full bg-ic-surface-light rounded-full h-1 mb-4 overflow-hidden">
            <div
              className="h-full bg-ic-turquoise rounded-full transition-all duration-700 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>

          {/* Timeline list */}
          <ul className="relative">
            {/* Connecting line */}
            <div className="absolute left-[7px] top-2 bottom-2 w-px bg-ic-border" />

            {MODULE_DEFINITIONS.map((mod, i) => {
              const isComplete = completedModules.includes(mod.id);
              const isLast = i === MODULE_DEFINITIONS.length - 1;
              return (
                <li key={mod.id} className={`relative flex items-center gap-3 ${isLast ? "" : "pb-3"}`}>
                  <div className="relative z-10 flex-shrink-0">
                    {isComplete ? (
                      <CheckCircle2 className="w-4 h-4 text-ic-turquoise" />
                    ) : (
                      <Circle className="w-4 h-4 text-ic-muted/30" />
                    )}
                  </div>
                  <span
                    className={`text-xs font-light leading-tight ${
                      isComplete ? "text-ic-text" : "text-ic-muted/60"
                    }`}
                  >
                    {mod.displayName}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </aside>
  );
}

/** Consistent section header */
function SectionHeader({ label, count, total }: { label: string; count?: number; total?: number }) {
  return (
    <h3 className="text-[10px] font-bold text-ic-muted uppercase tracking-[0.1em] mb-3">
      {label}
      {count != null && (
        <span className="text-ic-turquoise ml-1.5">
          ({total != null ? `${count}/${total}` : count})
        </span>
      )}
    </h3>
  );
}
