export type DealStatus = "active" | "on_hold" | "closed";

export interface Deal {
  id: string;
  name: string;
  description: string | null;
  sector: string | null;
  status: DealStatus;
  entry_ev: number | null;
  entry_multiple: number | null;
  equity_check: number | null;
  ic_date: string | null;
  created_at: string;
  updated_at: string;
  document_count: number;
  total_findings: number;
  critical_findings: number;
  module_runs?: ModuleRunSummary[];
}

export interface ModuleRunSummary {
  module_id: string;
  status: "pending" | "running" | "completed" | "failed";
  completed_at: string | null;
}
