"use client";

import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  oneDark,
  oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism";

interface CodeBlockContentProps {
  code: string;
  language: string;
  showLineNumbers: boolean;
}

const CodeBlockContent = ({
  code,
  language,
  showLineNumbers,
}: CodeBlockContentProps) => {
  const commonCodeTagProps = {
    className: "font-mono text-sm",
  };

  const commonCustomStyle = {
    margin: 0,
    padding: "1rem",
    fontSize: "0.875rem",
    background: "hsl(var(--background))",
    color: "hsl(var(--foreground))",
  };

  const commonLineNumberStyle = {
    color: "hsl(var(--muted-foreground))",
    paddingRight: "1rem",
    minWidth: "2.5rem",
  };

  return (
    <>
      <SyntaxHighlighter
        className="overflow-hidden dark:hidden"
        codeTagProps={commonCodeTagProps}
        customStyle={commonCustomStyle}
        language={language}
        lineNumberStyle={commonLineNumberStyle}
        showLineNumbers={showLineNumbers}
        style={oneLight}
      >
        {code}
      </SyntaxHighlighter>
      <SyntaxHighlighter
        className="hidden overflow-hidden dark:block"
        codeTagProps={commonCodeTagProps}
        customStyle={commonCustomStyle}
        language={language}
        lineNumberStyle={commonLineNumberStyle}
        showLineNumbers={showLineNumbers}
        style={oneDark}
      >
        {code}
      </SyntaxHighlighter>
    </>
  );
};

export default CodeBlockContent;
