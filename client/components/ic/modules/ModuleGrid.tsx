import type { ModuleStatus } from "@/types/module";
import { MODULE_DEFINITIONS } from "@/lib/moduleConfig";
import ModuleCard from "./ModuleCard";

export interface AnalysisProgress {
  message: string | null;
  detail: { current: number; total: number; phase: "analyzing" | "synthesizing" | "researching" | "done" } | null;
  chunkErrors: string[];
}

interface ModuleGridProps {
  moduleStatuses: Record<string, ModuleStatus>;
  runningModules: Set<string>;
  analysisProgressMap: Record<string, AnalysisProgress>;
  onRunModule: (moduleId: string) => void;
  onCancelModule: (moduleId: string) => void;
  onViewHistory: (moduleId: string) => void;
  /** When true, disables Run buttons on all analysis modules (not exec summary) */
  disableAnalysis?: boolean;
  disableReason?: string;
}

export default function ModuleGrid({
  moduleStatuses,
  runningModules,
  analysisProgressMap,
  onRunModule,
  onCancelModule,
  onViewHistory,
  disableAnalysis = false,
  disableReason,
}: ModuleGridProps) {
  return (
    <div>
      <SectionLabel label="Analysis Modules" />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {MODULE_DEFINITIONS.map((mod) => {
          const status = moduleStatuses[mod.id] ?? null;
          const isRunning = runningModules.has(mod.id) || status?.latestRun?.status === "running";
          // Executive Summary has its own gate (≥1 completed module); analysis modules use disableAnalysis
          const isDisabled = mod.id !== "executive_summary" && disableAnalysis;
          return (
            <ModuleCard
              key={mod.id}
              definition={mod}
              status={status}
              isRunning={isRunning}
              analysisProgress={isRunning ? analysisProgressMap[mod.id] : undefined}
              onRun={() => onRunModule(mod.id)}
              onCancel={() => onCancelModule(mod.id)}
              onViewHistory={() => onViewHistory(mod.id)}
              disabled={isDisabled}
              disabledReason={disableReason}
            />
          );
        })}
      </div>
    </div>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <h2 className="text-xs font-bold text-ic-muted uppercase tracking-[0.1em] whitespace-nowrap">
        {label}
      </h2>
      <div className="flex-1 h-px bg-ic-border" />
    </div>
  );
}
