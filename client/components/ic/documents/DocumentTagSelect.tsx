import type { DocumentTag, DocumentSource } from "@/types/document";
import { DOCUMENT_TAG_LABELS } from "@/types/document";

interface DocumentTagSelectProps {
  tag: DocumentTag;
  source: DocumentSource;
  onTagChange: (tag: DocumentTag) => void;
  onSourceChange: (source: DocumentSource) => void;
}

const TYPE_TAGS: DocumentTag[] = [
  "cim",
  "ic_memo",
  "customer_data",
  "consultant_report",
  "financial_model",
  "legal",
  "other",
];

const selectClass =
  "w-full px-1.5 py-1 bg-ic-dark border border-ic-border rounded text-xs text-ic-text/80 " +
  "focus:outline-none focus:ring-1 focus:ring-ic-turquoise/50 focus:border-ic-turquoise";

export default function DocumentTagSelect({
  tag,
  source,
  onTagChange,
  onSourceChange,
}: DocumentTagSelectProps) {
  return (
    <div className="flex gap-1.5 mt-1">
      <select
        value={source ?? "sellside"}
        onChange={(e) => onSourceChange(e.target.value as DocumentSource)}
        className={selectClass}
      >
        <option value="sellside">Sellside</option>
        <option value="pep">PEP</option>
      </select>
      <select
        value={tag}
        onChange={(e) => onTagChange(e.target.value as DocumentTag)}
        className={selectClass}
      >
        {TYPE_TAGS.map((t) => (
          <option key={t} value={t}>
            {DOCUMENT_TAG_LABELS[t]}
          </option>
        ))}
      </select>
    </div>
  );
}
