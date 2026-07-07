import { FileText, FileSpreadsheet, File, Trash2 } from "lucide-react";
import type { Document, DocumentTag, DocumentSource } from "@/types/document";
import DocumentTagSelect from "./DocumentTagSelect";

interface DocumentListProps {
  documents: Document[];
  onDelete: (docId: string) => void;
  onTagChange: (docId: string, tag: DocumentTag) => void;
  onSourceChange: (docId: string, source: DocumentSource) => void;
}

function getFileIcon(fileType: string) {
  if (fileType.includes("pdf")) {
    return <FileText className="w-4 h-4 text-ic-coral flex-shrink-0" />;
  }
  if (fileType.includes("sheet") || fileType.includes("csv") || fileType.includes("excel")) {
    return <FileSpreadsheet className="w-4 h-4 text-ic-turquoise flex-shrink-0" />;
  }
  return <File className="w-4 h-4 text-ic-muted flex-shrink-0" />;
}

export default function DocumentList({
  documents,
  onDelete,
  onTagChange,
  onSourceChange,
}: DocumentListProps) {
  if (documents.length === 0) {
    return (
      <p className="text-xs text-ic-muted/60 italic">
        No documents uploaded yet.
      </p>
    );
  }

  return (
    <ul className="space-y-1.5 max-h-48 overflow-y-auto">
      {documents.map((doc) => (
        <li
          key={doc.id}
          className="group flex items-start gap-2 px-2 py-1.5 rounded-md hover:bg-ic-surface-light transition-colors"
        >
          <span className="mt-0.5">{getFileIcon(doc.file_type)}</span>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-ic-text/80 truncate" title={doc.file_name}>
              {doc.file_name}
            </p>
            <DocumentTagSelect
              tag={doc.document_tag}
              source={doc.document_source}
              onTagChange={(tag) => onTagChange(doc.id, tag)}
              onSourceChange={(source) => onSourceChange(doc.id, source)}
            />
          </div>
          <button
            onClick={() => onDelete(doc.id)}
            className="opacity-0 group-hover:opacity-100 p-1 rounded text-ic-muted hover:text-ic-coral
              transition-all mt-0.5 flex-shrink-0 cursor-pointer"
            aria-label={`Delete ${doc.file_name}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}
