import type { ModuleRun } from "@/types/module";
import ICModal from "../ui/ICModal";
import ICBadge from "../ui/ICBadge";
import { formatRelativeTime } from "@/lib/formatters";

interface RunHistoryProps {
  open: boolean;
  onClose: () => void;
  moduleTitle: string;
  runs: ModuleRun[];
}

export default function RunHistory({
  open,
  onClose,
  moduleTitle,
  runs,
}: RunHistoryProps) {
  return (
    <ICModal open={open} onClose={onClose} title={`${moduleTitle} — Run History`}>
      <div className="space-y-3">
        {runs.length === 0 ? (
          <p className="text-sm text-ic-muted py-4 text-center">
            No previous runs found.
          </p>
        ) : (
          runs.map((run) => (
            <div
              key={run.id}
              className="flex items-center justify-between p-3 bg-ic-surface-light rounded-lg border border-ic-border"
            >
              <div>
                <div className="text-sm font-bold text-ic-text">
                  Run #{run.id.slice(0, 8)}
                </div>
                <div className="text-xs text-ic-muted mt-0.5">
                  {formatRelativeTime(run.completed_at ?? run.triggered_at)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <ICBadge variant={run.status === "completed" ? "success" : run.isCancelled ? "warning" : "default"}>
                  {run.isCancelled ? "Cancelled" : run.status}
                </ICBadge>
                {run.findings_count != null && (
                  <span className="text-xs text-ic-muted">
                    {run.findings_count} finding{run.findings_count !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </ICModal>
  );
}
