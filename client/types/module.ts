export interface ModuleRun {
  id: string;
  deal_id: string;
  module_id: string;
  status: "pending" | "running" | "completed" | "failed";
  isCancelled?: boolean;
  triggered_at: string;
  completed_at: string | null;
  documents_included: string[];
  findings_count?: number;
  critical_count?: number;
}

export interface Finding {
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  full_analysis: string;
  source_docs: string[];
}

export interface ModuleOutput {
  id: string;
  module_run_id: string;
  executive_header: string | null;
  findings: Finding[];
  full_report_markdown: string;
  created_at: string;
}

export interface ModuleStatus {
  moduleId: string;
  latestRun: ModuleRun | null;
  latestOutput: ModuleOutput | null;
}
