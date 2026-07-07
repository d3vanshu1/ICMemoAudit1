import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface StreamingTextProps {
  content: string;
  streaming?: boolean;
  className?: string;
}

export default function StreamingText({
  content,
  streaming = false,
  className = "",
}: StreamingTextProps) {
  return (
    <div className={`prose prose-invert prose-sm max-w-none ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-lg font-bold text-ic-text mt-4 mb-2">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-base font-bold text-ic-text mt-3 mb-2">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-bold text-ic-text/90 mt-2 mb-1">{children}</h3>
          ),
          p: ({ children }) => (
            <p className="text-sm text-ic-text/80 leading-relaxed mb-2">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="list-disc list-inside text-sm text-ic-text/80 mb-2 space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside text-sm text-ic-text/80 mb-2 space-y-1">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="text-sm text-ic-text/80">{children}</li>
          ),
          strong: ({ children }) => (
            <strong className="font-bold text-ic-text">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="italic text-ic-text/80">{children}</em>
          ),
          code: ({ children, className: codeClassName }) => {
            const isInline = !codeClassName;
            if (isInline) {
              return (
                <code className="px-1.5 py-0.5 bg-ic-surface-light rounded text-xs font-mono text-ic-turquoise">
                  {children}
                </code>
              );
            }
            return (
              <code className="block p-3 bg-ic-dark rounded-lg text-xs font-mono text-ic-text/80 overflow-x-auto">
                {children}
              </code>
            );
          },
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-ic-turquoise pl-4 italic text-ic-muted my-2">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-3">
              <table className="w-full text-xs border-collapse border border-ic-border">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-ic-surface-light">{children}</thead>
          ),
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => (
            <tr className="border-b border-ic-border hover:bg-ic-surface-light/50 transition-colors">{children}</tr>
          ),
          th: ({ children }) => (
            <th className="px-3 py-2 text-left font-bold text-ic-text/90 border-r border-ic-border last:border-r-0">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 text-ic-text/80 border-r border-ic-border last:border-r-0">{children}</td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
      {streaming && (
        <span className="inline-block w-2 h-4 bg-ic-turquoise animate-pulse ml-0.5 align-middle" />
      )}
    </div>
  );
}
