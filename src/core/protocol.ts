export type CodexJsonPrimitive = string | number | boolean | null;

export type CodexJsonValue =
  | CodexJsonPrimitive
  | CodexJsonValue[]
  | { [key: string]: CodexJsonValue };

export type CodexJsonObject = { [key: string]: CodexJsonValue };

export type CodexMessagePhase = "commentary" | "final_answer";
export type CodexTurnStatus =
  | "completed"
  | "interrupted"
  | "failed"
  | "inProgress";
export type CodexItemLifecycle = "started" | "completed";

export type CodexTextElement = {
  byteRange: { start: number; end: number };
  placeholder: string | null;
};

export type CodexHookPromptFragment = {
  text: string;
  hookRunId: string;
};

export type CodexMemoryCitation = {
  entries: Array<{
    path: string;
    lineStart: number;
    lineEnd: number;
    note: string;
  }>;
  threadIds: string[];
};

export type CodexUserInput =
  | { type: "text"; text: string; text_elements: CodexTextElement[] }
  | {
      type: "image";
      detail?: "auto" | "low" | "high" | "original";
      url: string;
    }
  | {
      type: "localImage";
      detail?: "auto" | "low" | "high" | "original";
      path: string;
    }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export type CodexCommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path: string | null }
  | {
      type: "search";
      command: string;
      query: string | null;
      path: string | null;
    }
  | { type: "unknown"; command: string };

export type CodexPatchChangeKind =
  | { type: "add" }
  | { type: "delete" }
  | { type: "update"; move_path: string | null };

export type CodexFileUpdateChange = {
  path: string;
  kind: CodexPatchChangeKind;
  diff: string;
};

export type CodexMcpToolCallResult = {
  content: CodexJsonValue[];
  structuredContent: CodexJsonValue | null;
  _meta: CodexJsonValue | null;
};

export type CodexWebSearchAction =
  | { type: "search"; query: string | null; queries: string[] | null }
  | { type: "openPage"; url: string | null }
  | { type: "findInPage"; url: string | null; pattern: string | null }
  | { type: "other" };

export type CodexCollabAgentStatus =
  | "pendingInit"
  | "running"
  | "interrupted"
  | "completed"
  | "errored"
  | "shutdown"
  | "notFound";

export type CodexErrorInfo =
  | "contextWindowExceeded"
  | "usageLimitExceeded"
  | "serverOverloaded"
  | "cyberPolicy"
  | { httpConnectionFailed: { httpStatusCode: number | null } }
  | { responseStreamConnectionFailed: { httpStatusCode: number | null } }
  | "internalServerError"
  | "unauthorized"
  | "badRequest"
  | "threadRollbackFailed"
  | "sandboxError"
  | { responseStreamDisconnected: { httpStatusCode: number | null } }
  | { responseTooManyFailedAttempts: { httpStatusCode: number | null } }
  | { activeTurnNotSteerable: { turnKind: "review" | "compact" } }
  | "other";

export type CodexThreadItem =
  | {
      type: "userMessage";
      id: string;
      clientId: string | null;
      content: CodexUserInput[];
    }
  | { type: "hookPrompt"; id: string; fragments: CodexHookPromptFragment[] }
  | {
      type: "agentMessage";
      id: string;
      text: string;
      phase: CodexMessagePhase | null;
      memoryCitation: CodexMemoryCitation | null;
    }
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      processId: string | null;
      source:
        | "agent"
        | "userShell"
        | "unifiedExecStartup"
        | "unifiedExecInteraction";
      status: "inProgress" | "completed" | "failed" | "declined";
      commandActions: CodexCommandAction[];
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | {
      type: "fileChange";
      id: string;
      changes: CodexFileUpdateChange[];
      status: "inProgress" | "completed" | "failed" | "declined";
    }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: "inProgress" | "completed" | "failed";
      arguments: CodexJsonValue;
      appContext: {
        connectorId: string;
        linkId: string | null;
        resourceUri: string | null;
      } | null;
      mcpAppResourceUri?: string;
      pluginId: string | null;
      result: CodexMcpToolCallResult | null;
      error: { message: string } | null;
      durationMs: number | null;
    }
  | {
      type: "dynamicToolCall";
      id: string;
      namespace: string | null;
      tool: string;
      arguments: CodexJsonValue;
      status: "inProgress" | "completed" | "failed";
      contentItems: Array<
        | { type: "inputText"; text: string }
        | { type: "inputImage"; imageUrl: string }
      > | null;
      success: boolean | null;
      durationMs: number | null;
    }
  | {
      type: "collabAgentToolCall";
      id: string;
      tool: "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent";
      status: "inProgress" | "completed" | "failed";
      senderThreadId: string;
      receiverThreadIds: string[];
      prompt: string | null;
      model: string | null;
      reasoningEffort: string | null;
      agentsStates: {
        [key: string]:
          | { status: CodexCollabAgentStatus; message: string | null }
          | undefined;
      };
    }
  | {
      type: "subAgentActivity";
      id: string;
      kind: "started" | "interacted" | "interrupted";
      agentThreadId: string;
      agentPath: string;
    }
  | {
      type: "webSearch";
      id: string;
      query: string;
      action: CodexWebSearchAction | null;
    }
  | { type: "imageView"; id: string; path: string }
  | { type: "sleep"; id: string; durationMs: number }
  | {
      type: "imageGeneration";
      id: string;
      status: string;
      revisedPrompt: string | null;
      result: string;
      savedPath?: string;
    }
  | { type: "enteredReviewMode"; id: string; review: string }
  | { type: "exitedReviewMode"; id: string; review: string }
  | { type: "contextCompaction"; id: string };

export type CodexUnknownThreadItem = {
  type: "unknown";
  id: string;
  originalType: string;
  raw: CodexJsonObject;
};

export type CodexRenderableThreadItem =
  | CodexThreadItem
  | CodexUnknownThreadItem;

export type CodexTurnError = {
  message: string;
  codexErrorInfo: CodexErrorInfo | null;
  additionalDetails: string | null;
};

export type CodexTokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type CodexThreadTokenUsage = {
  total: CodexTokenUsageBreakdown;
  last: CodexTokenUsageBreakdown;
  modelContextWindow: number | null;
};

export type CodexTurnPlan = {
  explanation: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
};
