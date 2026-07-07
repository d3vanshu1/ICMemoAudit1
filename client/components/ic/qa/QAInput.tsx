import { useState, useCallback, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import ICButton from "../ui/ICButton";

interface QAInputProps {
  onSubmit: (question: string) => void;
  disabled: boolean;
  placeholder?: string;
}

export default function QAInput({ onSubmit, disabled, placeholder }: QAInputProps) {
  const [value, setValue] = useState("");

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setValue("");
  }, [value, disabled, onSubmit]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !disabled) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit, disabled]
  );

  return (
    <div className="flex gap-2 items-end">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? "Ask about this deal..."}
        rows={2}
        disabled={disabled}
        className="flex-1 bg-ic-surface-light border border-ic-border rounded-lg px-4 py-3
                   text-sm text-ic-text placeholder:text-ic-muted resize-none
                   focus:outline-none focus:ring-2 focus:ring-ic-turquoise/40 focus:border-ic-turquoise
                   disabled:opacity-50 disabled:cursor-not-allowed"
      />
      <ICButton
        onClick={handleSubmit}
        disabled={disabled || !value.trim()}
        className="h-10 w-10 !p-0"
      >
        <Send className="w-4 h-4" />
      </ICButton>
    </div>
  );
}
