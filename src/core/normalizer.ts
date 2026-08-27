import type {
  CodexJsonObject,
  CodexJsonValue,
  CodexRenderableThreadItem,
  CodexThreadItem,
} from "./protocol.js";

export function normalizeCodexThreadItem(
  value: CodexJsonValue | undefined,
): CodexRenderableThreadItem | null {
  const raw = asObject(value);
  const originalType = stringValue(raw?.type);
  const id = stringValue(raw?.id);
  if (!raw || !originalType || !id) return null;
  if (!isValidKnownItem(raw, originalType)) {
    return { type: "unknown", id, originalType, raw };
  }
  return raw as unknown as CodexThreadItem;
}

function isValidKnownItem(raw: CodexJsonObject, type: string) {
  switch (type) {
    case "userMessage":
      return (
        isNullableString(raw.clientId) && isArrayOf(raw.content, isUserInput)
      );
    case "hookPrompt":
      return isArrayOf(raw.fragments, isHookPromptFragment);
    case "agentMessage":
      return (
        isString(raw.text) &&
        (raw.phase === null ||
          raw.phase === "commentary" ||
          raw.phase === "final_answer") &&
        (raw.memoryCitation === null || isMemoryCitation(raw.memoryCitation))
      );
    case "plan":
      return isString(raw.text);
    case "reasoning":
      return isStringArray(raw.summary) && isStringArray(raw.content);
    case "commandExecution":
      return (
        isString(raw.command) &&
        isString(raw.cwd) &&
        isNullableString(raw.processId) &&
        isOneOf(raw.source, [
          "agent",
          "userShell",
          "unifiedExecStartup",
          "unifiedExecInteraction",
        ]) &&
        isOneOf(raw.status, [
          "inProgress",
          "completed",
          "failed",
          "declined",
        ]) &&
        isArrayOf(raw.commandActions, isCommandAction) &&
        isNullableString(raw.aggregatedOutput) &&
        isNullableNumber(raw.exitCode) &&
        isNullableNumber(raw.durationMs)
      );
    case "fileChange":
      return (
        isArrayOf(raw.changes, isFileUpdateChange) &&
        isOneOf(raw.status, ["inProgress", "completed", "failed", "declined"])
      );
    case "mcpToolCall":
      return (
        isString(raw.server) &&
        isString(raw.tool) &&
        isOneOf(raw.status, ["inProgress", "completed", "failed"]) &&
        raw.arguments !== undefined &&
        (raw.appContext === null || isMcpAppContext(raw.appContext)) &&
        (raw.mcpAppResourceUri === undefined ||
          isString(raw.mcpAppResourceUri)) &&
        isNullableString(raw.pluginId) &&
        (raw.result === null || isMcpResult(raw.result)) &&
        (raw.error === null || isMessageError(raw.error)) &&
        isNullableNumber(raw.durationMs)
      );
    case "dynamicToolCall":
      return (
        isNullableString(raw.namespace) &&
        isString(raw.tool) &&
        raw.arguments !== undefined &&
        isOneOf(raw.status, ["inProgress", "completed", "failed"]) &&
        (raw.contentItems === null ||
          isArrayOf(raw.contentItems, isDynamicContentItem)) &&
        isNullableBoolean(raw.success) &&
        isNullableNumber(raw.durationMs)
      );
    case "collabAgentToolCall":
      return (
        isOneOf(raw.tool, [
          "spawnAgent",
          "sendInput",
          "resumeAgent",
          "wait",
          "closeAgent",
        ]) &&
        isOneOf(raw.status, ["inProgress", "completed", "failed"]) &&
        isString(raw.senderThreadId) &&
        isStringArray(raw.receiverThreadIds) &&
        isNullableString(raw.prompt) &&
        isNullableString(raw.model) &&
        isNullableString(raw.reasoningEffort) &&
        isAgentStates(raw.agentsStates)
      );
    case "subAgentActivity":
      return (
        isOneOf(raw.kind, ["started", "interacted", "interrupted"]) &&
        isString(raw.agentThreadId) &&
        isString(raw.agentPath)
      );
    case "webSearch":
      return (
        isString(raw.query) &&
        (raw.action === null || isWebSearchAction(raw.action))
      );
    case "imageView":
      return isString(raw.path);
    case "sleep":
      return isNumber(raw.durationMs);
    case "imageGeneration":
      return (
        isString(raw.status) &&
        isNullableString(raw.revisedPrompt) &&
        isString(raw.result) &&
        (raw.savedPath === undefined || isString(raw.savedPath))
      );
    case "enteredReviewMode":
    case "exitedReviewMode":
      return isString(raw.review);
    case "contextCompaction":
      return true;
    default:
      return false;
  }
}

function isUserInput(value: CodexJsonValue) {
  const input = asObject(value);
  if (!input) return false;
  switch (input.type) {
    case "text":
      return (
        isString(input.text) && isArrayOf(input.text_elements, isTextElement)
      );
    case "image":
      return isString(input.url) && isOptionalImageDetail(input.detail);
    case "localImage":
      return isString(input.path) && isOptionalImageDetail(input.detail);
    case "skill":
    case "mention":
      return isString(input.name) && isString(input.path);
    default:
      return false;
  }
}

function isTextElement(value: CodexJsonValue) {
  const element = asObject(value);
  const range = asObject(element?.byteRange);
  return Boolean(
    element &&
      range &&
      isNumber(range.start) &&
      isNumber(range.end) &&
      isNullableString(element.placeholder),
  );
}

function isHookPromptFragment(value: CodexJsonValue) {
  const fragment = asObject(value);
  return Boolean(
    fragment && isString(fragment.text) && isString(fragment.hookRunId),
  );
}

function isMemoryCitation(value: CodexJsonValue | undefined) {
  const citation = asObject(value);
  return Boolean(
    citation &&
      isStringArray(citation.threadIds) &&
      isArrayOf(citation.entries, (entry) => {
        const object = asObject(entry);
        return Boolean(
          object &&
            isString(object.path) &&
            isNumber(object.lineStart) &&
            isNumber(object.lineEnd) &&
            isString(object.note),
        );
      }),
  );
}

function isCommandAction(value: CodexJsonValue) {
  const action = asObject(value);
  if (!action || !isString(action.command)) return false;
  switch (action.type) {
    case "read":
      return isString(action.name) && isString(action.path);
    case "listFiles":
      return isNullableString(action.path);
    case "search":
      return isNullableString(action.query) && isNullableString(action.path);
    case "unknown":
      return true;
    default:
      return false;
  }
}

function isFileUpdateChange(value: CodexJsonValue) {
  const change = asObject(value);
  const kind = asObject(change?.kind);
  if (!change || !kind || !isString(change.path) || !isString(change.diff))
    return false;
  return (
    kind.type === "add" ||
    kind.type === "delete" ||
    (kind.type === "update" && isNullableString(kind.move_path))
  );
}

function isMcpAppContext(value: CodexJsonValue | undefined) {
  const context = asObject(value);
  return Boolean(
    context &&
      isString(context.connectorId) &&
      isNullableString(context.linkId) &&
      isNullableString(context.resourceUri),
  );
}

function isMcpResult(value: CodexJsonValue | undefined) {
  const result = asObject(value);
  return Boolean(
    result &&
      Array.isArray(result.content) &&
      result.structuredContent !== undefined &&
      result._meta !== undefined,
  );
}

function isMessageError(value: CodexJsonValue | undefined) {
  const error = asObject(value);
  return Boolean(error && isString(error.message));
}

function isDynamicContentItem(value: CodexJsonValue) {
  const content = asObject(value);
  return Boolean(
    content &&
      ((content.type === "inputText" && isString(content.text)) ||
        (content.type === "inputImage" && isString(content.imageUrl))),
  );
}

function isAgentStates(value: CodexJsonValue | undefined) {
  const states = asObject(value);
  return Boolean(
    states &&
      Object.values(states).every((entry) => {
        const state = asObject(entry);
        return Boolean(
          state &&
            isOneOf(state.status, [
              "pendingInit",
              "running",
              "interrupted",
              "completed",
              "errored",
              "shutdown",
              "notFound",
            ]) &&
            isNullableString(state.message),
        );
      }),
  );
}

function isWebSearchAction(value: CodexJsonValue | undefined) {
  const action = asObject(value);
  if (!action) return false;
  switch (action.type) {
    case "search":
      return (
        isNullableString(action.query) &&
        (action.queries === null || isStringArray(action.queries))
      );
    case "openPage":
      return isNullableString(action.url);
    case "findInPage":
      return isNullableString(action.url) && isNullableString(action.pattern);
    case "other":
      return true;
    default:
      return false;
  }
}

function isOptionalImageDetail(value: CodexJsonValue | undefined) {
  return (
    value === undefined ||
    value === "auto" ||
    value === "low" ||
    value === "high" ||
    value === "original"
  );
}

function isArrayOf(
  value: CodexJsonValue | undefined,
  predicate: (entry: CodexJsonValue) => boolean,
) {
  return Array.isArray(value) && value.every(predicate);
}

function isStringArray(value: CodexJsonValue | undefined) {
  return Array.isArray(value) && value.every(isString);
}

function isOneOf(
  value: CodexJsonValue | undefined,
  options: readonly string[],
) {
  return typeof value === "string" && options.includes(value);
}

function isNullableString(value: CodexJsonValue | undefined) {
  return value === null || isString(value);
}

function isNullableNumber(value: CodexJsonValue | undefined) {
  return value === null || isNumber(value);
}

function isNullableBoolean(value: CodexJsonValue | undefined) {
  return value === null || typeof value === "boolean";
}

function isString(value: CodexJsonValue | undefined): value is string {
  return typeof value === "string";
}

function isNumber(value: CodexJsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asObject(value: CodexJsonValue | undefined): CodexJsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function stringValue(value: CodexJsonValue | undefined) {
  return typeof value === "string" ? value : null;
}
