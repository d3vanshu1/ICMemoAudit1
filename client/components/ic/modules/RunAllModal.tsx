import ICModal from "../ui/ICModal";
import ICButton from "../ui/ICButton";
import { MODULE_DEFINITIONS } from "@/lib/moduleConfig";
import { CheckCircle2, Circle } from "lucide-react";

interface RunAllModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  completedModules: string[];
}

export default function RunAllModal({
  open,
  onClose,
  onConfirm,
  completedModules,
}: RunAllModalProps) {
  const pendingModules = MODULE_DEFINITIONS.filter(
    (m) => !completedModules.includes(m.id)
  );
  const completedList = MODULE_DEFINITIONS.filter((m) =>
    completedModules.includes(m.id)
  );

  return (
    <ICModal open={open} onClose={onClose} title="Run All Modules">
      <div className="space-y-4">
        <p className="text-sm text-ic-muted">
          This will launch all incomplete analysis modules simultaneously. Executive Summary will run automatically after all other modules complete.
        </p>

        {pendingModules.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-ic-muted uppercase tracking-wide mb-2">
              Will Run ({pendingModules.length})
            </h4>
            <ul className="space-y-1">
              {pendingModules.map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-sm text-ic-text">
                  <Circle className="w-3.5 h-3.5 text-ic-muted" />
                  {m.displayName}
                </li>
              ))}
            </ul>
          </div>
        )}

        {completedList.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-ic-muted uppercase tracking-wide mb-2">
              Already Complete ({completedList.length})
            </h4>
            <ul className="space-y-1">
              {completedList.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center gap-2 text-sm text-ic-muted"
                >
                  <CheckCircle2 className="w-3.5 h-3.5 text-ic-turquoise" />
                  {m.displayName}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <ICButton variant="ghost" onClick={onClose}>
            Cancel
          </ICButton>
          <ICButton onClick={onConfirm} disabled={pendingModules.length === 0}>
            Run {pendingModules.length} Module{pendingModules.length !== 1 ? "s" : ""}
          </ICButton>
        </div>
      </div>
    </ICModal>
  );
}
