import type {
  CodexApprovalDecision,
  CodexAppServerEnvelope,
} from "./events.js";
import type {
  CodexJsonObject,
  CodexRenderableThreadItem,
  CodexThreadTokenUsage,
  CodexTurnError,
  CodexTurnPlan,
  CodexTurnStatus,
} from "./protocol.js";

export type CodexItemState = {
  id: string;
  item: CodexRenderableThreadItem;
  lifecycle: "started" | "completed";
  firstSeenSequence: number;
  lastSeenSequence: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
  progress: string[];
  raw: CodexJsonObject;
};

export type CodexApprovalState = {
  requestId: string | number;
  method: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  reason: string | null;
  startedAtMs: number | null;
  availableDecisions: CodexApprovalDecision[];
  status: "pending" | "resolved" | "failed";
  decision: CodexApprovalDecision | null;
  resolvedAt: number | null;
  params: CodexJsonObject;
  raw: CodexJsonObject;
};

export type CodexServerRequestState = {
  requestId: string | number;
  method: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  status: "pending" | "resolved" | "failed";
  receivedAt: number;
  resolvedAt: number | null;
  params: CodexJsonObject;
  raw: CodexJsonObject;
};

export type CodexTurnState = {
  id: string;
  status: CodexTurnStatus;
  error: CodexTurnError | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  itemOrder: string[];
  itemsById: Record<string, CodexItemState>;
  plan: CodexTurnPlan | null;
  diff: string | null;
};

export type CodexThreadState = {
  schemaVersion: "0.142.0";
  threadId: string | null;
  turnOrder: string[];
  turnsById: Record<string, CodexTurnState>;
  tokenUsage: CodexThreadTokenUsage | null;
  approvalsById: Record<string, CodexApprovalState>;
  serverRequestsById: Record<string, CodexServerRequestState>;
  unknownEvents: CodexAppServerEnvelope[];
  seenEventKeys: string[];
  /** Highest accepted sequence for each native SSE stream. */
  latestSequenceByStream: Record<string, number>;
  lastError: {
    code: string;
    message: string;
    threadId: string | null;
    turnId: string | null;
    occurredAt: number;
  } | null;
};

export function createCodexThreadState(
  threadId: string | null = null,
): CodexThreadState {
  return {
    schemaVersion: "0.142.0",
    threadId,
    turnOrder: [],
    turnsById: {},
    tokenUsage: null,
    approvalsById: {},
    serverRequestsById: {},
    unknownEvents: [],
    seenEventKeys: [],
    latestSequenceByStream: {},
    lastError: null,
  };
}

export function createCodexTurnState(id: string): CodexTurnState {
  return {
    id,
    status: "inProgress",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    itemOrder: [],
    itemsById: {},
    plan: null,
    diff: null,
  };
}
