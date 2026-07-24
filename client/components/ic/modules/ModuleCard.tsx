import { useState } from "react";
import {
  Play,
  RotateCcw,
  Eye,
  History,
  SearchX,
  GitCompareArrows,
  EyeOff,
  Globe,
  MessageSquareWarning,
  TrendingDown,
  ClipboardCheck,
  FileText,
  Users,
  Loader2,
  XCircle,
} from "lucide-react";
import type { ModuleDefinition } from "@/lib/moduleConfig";
import type { ModuleStatus } from "@/types/module";
import type { AnalysisProgress } from "./ModuleGrid";
import ICBadge from "../ui/ICBadge";
import ICButton from "../ui/ICButton";
import ModuleOutput from "./ModuleOutput";

interface ModuleCardProps {
  definition: ModuleDefinition;
  status: ModuleStatus | null;
  isRunning?: boolean;
  analysisProgress?: AnalysisProgress;
  onRun: () => void;
  onCancel: () => void;
  onViewHistory: () => void;
  /** Externally disable the Run button (e.g. no subject/evidence selected) */
  disabled?: boolean;
  disabledReason?: string;
}

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  SearchX,
  GitCompareArrows,
  EyeOff,
  Globe,
  MessageSquareWarning,
  TrendingDown,
  ClipboardCheck,
  FileText,
  Users,
};

export default function ModuleCard({
  definition,
  status,
  isRunning = false,
  analysisProgress,
  onRun,
  onCancel,
  onViewHistory,
  disabled = false,
  disabledReason,
}: ModuleCardProps) {
  const [showOutput, setShowOutput] = useState(false);
  const hasOutput = status?.latestOutput != null;
  const isComplete = status?.latestRun?.status === "completed";
  const Icon = ICON_MAP[definition.iconName] ?? FileText;

  const severityCounts = hasOutput
    ? {
        critical: status!.latestOutput!.findings.filter((f) => f.severity === "critical").length,
        warning: status!.latestOutput!.findings.filter((f) => f.severity === "warning").length,
        info: status!.latestOutput!.findings.filter((f) => f.severity === "info").length,
      }
    : null;

  return (
    <div
      className={`relative rounded-xl border transition-all duration-200 overflow-hidden
        hover:translate-y-[-1px] hover:shadow-lg hover:shadow-black/20
        ${
          isComplete
            ? "border-ic-turquoise/20 bg-ic-surface"
            : "border-ic-border bg-ic-surface hover:border-ic-soft-gray/40"
        }`}
    >
      {/* Left accent bar for completed modules */}
      {isComplete && (
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-ic-turquoise via-ic-turquoise/80 to-ic-turquoise/40" />
      )}

      <div className={`p-5 ${isComplete ? "pl-6" : ""}`}>
        {/* Header */}
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-3">
            <div
              className={`p-2 rounded-lg transition-colors ${
                isComplete
                  ? "bg-ic-turquoise/10 text-ic-turquoise"
                  : isRunning
                    ? "bg-ic-turquoise/5 text-ic-turquoise animate-pulse"
                    : "bg-ic-surface-light text-ic-muted"
              }`}
            >
              <Icon className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-bold text-ic-text leading-tight">
              {definition.displayName}
            </h3>
          </div>
        </div>

        {/* Description */}
        <p className="text-xs text-ic-muted font-light leading-relaxed mb-3">
          {definition.description}
        </p>

        {/* Running state with live progress */}
        {isRunning && (
          <div className="py-2 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Loader2 className="w-4 h-4 text-ic-turquoise animate-spin" />
                <span className="text-xs text-ic-turquoise font-bold">
                  {analysisProgress?.message ?? "Running analysis…"}
                </span>
              </div>
              <button
                onClick={onCancel}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold text-ic-coral hover:bg-ic-coral/10 transition-colors"
                title="Cancel this run"
              >
                <XCircle className="w-3.5 h-3.5" />
                Cancel
              </button>
            </div>
            {analysisProgress?.detail && analysisProgress.detail.phase === "analyzing" && (
              <ProgressBar
                current={analysisProgress.detail.current}
                total={analysisProgress.detail.total}
                color="bg-ic-turquoise"
                label="Chunk"
              />
            )}
            {analysisProgress?.detail?.phase === "researching" && (
              <ProgressBar
                current={analysisProgress.detail.current}
                total={analysisProgress.detail.total}
                color="bg-amber-500"
                label="Research iteration"
              />
            )}
            {analysisProgress?.detail?.phase === "synthesizing" && (
              <ProgressBar
                current={analysisProgress.detail.current}
                total={analysisProgress.detail.total}
                color="bg-ic-coral"
                label="Synthesis step"
              />
            )}
            {analysisProgress?.chunkErrors && analysisProgress.chunkErrors.length > 0 && (
              <p className="text-[10px] text-ic-coral mt-1">
                {analysisProgress.chunkErrors.length} chunk error(s) — partial results will be used
              </p>
            )}
          </div>
        )}

        {/* Idle state — no run yet, or cancelled/failed */}
        {!isComplete && !isRunning && (
          <div>
            {status?.latestRun?.isCancelled && (
              <p className="text-[10px] text-ic-coral/80 font-light mb-1.5">Last run was cancelled</p>
            )}
            <ICButton size="sm" onClick={onRun} disabled={disabled}>
              <Play className="w-3.5 h-3.5" />
              Run Analysis
            </ICButton>
            {disabled && disabledReason && (
              <p className="text-[10px] text-ic-coral/80 font-light mt-1.5">{disabledReason}</p>
            )}
          </div>
        )}

        {/* Completed state */}
        {isComplete && hasOutput && (
          <div className="space-y-3">
            {/* Executive summary — suppress if it's just an error message */}
            {status!.latestOutput!.executive_header &&
              !/^(merge|analysis|extraction|pipeline)\s*(failed|error)/i.test(status!.latestOutput!.executive_header.trim()) && (
              <p className="text-xs text-ic-text/75 font-light leading-relaxed line-clamp-3">
                {status!.latestOutput!.executive_header}
              </p>
            )}

            {/* Severity badges */}
            {severityCounts && (
              <div className="flex flex-wrap gap-1.5">
                {severityCounts.critical > 0 && (
                  <ICBadge variant="critical">
                    {severityCounts.critical} Critical
                  </ICBadge>
                )}
                {severityCounts.warning > 0 && (
                  <ICBadge variant="warning">
                    {severityCounts.warning} Warning
                  </ICBadge>
                )}
                {severityCounts.info > 0 && (
                  <ICBadge variant="info">
                    {severityCounts.info} Info
                  </ICBadge>
                )}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-2">
              <ICButton
                variant="secondary"
                size="sm"
                onClick={() => setShowOutput(!showOutput)}
              >
                <Eye className="w-3.5 h-3.5" />
                {showOutput ? "Hide" : "Details"}
              </ICButton>
              <ICButton variant="ghost" size="sm" onClick={onRun} disabled={isRunning || disabled}>
                {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                {isRunning ? "Running…" : "Re-run"}
              </ICButton>
              <ICButton variant="ghost" size="sm" onClick={onViewHistory}>
                <History className="w-3.5 h-3.5" />
                History
              </ICButton>
            </div>
          </div>
        )}
      </div>

      {/* Expandable output */}
      {showOutput && hasOutput && (
        <div className="px-5 pb-5 border-t border-ic-border/50 pt-4">
          <ModuleOutput output={status!.latestOutput!} />
        </div>
      )}
    </div>
  );
}

/** Reusable mini progress bar */
function ProgressBar({
  current,
  total,
  color,
  label,
}: {
  current: number;
  total: number;
  color: string;
  label: string;
}) {
  return (
    <div className="space-y-1">
      <div className="w-full bg-ic-surface-light rounded-full h-1.5 overflow-hidden">
        <div
          className={`${color} h-1.5 rounded-full transition-all duration-500`}
          style={{ width: `${(current / total) * 100}%` }}
        />
      </div>
      <p className="text-[10px] text-ic-muted font-light">
        {label} {current} of {total}
      </p>
    </div>
  );
}
