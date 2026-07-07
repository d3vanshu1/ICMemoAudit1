import { FileText, AlertCircle, CheckCircle2, BarChart3 } from "lucide-react";
import StatCard from "../ui/StatCard";

interface StatsRowProps {
  documentCount: number;
  modulesComplete: number;
  totalModules: number;
  totalFindings: number;
  criticalFindings: number;
}

export default function StatsRow({
  documentCount,
  modulesComplete,
  totalModules,
  totalFindings,
  criticalFindings,
}: StatsRowProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard
        icon={<FileText className="w-5 h-5" />}
        label="Documents"
        value={documentCount}
        subValue="in data room"
      />
      <StatCard
        icon={<CheckCircle2 className="w-5 h-5" />}
        label="Modules Complete"
        value={`${modulesComplete}/${totalModules}`}
      />
      <StatCard
        icon={<AlertCircle className="w-5 h-5" />}
        label="Critical Findings"
        value={criticalFindings}
        subValue={totalFindings > 0 ? `${totalFindings} total` : undefined}
        highlight={criticalFindings > 0}
      />
      <StatCard
        icon={<BarChart3 className="w-5 h-5" />}
        label="Total Findings"
        value={totalFindings}
        subValue={modulesComplete > 0 ? `across ${modulesComplete} modules` : "no modules run yet"}
      />
    </div>
  );
}
