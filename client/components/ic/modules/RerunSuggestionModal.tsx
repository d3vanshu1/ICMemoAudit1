import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { MODULE_DEFINITIONS } from "@/lib/moduleConfig";
import ICModal from "../ui/ICModal";
import ICButton from "../ui/ICButton";

interface RerunSuggestionModalProps {
  open: boolean;
  onClose: () => void;
  suggestedModuleIds: string[];
  onConfirm: (selectedModuleIds: string[]) => void;
  uploadedFileNames: string[];
}

export default function RerunSuggestionModal({
  open,
  onClose,
  suggestedModuleIds,
  onConfirm,
  uploadedFileNames,
}: RerunSuggestionModalProps) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(suggestedModuleIds)
  );

  const toggle = (moduleId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(moduleId)) next.delete(moduleId);
      else next.add(moduleId);
      return next;
    });
  };

  const handleConfirm = () => {
    onConfirm(Array.from(selected));
    onClose();
  };

  // Only show modules that don't require prior modules (exclude exec summary)
  const selectableModules = MODULE_DEFINITIONS.filter((m) => !m.requiresPriorModules);

  return (
    <ICModal open={open} onClose={onClose} title="Re-run Analysis?">
      <div className="space-y-5">
        {/* Uploaded files summary */}
        <div>
          <p className="text-sm text-ic-text/80 mb-2">
            {uploadedFileNames.length} new document{uploadedFileNames.length > 1 ? "s" : ""} added:
          </p>
          <ul className="space-y-1 ml-1">
            {uploadedFileNames.map((name) => (
              <li
                key={name}
                className="text-xs text-ic-muted truncate flex items-center gap-2"
              >
                <span className="w-1 h-1 rounded-full bg-ic-turquoise flex-shrink-0" />
                {name}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-sm text-ic-muted leading-relaxed">
          New documents may change analysis results. Select which modules to re-run
          with the updated data room:
        </p>

        {/* Module checklist */}
        <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
          {selectableModules.map((mod) => {
            const isChecked = selected.has(mod.id);
            const isSuggested = suggestedModuleIds.includes(mod.id);

            return (
              <label
                key={mod.id}
                className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-all duration-150
                  ${
                    isChecked
                      ? "bg-ic-turquoise/10 border border-ic-turquoise/30"
                      : "bg-ic-surface-light/50 border border-transparent hover:border-ic-border"
                  }`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggle(mod.id)}
                  className="rounded border-ic-border bg-ic-dark text-ic-turquoise
                             focus:ring-ic-turquoise/50 focus:ring-offset-0 cursor-pointer accent-[#00b8c1]"
                />
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-ic-text">{mod.displayName}</span>
                  {isSuggested && (
                    <span className="ml-2 text-[10px] text-ic-turquoise font-bold uppercase tracking-wider">
                      Suggested
                    </span>
                  )}
                </div>
              </label>
            );
          })}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-3 border-t border-ic-border">
          <ICButton variant="ghost" size="sm" onClick={onClose}>
            Skip
          </ICButton>
          <ICButton
            size="sm"
            onClick={handleConfirm}
            disabled={selected.size === 0}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Re-run {selected.size} Module{selected.size !== 1 ? "s" : ""}
          </ICButton>
        </div>
      </div>
    </ICModal>
  );
}
