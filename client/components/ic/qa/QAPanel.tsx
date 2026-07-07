import { useState, useCallback, useRef, useEffect } from "react";
import { MessageCircle, Trash2 } from "lucide-react";
import { useApi } from "@/hooks/useApi.js";
import { toast } from "sonner";
import QAInput from "./QAInput";
import QAMessage from "./QAMessage";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sourceDocs?: string[];
}

interface QAPanelProps {
  dealId: string;
  dealName: string;
  dealSector: string | null;
  hasDocuments: boolean;
}

const EXAMPLE_QUESTIONS = [
  "What is the company's revenue and EBITDA?",
  "Who are the top customers and what are their contract terms?",
  "What are the key risks identified in the materials?",
  "What does the financial model project for the next 3 years?",
];

export default function QAPanel({ dealId, dealName, dealSector, hasDocuments }: QAPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isAsking, setIsAsking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { run: searchChunks } = useApi("SearchChunks");
  const { run: askDataRoom } = useApi("AskDataRoom");

  // Auto-scroll to bottom when new messages appear
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleAsk = useCallback(
    async (question: string) => {
      if (!hasDocuments) {
        toast.error("Upload documents first before asking questions.");
        return;
      }

      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: question,
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsAsking(true);

      try {
        // Step 1: Search for relevant chunks
        const searchResult = await searchChunks({
          dealId,
          query: question,
          limit: 20,
        });

        // Step 2: Build conversation history for context
        const conversationHistory = messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        // Step 3: Ask with reranking + answer generation
        const result = await askDataRoom({
          dealId,
          dealName,
          dealSector: dealSector ?? null,
          question,
          conversationHistory,
          candidateChunks: searchResult?.chunks ?? [],
        });

        const assistantMsg: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: result?.answer ?? "",
          sourceDocs: result?.sourceDocs ?? [],
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } catch (err) {
        const message =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
        toast.error("Failed to get answer: " + message);
        // Remove the user message if we failed
        setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
      } finally {
        setIsAsking(false);
      }
    },
    [dealId, dealName, dealSector, hasDocuments, messages, searchChunks, askDataRoom]
  );

  const handleClear = useCallback(() => {
    setMessages([]);
  }, []);

  const handleChipClick = useCallback(
    (q: string) => {
      handleAsk(q);
    },
    [handleAsk]
  );

  const showExamples = messages.length === 0 && !isAsking;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-xs font-bold text-ic-muted uppercase tracking-[0.1em] whitespace-nowrap">
          Data Room Intelligence
        </h2>
        <div className="flex-1 h-px bg-ic-border" />
      </div>
    <div className="bg-ic-surface rounded-xl border border-ic-border p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-5 w-5 text-ic-turquoise" />
          <h3 className="text-lg font-bold text-ic-text">Ask the Data Room</h3>
        </div>
        {messages.length > 0 && (
          <button
            onClick={handleClear}
            className="flex items-center gap-1.5 text-xs text-ic-muted hover:text-ic-coral transition-colors cursor-pointer"
            title="Clear conversation"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </button>
        )}
      </div>
      <p className="text-xs text-ic-muted mb-4 leading-relaxed">
        Query your uploaded documents for specific facts, figures, and details.
        This tool searches across all documents and is for informational requests only.
      </p>

      {/* Example chips */}
      {showExamples && (
        <div className="flex flex-wrap gap-2 mb-4">
          {EXAMPLE_QUESTIONS.map((eq) => (
            <button
              key={eq}
              onClick={() => handleChipClick(eq)}
              disabled={!hasDocuments}
              className="text-xs px-3 py-1.5 rounded-full border border-ic-border text-ic-muted
                         hover:border-ic-turquoise hover:text-ic-turquoise transition-colors cursor-pointer
                         disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-ic-border disabled:hover:text-ic-muted"
            >
              {eq}
            </button>
          ))}
        </div>
      )}

      {/* Chat thread */}
      {messages.length > 0 && (
        <div
          ref={scrollRef}
          className="space-y-4 mb-4 max-h-[500px] overflow-y-auto pr-1 scroll-smooth"
        >
          {messages.map((msg) => (
            <QAMessage key={msg.id} message={msg} />
          ))}
          {isAsking && (
            <div className="flex gap-3">
              <div className="w-7 h-7 rounded-full bg-ic-turquoise flex items-center justify-center flex-shrink-0 mt-0.5">
                <MessageCircle className="w-3.5 h-3.5 text-white" />
              </div>
              <div className="flex items-center gap-2 text-sm text-ic-muted pt-1">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 bg-ic-turquoise rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 bg-ic-turquoise rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 bg-ic-turquoise rounded-full animate-bounce [animation-delay:300ms]" />
                </div>
                <span>Searching documents...</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Input */}
      <QAInput
        onSubmit={handleAsk}
        disabled={isAsking || !hasDocuments}
        placeholder={
          !hasDocuments
            ? "Upload documents to start asking questions..."
            : "Ask a question about the data room..."
        }
      />
    </div>
    </div>
  );
}
