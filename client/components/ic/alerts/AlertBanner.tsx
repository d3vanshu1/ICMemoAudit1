import { useState } from "react";
import { AlertCircle, X } from "lucide-react";

interface AlertBannerProps {
  count: number;
}

export default function AlertBanner({ count }: AlertBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  if (count === 0 || dismissed) return null;

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-ic-coral/15 border border-ic-coral/30">
      <div className="flex items-center gap-3">
        <AlertCircle className="w-5 h-5 text-ic-coral flex-shrink-0" />
        <p className="text-sm text-ic-coral font-bold">
          {count} critical finding{count !== 1 ? "s" : ""} require{count === 1 ? "s" : ""} attention
        </p>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="p-1 rounded text-ic-coral/60 hover:text-ic-coral transition-colors cursor-pointer"
        aria-label="Dismiss alert"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
