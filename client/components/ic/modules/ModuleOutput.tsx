import { useState } from "react";
import { AlertCircle, AlertTriangle, Info, ChevronDown, ChevronUp, FileText } from "lucide-react";
import type { ModuleOutput as ModuleOutputType, Finding } from "@/types/module";
import ICBadge from "../ui/ICBadge";
import StreamingText from "../ui/StreamingText";

interface ModuleOutputProps {
  output: ModuleOutputType;
}

const severityIcons: Record<Finding["severity"], React.ReactNode> = {
  critical: <AlertCircle className="w-4 h-4 text-ic-coral flex-shrink-0" />,
  warning: <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />,
  info: <Info className="w-4 h-4 text-ic-turquoise flex-shrink-0" />,
};

function cleanReportMarkdown(text: string): string {
  const match = text.match(/<full_report>([\s\S]*)$/i);
  if (match) return match[1].replace(/<\/full_report>\s*$/i, "").trim();
  return text
    .replace(/<executive_header>[\s\S]*?<\/executive_header>\s*/gi, "")
    .replace(/<findings_json>[\s\S]*?<\/findings_json>\s*/gi, "")
    .trim();
}

export default function ModuleOutput({ output }: ModuleOutputProps) {
  const [showFullReport, setShowFullReport] = useState(false);
  const reportText = output.full_report_markdown
    ? cleanReportMarkdown(output.full_report_markdown)
    : null;

  return (
    <div className="space-y-5">
      {/* Executive header — suppress error messages */}
      {output.executive_header &&
        !/^(merge|analysis|extraction|pipeline)\s*(failed|error)/i.test(output.executive_header.trim()) && (
        <div className="p-4 rounded-lg bg-ic-surface-light border border-ic-border">
          <p className="text-sm text-ic-text leading-relaxed font-bold">
            {output.executive_header}
          </p>
        </div>
      )}

      {/* Full report toggle */}
      {reportText && (
        <div>
          <button
            onClick={() => setShowFullReport(!showFullReport)}
            className="w-full flex items-center justify-between px-4 py-3 rounded-lg cursor-pointer
              bg-ic-turquoise/10 border border-ic-turquoise/30 hover:bg-ic-turquoise/20 transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <FileText className="w-4 h-4 text-ic-turquoise" />
              <span className="text-sm font-bold text-ic-turquoise">
                {showFullReport ? "Hide Full Report" : "View Full Report"}
              </span>
            </div>
            {showFullReport ? (
              <ChevronUp className="w-4 h-4 text-ic-turquoise" />
            ) : (
              <ChevronDown className="w-4 h-4 text-ic-turquoise" />
            )}
          </button>
          {showFullReport && (
            <div className="mt-3 p-5 rounded-xl bg-ic-surface-light border border-ic-border">
              <StreamingText content={reportText} />
            </div>
          )}
        </div>
      )}

      {/* Findings */}
      {output.findings.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-bold text-ic-text/80">
            Findings ({output.findings.length})
          </h4>
          {output.findings.map((finding, i) => (
            <FindingItem key={i} finding={finding} />
          ))}
        </div>
      )}
    </div>
  );
}

function FindingItem({ finding }: { finding: Finding }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="p-3 rounded-lg bg-ic-surface border border-ic-border">
      <div className="flex items-start gap-3">
        {severityIcons[finding.severity]}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h5 className="text-sm font-bold text-ic-text">{finding.title}</h5>
            <ICBadge variant={finding.severity}>
              {finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1)}
            </ICBadge>
          </div>
          <p className="text-xs text-ic-muted leading-relaxed">{finding.detail}</p>

          {finding.full_analysis && (
            <>
              <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1 mt-2 text-xs text-ic-turquoise hover:text-ic-turquoise/80 transition-colors cursor-pointer"
              >
                {expanded ? "Collapse" : "Expand Analysis"}
                {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
              {expanded && (
                <div className="mt-3 p-4 bg-ic-surface-light rounded-xl border border-ic-border">
                  <StreamingText content={finding.full_analysis} />
                </div>
              )}
            </>
          )}

          {finding.source_docs.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {finding.source_docs.map((doc, j) => (
                <span key={j} className="text-[10px] text-ic-muted bg-ic-surface-light px-1.5 py-0.5 rounded">
                  {doc}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
