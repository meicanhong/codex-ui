"use client";

import { Streamdown } from "streamdown";
import type { CodexMarkdownTone } from "./presentation.js";

export type CodexMarkdownProps = {
  children: string;
  className?: string;
  tone?: CodexMarkdownTone;
};

/** Default streaming-safe Markdown renderer used by every Codex message type. */
export function CodexMarkdown({
  children,
  className,
  tone = "answer",
}: CodexMarkdownProps) {
  return (
    <Streamdown
      className={["codex-ui-markdown", `codex-ui-markdown--${tone}`, className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </Streamdown>
  );
}
