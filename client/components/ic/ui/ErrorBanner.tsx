import { AlertCircle, RefreshCw } from "lucide-react";
import ICButton from "./ICButton";

interface ErrorBannerProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
}

export default function ErrorBanner({
  title = "Something went wrong",
  message = "An unexpected error occurred. Please try again.",
  onRetry,
}: ErrorBannerProps) {
  return (
    <div className="flex items-center justify-between bg-ic-coral/10 border border-ic-coral/30 rounded-xl px-5 py-4">
      <div className="flex items-center gap-3">
        <AlertCircle className="w-5 h-5 text-ic-coral flex-shrink-0" />
        <div>
          <p className="text-sm font-bold text-ic-text">{title}</p>
          <p className="text-xs text-ic-muted mt-0.5">{message}</p>
        </div>
      </div>
      {onRetry && (
        <ICButton variant="ghost" size="sm" onClick={onRetry}>
          <RefreshCw className="w-3.5 h-3.5" />
          Retry
        </ICButton>
      )}
    </div>
  );
}
