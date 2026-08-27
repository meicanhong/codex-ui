import type { CodexJsonObject } from "../core/index.js";

export type CodexSession = {
  /** Stable host-owned id exposed to the browser. */
  id: string;
  /** Native Codex App Server thread id. */
  threadId: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  raw: CodexJsonObject;
};

export type CodexSessionPage = {
  sessions: CodexSession[];
  nextCursor: string | null;
};

export type CodexListSessionsRequest = {
  cursor?: string;
  limit?: number;
  includeArchived?: boolean;
};

export interface CodexSessionTransport {
  listSessions(request?: CodexListSessionsRequest): Promise<CodexSessionPage>;
  createSession(request?: { title?: string }): Promise<CodexSession>;
  renameSession(sessionId: string, title: string): Promise<CodexSession>;
  archiveSession(sessionId: string): Promise<void>;
  unarchiveSession(sessionId: string): Promise<CodexSession>;
  deleteSession(sessionId: string): Promise<void>;
}
