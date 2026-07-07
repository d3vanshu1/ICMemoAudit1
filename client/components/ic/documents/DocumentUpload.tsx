import { useState, useRef, useCallback, type DragEvent, type ChangeEvent } from "react";
import { Upload, X, FileText, AlertTriangle } from "lucide-react";
import ICButton from "../ui/ICButton";

/** Files above this threshold (50 MB) trigger a size warning */
const SIZE_WARNING_BYTES = 50 * 1024 * 1024;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface DocumentUploadProps {
  /** Receives the raw browser File objects — no base64 reading needed */
  onUpload: (files: File[]) => void;
}

const ACCEPTED_TYPES = ".pdf,.csv,.xlsx,.xls";

export default function DocumentUpload({ onUpload }: DocumentUploadProps) {
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((files: FileList | File[]) => {
    const valid = Array.from(files).filter((f) => {
      const ext = f.name.toLowerCase().split(".").pop();
      return ext === "pdf" || ext === "csv" || ext === "xlsx" || ext === "xls";
    });
    if (valid.length > 0) {
      setStagedFiles((prev) => [...prev, ...valid]);
    }
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setDragActive(false);
  };

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeFile = (index: number) => {
    setStagedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpload = useCallback(() => {
    if (stagedFiles.length === 0) return;
    onUpload(stagedFiles);
    setStagedFiles([]);
  }, [stagedFiles, onUpload]);

  return (
    <div className="space-y-2">
      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
        className={`flex flex-col items-center justify-center py-4 px-3 border-2 border-dashed rounded-lg
          cursor-pointer transition-colors ${
            dragActive
              ? "border-ic-turquoise bg-ic-turquoise/10"
              : "border-ic-border hover:border-ic-soft-gray hover:bg-ic-surface-light/50"
          }`}
      >
        <Upload className={`w-5 h-5 mb-1.5 ${dragActive ? "text-ic-turquoise" : "text-ic-muted"}`} />
        <p className="text-xs text-ic-muted text-center">
          Drop files or <span className="text-ic-turquoise">browse</span>
        </p>
        <p className="text-[10px] text-ic-muted/60 mt-0.5">PDF, CSV, XLSX</p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_TYPES}
        onChange={handleFileSelect}
        className="hidden"
      />

      {/* Staged files */}
      {stagedFiles.length > 0 && (
        <div className="space-y-1.5">
          {stagedFiles.map((file, index) => (
            <div
              key={`${file.name}-${index}`}
              className="flex items-center gap-2 p-2 bg-ic-surface-light rounded-md border border-ic-border"
            >
              <FileText className="w-3.5 h-3.5 text-ic-muted flex-shrink-0" />
              <span className="text-xs text-ic-text/80 truncate flex-1" title={file.name}>
                {file.name}
                <span className="text-[10px] text-ic-muted ml-1">({formatFileSize(file.size)})</span>
              </span>
              {file.size > SIZE_WARNING_BYTES && (
                <span title="Large file — will be chunked into page segments"><AlertTriangle className="w-3.5 h-3.5 text-ic-coral flex-shrink-0" /></span>
              )}
              <button
                onClick={() => removeFile(index)}
                className="p-0.5 text-ic-muted hover:text-ic-text transition-colors cursor-pointer"
                aria-label="Remove file"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}

          <ICButton size="sm" onClick={handleUpload} className="w-full">
            Upload {stagedFiles.length} file{stagedFiles.length > 1 ? "s" : ""}
          </ICButton>
        </div>
      )}
    </div>
  );
}
