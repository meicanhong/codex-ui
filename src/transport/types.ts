import type {
  CodexApprovalDecision,
  CodexAppServerEnvelope,
  CodexJsonObject,
  CodexJsonValue,
} from "../core/index.js";

export type CodexRuntimeStatus = {
  state: "disabled" | "starting" | "ready" | "unavailable";
  runtimeReady: boolean;
  turnsEnabled: boolean;
  toolsEnabled: boolean;
  errorCode: string | null;
  raw: CodexJsonObject;
};

export type CodexTransportCapabilities = {
  interrupt: boolean;
  loadThread: boolean;
  approvals: boolean;
  serverRequests: boolean;
  /** Whether turns continue independently and can be re-subscribed after reconnect. */
  backgroundTurns?: boolean;
  /** Whether this host accepts native Codex image inputs on a turn. */
  imageInput?: boolean;
};

export type CodexImageInput = {
  url: string;
  detail?: "auto" | "low" | "high" | "original";
};

export type CodexStartTurnRequest = {
  /** Stable host-owned conversation key used to preserve a session across turns. */
  conversationId: string;
  /** Latest native App Server thread id, when the upstream has returned one. */
  threadId: string | null;
  message: string;
  images?: readonly CodexImageInput[];
  clientTurnId?: string;
};

export type CodexBackgroundTurnStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export type CodexBackgroundTurnReference = {
  turnId: string;
  status: CodexBackgroundTurnStatus;
  lastSequence: number;
};

export interface CodexTransport {
  readonly capabilities: CodexTransportCapabilities;
  getStatus(options?: { signal?: AbortSignal }): Promise<CodexRuntimeStatus>;
  startTurn(
    request: CodexStartTurnRequest,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<CodexAppServerEnvelope>;
  startBackgroundTurn?(
    request: CodexStartTurnRequest,
    options?: { signal?: AbortSignal },
  ): Promise<CodexBackgroundTurnReference>;
  findActiveBackgroundTurn?(request: {
    conversationId: string;
  }): Promise<CodexBackgroundTurnReference | null>;
  subscribeBackgroundTurn?(
    request: {
      conversationId: string;
      turnId: string;
      afterSequence?: number;
    },
    options?: { signal?: AbortSignal },
  ): AsyncIterable<CodexAppServerEnvelope>;
  interruptBackgroundTurn?(request: {
    conversationId: string;
    turnId: string;
  }): Promise<void>;
  interruptTurn(request: { threadId: string; turnId: string }): Promise<void>;
  loadThread(request: {
    threadId: string;
    conversationId?: string;
  }): Promise<CodexAppServerEnvelope[]>;
  respondToApproval(request: {
    requestId: string | number;
    method: string;
    decision: CodexApprovalDecision;
  }): Promise<void>;
  respondToServerRequest(request: {
    requestId: string | number;
    method: string;
    result: CodexJsonValue;
  }): Promise<void>;
}

export class CodexTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CodexTransportError";
  }
}

export class CodexTransportUnsupportedError extends CodexTransportError {
  constructor(capability: keyof CodexTransportCapabilities) {
    super(
      "codex_transport_capability_unsupported",
      `Codex transport does not support ${capability}`,
      { capability },
    );
    this.name = "CodexTransportUnsupportedError";
  }
}
