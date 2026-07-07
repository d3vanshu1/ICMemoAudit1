import { User, MessageCircle, FileText } from "lucide-react";
import StreamingText from "../ui/StreamingText";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sourceDocs?: string[];
}

interface QAMessageProps {
  message: ChatMessage;
}

export default function QAMessage({ message }: QAMessageProps) {
  if (message.role === "user") {
    return (
      <div className="flex gap-3">
        <div className="w-7 h-7 rounded-full bg-ic-blue flex items-center justify-center flex-shrink-0 mt-0.5">
          <User className="w-3.5 h-3.5 text-white" />
        </div>
        <div className="text-sm text-ic-text pt-1">{message.content}</div>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 rounded-full bg-ic-turquoise flex items-center justify-center flex-shrink-0 mt-0.5">
        <MessageCircle className="w-3.5 h-3.5 text-white" />
      </div>
      <div className="flex-1 space-y-2">
        <div className="bg-ic-surface-light rounded-lg p-4 border border-ic-border">
          <StreamingText content={message.content} />
        </div>
        {message.sourceDocs && message.sourceDocs.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {message.sourceDocs.map((doc) => (
              <span
                key={doc}
                className="inline-flex items-center gap-1 text-[10px] text-ic-muted bg-ic-dark/50 px-2 py-0.5 rounded-full border border-ic-border"
              >
                <FileText className="w-2.5 h-2.5" />
                {doc}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
