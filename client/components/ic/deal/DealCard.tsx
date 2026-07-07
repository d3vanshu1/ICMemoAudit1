import { FileText, CheckCircle2, Trash2 } from "lucide-react";
import type { Deal } from "@/types/deal";

interface DealCardProps {
  deal: Deal;
  moduleProgress: { completed: number; total: number };
  onClick: () => void;
  onDelete: () => void;
}

export default function DealCard({ deal, moduleProgress, onClick, onDelete }: DealCardProps) {
  const { completed, total } = moduleProgress;

  return (
    <div
      onClick={onClick}
      className="relative w-full text-left p-5 rounded-xl border border-ic-border
        bg-ic-surface hover:bg-gradient-to-br hover:from-ic-surface-light/60 hover:via-ic-surface hover:to-ic-surface
        hover:border-ic-soft-gray/40 hover:shadow-lg hover:shadow-black/20
        hover:translate-y-[-1px] transition-all duration-200 group cursor-pointer"
    >
      {/* Delete */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute top-3 right-3 p-1.5 rounded-md text-ic-muted
          hover:text-ic-coral hover:bg-ic-surface-light
          opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
        title="Delete deal"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>

      <div className="flex items-start justify-between mb-3 pr-8">
        <h3 className="text-base font-bold text-ic-text tracking-tight">
          {deal.name}
        </h3>
      </div>

      {deal.sector && (
        <span className="inline-flex items-center gap-1.5 text-[10px] text-ic-muted bg-ic-surface-light px-2.5 py-0.5 rounded-full mb-2">
          <span className="w-1.5 h-1.5 rounded-full bg-ic-turquoise" />
          {deal.sector}
        </span>
      )}

      {deal.description && (
        <p className="text-xs text-ic-muted font-light mb-3 line-clamp-2 leading-relaxed">{deal.description}</p>
      )}

      <div className="flex items-center gap-4 text-xs text-ic-muted font-light">
        <div className="flex items-center gap-1.5">
          <FileText className="w-3.5 h-3.5" />
          <span>{deal.document_count} docs</span>
        </div>

        <div className="flex items-center gap-1.5">
          {completed > 0 ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-ic-turquoise" />
              <span>{completed}/{total} complete</span>
            </>
          ) : (
            <span className="text-ic-muted/50">Not started</span>
          )}
        </div>
      </div>

      {completed > 0 && (
        <div className="mt-3 h-1 bg-ic-surface-light rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-ic-turquoise to-ic-turquoise/70 rounded-full transition-all duration-500"
            style={{ width: `${(completed / total) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
