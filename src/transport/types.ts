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
};

export type CodexStartTurnRequest = {
  /** Stable host-owned conversation key used to preserve a session across turns. */
  conversationId: string;
  /** Latest native App Server thread id, when the upstream has returned one. */
  threadId: string | null;
  message: string;
  clientTurnId?: string;
};

export interface CodexTransport {
  readonly capabilities: CodexTransportCapabilities;
  getStatus(options?: { signal?: AbortSignal }): Promise<CodexRuntimeStatus>;
  startTurn(
    request: CodexStartTurnRequest,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<CodexAppServerEnvelope>;
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
