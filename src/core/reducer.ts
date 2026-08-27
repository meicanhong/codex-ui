import type {
  CodexApprovalDecision,
  CodexAppServerEnvelope,
  CodexEvent,
  CodexNetworkPolicyAmendment,
} from "./events.js";
import { normalizeCodexThreadItem } from "./normalizer.js";
import type {
  CodexErrorInfo,
  CodexJsonObject,
  CodexJsonValue,
  CodexRenderableThreadItem,
  CodexThreadTokenUsage,
  CodexTurnError,
  CodexTurnPlan,
  CodexTurnStatus,
} from "./protocol.js";
import {
  type CodexItemState,
  type CodexThreadState,
  type CodexTurnState,
  createCodexThreadState,
  createCodexTurnState,
} from "./state.js";

export function reduceCodexEvent(
  state: CodexThreadState,
  event: CodexEvent,
): CodexThreadState {
  if (event.kind === "resetThread") {
    return createCodexThreadState(event.threadId);
  }

  if (event.kind === "clearTransportError") {
    return state.lastError ? { ...state, lastError: null } : state;
  }

  if (event.kind === "turnInterrupted") {
    const turn = state.turnsById[event.turnId];
    if (!turn || turn.status !== "inProgress") return state;
    const interruptedState: CodexThreadState = {
      ...state,
      approvalsById: failPendingRequests(
        state.approvalsById,
        event.turnId,
        event.interruptedAt,
      ),
      serverRequestsById: failPendingRequests(
        state.serverRequestsById,
        event.turnId,
        event.interruptedAt,
      ),
    };
    return upsertTurn(
      interruptedState,
      {
        ...turn,
        status: "interrupted",
        completedAt: event.interruptedAt,
        durationMs:
          turn.startedAt === null
            ? turn.durationMs
            : Math.max(0, event.interruptedAt - turn.startedAt),
      },
      event.threadId,
    );
  }

  if (event.kind === "approvalResolved") {
    const key = String(event.requestId);
    const approval = state.approvalsById[key];
    if (!approval || approval.status !== "pending") return state;
    const request = state.serverRequestsById[key];
    return {
      ...state,
      approvalsById: {
        ...state.approvalsById,
        [key]: {
          ...approval,
          status: "resolved",
          decision: event.decision,
          resolvedAt: event.resolvedAt,
        },
      },
      serverRequestsById:
        request?.status === "pending"
          ? {
              ...state.serverRequestsById,
              [key]: {
                ...request,
                status: "resolved",
                resolvedAt: event.resolvedAt,
              },
            }
          : state.serverRequestsById,
    };
  }

  if (event.kind === "serverRequestResponded") {
    const key = String(event.requestId);
    const request = state.serverRequestsById[key];
    if (!request || request.status !== "pending") return state;
    return {
      ...state,
      serverRequestsById: {
        ...state.serverRequestsById,
        [key]: {
          ...request,
          status: "resolved",
          resolvedAt: event.resolvedAt,
        },
      },
    };
  }

  if (event.kind === "transportError") {
    const next: CodexThreadState = {
      ...state,
      approvalsById: failPendingRequests(
        state.approvalsById,
        event.turnId,
        event.occurredAt,
      ),
      serverRequestsById: failPendingRequests(
        state.serverRequestsById,
        event.turnId,
        event.occurredAt,
      ),
      lastError: {
        code: event.code,
        message: event.message,
        threadId: event.threadId,
        turnId: event.turnId,
        occurredAt: event.occurredAt,
      },
    };
    if (!event.turnId) return next;
    const turn = next.turnsById[event.turnId];
    if (!turn || turn.status !== "inProgress") return next;
    return upsertTurn(
      next,
      {
        ...turn,
        status: "failed",
        completedAt: event.occurredAt,
        durationMs:
          turn.startedAt === null
            ? turn.durationMs
            : Math.max(0, event.occurredAt - turn.startedAt),
      },
      event.threadId,
    );
  }

  const eventKey = createEventKey(event);
  if (state.seenEventKeys.includes(eventKey)) return state;
  const streamId = event.streamId;
  if (
    streamId !== undefined &&
    event.sequence <= (state.latestSequenceByStream[streamId] ?? -1)
  ) {
    return state;
  }

  const next = {
    ...state,
    seenEventKeys: [...state.seenEventKeys, eventKey],
    latestSequenceByStream:
      streamId !== undefined
        ? {
            ...state.latestSequenceByStream,
            [streamId]: event.sequence,
          }
        : state.latestSequenceByStream,
  };

  if (event.kind === "serverRequest") {
    return applyServerRequest(next, event);
  }

  switch (event.method) {
    case "turn/started":
      return applyTurnSnapshot(next, event, "inProgress");
    case "turn/completed":
      return applyTurnSnapshot(next, event, null);
    case "item/started":
      return applyItemSnapshot(next, event, "started");
    case "item/completed":
      return applyItemSnapshot(next, event, "completed");
    case "item/agentMessage/delta":
      return applyTextDelta(next, event, "agentMessage");
    case "item/reasoning/summaryTextDelta":
      return applyIndexedTextDelta(next, event, "summary", "reasoning");
    case "item/reasoning/summaryPartAdded":
      return applyReasoningSummaryPartAdded(next, event);
    case "item/reasoning/textDelta":
      return applyIndexedTextDelta(next, event, "content", "reasoning");
    case "item/commandExecution/outputDelta":
      return applyTextDelta(next, event, "commandExecution");
    case "item/fileChange/patchUpdated":
      return applyFileChangePatchUpdated(next, event);
    case "item/plan/delta":
      return applyTextDelta(next, event, "plan");
    case "item/mcpToolCall/progress":
      return applyProgress(next, event);
    case "turn/plan/updated":
      return applyPlan(next, event);
    case "turn/diff/updated":
      return applyTurnDiff(next, event);
    case "thread/tokenUsage/updated":
      return applyTokenUsage(next, event);
    case "serverRequest/resolved":
      return applyServerRequestResolved(next, event);
    case "error":
      return applyProtocolError(next, event);
    default:
      return { ...next, unknownEvents: [...next.unknownEvents, event] };
  }
}

function applyTurnSnapshot(
  state: CodexThreadState,
  event: CodexAppServerEnvelope,
  forcedStatus: CodexTurnStatus | null,
): CodexThreadState {
  const turnValue = asObject(event.params.turn);
  const turnId = stringValue(turnValue?.id);
  const threadId = stringValue(event.params.threadId);
  if (!turnId) return preserveUnknown(state, event);

  const current = state.turnsById[turnId] ?? createCodexTurnState(turnId);
  let turn = {
    ...current,
    status:
      forcedStatus ?? parseTurnStatus(turnValue?.status) ?? current.status,
    error: parseTurnError(turnValue?.error),
    startedAt: turnTimestampMs(turnValue?.startedAt) ?? current.startedAt,
    completedAt: turnTimestampMs(turnValue?.completedAt) ?? current.completedAt,
    durationMs: numberOrNull(turnValue?.durationMs) ?? current.durationMs,
  };

  const items = Array.isArray(turnValue?.items) ? turnValue.items : [];
  for (const rawItem of items) {
    const normalized = normalizeCodexThreadItem(rawItem);
    if (!normalized) continue;
    turn = upsertItem(
      turn,
      normalized,
      "completed",
      event.sequence,
      null,
      null,
      asObject(rawItem) ?? {},
    );
  }
  const updated = upsertTurn(state, turn, threadId);
  if (event.method !== "turn/completed") return updated;
  return clearTerminalProtocolError(updated, turn);
}

function clearTerminalProtocolError(
  state: CodexThreadState,
  turn: CodexTurnState,
): CodexThreadState {
  const error = state.lastError;
  if (
    !error ||
    error.code !== "codex_app_server_error" ||
    error.turnId !== turn.id
  ) {
    return state;
  }
  if (turn.status === "failed" && !turn.error) return state;
  return { ...state, lastError: null };
}

function applyItemSnapshot(
  state: CodexThreadState,
  event: CodexAppServerEnvelope,
  lifecycle: "started" | "completed",
): CodexThreadState {
  const turnId = stringValue(event.params.turnId);
  const threadId = stringValue(event.params.threadId);
  const item = normalizeCodexThreadItem(event.params.item);
  if (!turnId || !item) return preserveUnknown(state, event);

  const current = state.turnsById[turnId] ?? createCodexTurnState(turnId);
  const turn = upsertItem(
    current,
    item,
    lifecycle,
    event.sequence,
    numberOrNull(event.params.startedAtMs),
    numberOrNull(event.params.completedAtMs),
    asObject(event.params.item) ?? {},
  );
  return upsertTurn(state, turn, threadId);
}

function applyTextDelta(
  state: CodexThreadState,
  event: CodexAppServerEnvelope,
  itemType: "agentMessage" | "commandExecution" | "plan",
): CodexThreadState {
  const location = readItemLocation(event);
  const delta = stringValue(event.params.delta);
  if (!location || delta === null) return preserveUnknown(state, event);

  const currentTurn =
    state.turnsById[location.turnId] ?? createCodexTurnState(location.turnId);
  const currentItem = currentTurn.itemsById[location.itemId];
  if (currentItem?.lifecycle === "completed") return state;

  const item =
    currentItem?.item ?? createPlaceholderItem(itemType, location.itemId);
  let updatedItem: CodexRenderableThreadItem;
  if (item.type === "agentMessage") {
    updatedItem = { ...item, text: item.text + delta };
  } else if (item.type === "commandExecution") {
    updatedItem = {
      ...item,
      aggregatedOutput: `${item.aggregatedOutput ?? ""}${delta}`,
    };
  } else if (item.type === "plan") {
    updatedItem = { ...item, text: item.text + delta };
  } else {
    return preserveUnknown(state, event);
  }

  const turn = upsertItem(
    currentTurn,
    updatedItem,
    "started",
    event.sequence,
    null,
    null,
    currentItem?.raw ?? {},
  );
  return upsertTurn(state, turn, location.threadId);
}

function applyIndexedTextDelta(
  state: CodexThreadState,
  event: CodexAppServerEnvelope,
  field: "summary" | "content",
  itemType: "reasoning",
): CodexThreadState {
  const location = readItemLocation(event);
  const delta = stringValue(event.params.delta);
  const index = numberValue(
    event.params[field === "summary" ? "summaryIndex" : "contentIndex"],
  );
  if (!location || delta === null || index === null || index < 0) {
    return preserveUnknown(state, event);
  }

  const currentTurn =
    state.turnsById[location.turnId] ?? createCodexTurnState(location.turnId);
  const currentItem = currentTurn.itemsById[location.itemId];
  if (currentItem?.lifecycle === "completed") return state;
  const item =
    currentItem?.item ?? createPlaceholderItem(itemType, location.itemId);
  if (item.type !== "reasoning") return preserveUnknown(state, event);

  const values = [...item[field]];
  while (values.length <= index) values.push("");
  values[index] = `${values[index] ?? ""}${delta}`;
  const updated = { ...item, [field]: values };
  const turn = upsertItem(
    currentTurn,
    updated,
    "started",
    event.sequence,
    null,
    null,
    currentItem?.raw ?? {},
  );
  return upsertTurn(state, turn, location.threadId);
}

function applyReasoningSummaryPartAdded(
  state: CodexThreadState,
  event: CodexAppServerEnvelope,
): CodexThreadState {
  const location = readItemLocation(event);
  const summaryIndex = numberValue(event.params.summaryIndex);
  if (
    !location ||
    summaryIndex === null ||
    !Number.isInteger(summaryIndex) ||
    summaryIndex < 0
  ) {
    return preserveUnknown(state, event);
  }

  const currentTurn =
    state.turnsById[location.turnId] ?? createCodexTurnState(location.turnId);
  const currentItem = currentTurn.itemsById[location.itemId];
  if (currentItem?.lifecycle === "completed") return state;
  const item =
    currentItem?.item ?? createPlaceholderItem("reasoning", location.itemId);
  if (item.type !== "reasoning") return preserveUnknown(state, event);

  const summary = [...item.summary];
  while (summary.length <= summaryIndex) summary.push("");
  const turn = upsertItem(
    currentTurn,
    { ...item, summary },
    "started",
    event.sequence,
    null,
    null,
    currentItem?.raw ?? {},
  );
  return upsertTurn(state, turn, location.threadId);
}

function applyFileChangePatchUpdated(
  state: CodexThreadState,
  event: CodexAppServerEnvelope,
): CodexThreadState {
  const location = readItemLocation(event);
  const changes = event.params.changes;
  if (!location || !Array.isArray(changes)) {
    return preserveUnknown(state, event);
  }

  const currentTurn =
    state.turnsById[location.turnId] ?? createCodexTurnState(location.turnId);
  const currentItem = currentTurn.itemsById[location.itemId];
  if (currentItem?.lifecycle === "completed") return state;
  const currentFileChange =
    currentItem?.item.type === "fileChange" ? currentItem.item : null;
  if (currentItem && !currentFileChange) {
    return preserveUnknown(state, event);
  }

  const candidate = {
    type: "fileChange",
    id: location.itemId,
    changes,
    status: currentFileChange?.status ?? "inProgress",
  } as const;
  const item = normalizeCodexThreadItem(candidate);
  if (!item || item.type !== "fileChange") {
    return preserveUnknown(state, event);
  }

  const turn = upsertItem(
    currentTurn,
    item,
    "started",
    event.sequence,
    null,
    null,
    candidate,
  );
  return upsertTurn(state, turn, location.threadId);
}

function applyProgress(
  state: CodexThreadState,
  event: CodexAppServerEnvelope,
): CodexThreadState {
  const location = readItemLocation(event);
  const message = stringValue(event.params.message);
  if (!location || message === null) return preserveUnknown(state, event);
  const currentTurn =
    state.turnsById[location.turnId] ?? createCodexTurnState(location.turnId);
  const currentItem = currentTurn.itemsById[location.itemId];
  const item =
    currentItem?.item ?? createPlaceholderItem("mcpToolCall", location.itemId);
  const base = currentItem ?? createItemState(item, event.sequence, {});
  const nextItem: CodexItemState = {
    ...base,
    item,
    progress: [...base.progress, message],
    lastSeenSequence: event.sequence,
  };
  const turn = {
    ...currentTurn,
    itemOrder: currentTurn.itemOrder.includes(location.itemId)
      ? currentTurn.itemOrder
      : [...currentTurn.itemOrder, location.itemId],
    itemsById: { ...currentTurn.itemsById, [location.itemId]: nextItem },
  };
  return upsertTurn(state, turn, location.threadId);
}

function applyPlan(
  state: CodexThreadState,
  event: CodexAppServerEnvelope,
): CodexThreadState {
  const turnId = stringValue(event.params.turnId);
  const threadId = stringValue(event.params.threadId);
  const rawPlan = Array.isArray(event.params.plan) ? event.params.plan : null;
  if (!turnId || !rawPlan) return preserveUnknown(state, event);
  const steps = rawPlan.flatMap((entry) => {
    const value = asObject(entry);
    const step = stringValue(value?.step);
    const status = stringValue(value?.status);
    if (!step || !isPlanStatus(status)) return [];
    return [{ step, status }];
  });
  const plan: CodexTurnPlan = {
    explanation: stringValue(event.params.explanation),
    steps,
  };
  const turn = state.turnsById[turnId] ?? createCodexTurnState(turnId);
  return upsertTurn(state, { ...turn, plan }, threadId);
}

function applyTurnDiff(
  state: CodexThreadState,
  event: CodexAppServerEnvelope,
): CodexThreadState {
  const turnId = stringValue(event.params.turnId);
  const threadId = stringValue(event.params.threadId);
  const diff = stringValue(event.params.diff);
  if (!turnId || diff === null) return preserveUnknown(state, event);
  const turn = state.turnsById[turnId] ?? createCodexTurnState(turnId);
  return upsertTurn(state, { ...turn, diff }, threadId);
}

function applyTokenUsage(
  state: CodexThreadState,
  event: CodexAppServerEnvelope,
): CodexThreadState {
  const tokenUsage = parseTokenUsage(event.params.tokenUsage);
  if (!tokenUsage) return preserveUnknown(state, event);
  return {
    ...state,
    threadId: stringValue(event.params.threadId) ?? state.threadId,
    tokenUsage,
  };
}

function applyProtocolError(
  state: CodexThreadState,
  event: CodexAppServerEnvelope,
): CodexThreadState {
  const error = parseTurnError(event.params.error);
  const willRetry = event.params.willRetry;
  if (!error || typeof willRetry !== "boolean") {
    return preserveUnknown(state, event);
  }
  const turnId = stringValue(event.params.turnId);
  if (willRetry) {
    return state.lastError?.code === "codex_app_server_error" &&
      state.lastError.turnId === turnId
      ? { ...state, lastError: null }
      : state;
  }
  return {
    ...state,
    lastError: {
      code: "codex_app_server_error",
      message: error.message,
      threadId: stringValue(event.params.threadId),
      turnId,
      occurredAt: event.receivedAt,
    },
  };
}

function applyServerRequest(
  state: CodexThreadState,
  event: Extract<CodexAppServerEnvelope, { kind: "serverRequest" }>,
): CodexThreadState {
  const key = String(event.requestId);
  const legacyApproval = isLegacyApprovalRequest(event.method);
  const threadId =
    stringValue(event.params.threadId) ??
    (legacyApproval ? stringValue(event.params.conversationId) : null);
  const turnId =
    stringValue(event.params.turnId) ??
    (legacyApproval ? findActiveTurnId(state, threadId) : null);
  const request = {
    requestId: event.requestId,
    method: event.method,
    threadId,
    turnId,
    itemId:
      stringValue(event.params.itemId) ??
      (legacyApproval ? stringValue(event.params.callId) : null),
    status: "pending" as const,
    receivedAt: event.receivedAt,
    resolvedAt: null,
    params: event.params,
    raw: event.raw,
  };
  const next: CodexThreadState = {
    ...state,
    threadId: request.threadId ?? state.threadId,
    serverRequestsById: {
      ...state.serverRequestsById,
      [key]: request,
    },
  };
  if (!isApprovalRequest(event.method)) return next;
  const availableDecisions = parseAvailableApprovalDecisions(event);
  if (!availableDecisions) {
    return preserveUnknown(next, event);
  }
  return {
    ...next,
    approvalsById: {
      ...next.approvalsById,
      [key]: {
        requestId: event.requestId,
        method: event.method,
        threadId: request.threadId,
        turnId: request.turnId,
        itemId: request.itemId,
        reason: stringValue(event.params.reason),
        startedAtMs: numberOrNull(event.params.startedAtMs),
        availableDecisions,
        status: "pending",
        decision: null,
        resolvedAt: null,
        params: event.params,
        raw: event.raw,
      },
    },
  };
}

function parseAvailableApprovalDecisions(
  event: Extract<CodexAppServerEnvelope, { kind: "serverRequest" }>,
): CodexApprovalDecision[] | null {
  const raw = event.params.availableDecisions;
  if (raw === undefined || raw === null) {
    return deriveDefaultApprovalDecisions(event);
  }
  if (
    event.method !== "item/commandExecution/requestApproval" ||
    !Array.isArray(raw)
  ) {
    return null;
  }

  const decisions: CodexApprovalDecision[] = [];
  for (const value of raw) {
    const decision = parseApprovalDecision(value);
    if (!decision) return null;
    decisions.push(decision);
  }
  return decisions;
}

function deriveDefaultApprovalDecisions(
  event: Extract<CodexAppServerEnvelope, { kind: "serverRequest" }>,
): CodexApprovalDecision[] {
  if (
    event.method === "item/fileChange/requestApproval" ||
    event.method === "applyPatchApproval"
  ) {
    return ["accept", "acceptForSession", "cancel"];
  }
  if (event.method === "execCommandApproval") {
    return ["accept", "cancel"];
  }

  const networkContext = asObject(event.params.networkApprovalContext);
  if (networkContext) {
    const decisions: CodexApprovalDecision[] = ["accept", "acceptForSession"];
    const amendments = event.params.proposedNetworkPolicyAmendments;
    if (Array.isArray(amendments)) {
      const amendment = amendments
        .map(parseNetworkPolicyAmendment)
        .find((entry) => entry?.action === "allow");
      if (amendment) {
        decisions.push({
          applyNetworkPolicyAmendment: {
            network_policy_amendment: amendment,
          },
        });
      }
    }
    decisions.push("cancel");
    return decisions;
  }

  if (asObject(event.params.additionalPermissions)) {
    return ["accept", "cancel"];
  }

  const decisions: CodexApprovalDecision[] = ["accept"];
  const execPolicy = event.params.proposedExecpolicyAmendment;
  if (Array.isArray(execPolicy) && execPolicy.every(isString)) {
    decisions.push({
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: execPolicy,
      },
    });
  }
  decisions.push("cancel");
  return decisions;
}

function parseNetworkPolicyAmendment(
  value: CodexJsonValue,
): CodexNetworkPolicyAmendment | null {
  const amendment = asObject(value);
  const host = stringValue(amendment?.host);
  const action = amendment?.action;
  return host !== null && (action === "allow" || action === "deny")
    ? { host, action }
    : null;
}

function parseApprovalDecision(
  value: CodexJsonValue,
): CodexApprovalDecision | null {
  if (
    value === "accept" ||
    value === "acceptForSession" ||
    value === "decline" ||
    value === "cancel"
  ) {
    return value;
  }

  const decision = asObject(value);
  const execPolicy = asObject(decision?.acceptWithExecpolicyAmendment);
  const amendment = execPolicy?.execpolicy_amendment;
  if (Array.isArray(amendment) && amendment.every(isString)) {
    return {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: amendment,
      },
    };
  }

  const networkPolicy = asObject(decision?.applyNetworkPolicyAmendment);
  const networkAmendment = asObject(networkPolicy?.network_policy_amendment);
  const host = stringValue(networkAmendment?.host);
  const action = networkAmendment?.action;
  return host !== null && (action === "allow" || action === "deny")
    ? {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: { host, action },
        },
      }
    : null;
}

function applyServerRequestResolved(
  state: CodexThreadState,
  event: CodexAppServerEnvelope,
): CodexThreadState {
  const requestId = event.params.requestId;
  if (typeof requestId !== "string" && typeof requestId !== "number") {
    return preserveUnknown(state, event);
  }
  const key = String(requestId);
  const request = state.serverRequestsById[key];
  const approval = state.approvalsById[key];
  if (!request && !approval) return state;
  return {
    ...state,
    serverRequestsById: request
      ? {
          ...state.serverRequestsById,
          [key]: {
            ...request,
            status: "resolved",
            resolvedAt: event.receivedAt,
          },
        }
      : state.serverRequestsById,
    approvalsById: approval
      ? {
          ...state.approvalsById,
          [key]: {
            ...approval,
            status: "resolved",
            resolvedAt: event.receivedAt,
          },
        }
      : state.approvalsById,
  };
}

function isApprovalRequest(method: string) {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "applyPatchApproval" ||
    method === "execCommandApproval"
  );
}

function isLegacyApprovalRequest(method: string) {
  return method === "applyPatchApproval" || method === "execCommandApproval";
}

function findActiveTurnId(state: CodexThreadState, threadId: string | null) {
  if (threadId && state.threadId && threadId !== state.threadId) return null;
  for (let index = state.turnOrder.length - 1; index >= 0; index -= 1) {
    const turnId = state.turnOrder[index];
    if (turnId && state.turnsById[turnId]?.status === "inProgress") {
      return turnId;
    }
  }
  return null;
}

function failPendingRequests<
  T extends {
    status: "pending" | "resolved" | "failed";
    turnId: string | null;
    resolvedAt: number | null;
  },
>(records: Record<string, T>, turnId: string | null, failedAt: number) {
  if (!turnId) return records;
  let changed = false;
  const next = Object.fromEntries(
    Object.entries(records).map(([key, value]) => {
      if (value.status !== "pending" || value.turnId !== turnId) {
        return [key, value];
      }
      changed = true;
      return [key, { ...value, status: "failed", resolvedAt: failedAt }];
    }),
  ) as Record<string, T>;
  return changed ? next : records;
}

function upsertTurn(
  state: CodexThreadState,
  turn: CodexTurnState,
  threadId: string | null,
): CodexThreadState {
  return {
    ...state,
    threadId: threadId ?? state.threadId,
    turnOrder: state.turnOrder.includes(turn.id)
      ? state.turnOrder
      : [...state.turnOrder, turn.id],
    turnsById: { ...state.turnsById, [turn.id]: turn },
  };
}

function upsertItem(
  turn: CodexTurnState,
  item: CodexRenderableThreadItem,
  lifecycle: "started" | "completed",
  sequence: number,
  startedAtMs: number | null,
  completedAtMs: number | null,
  raw: CodexJsonObject,
): CodexTurnState {
  const existing = turn.itemsById[item.id];
  if (existing?.lifecycle === "completed" && lifecycle === "started")
    return turn;
  const nextItem: CodexItemState = existing
    ? {
        ...existing,
        item,
        lifecycle,
        lastSeenSequence: sequence,
        startedAtMs: startedAtMs ?? existing.startedAtMs,
        completedAtMs: completedAtMs ?? existing.completedAtMs,
        raw,
      }
    : {
        ...createItemState(item, sequence, raw),
        lifecycle,
        startedAtMs,
        completedAtMs,
      };
  return {
    ...turn,
    itemOrder: turn.itemOrder.includes(item.id)
      ? turn.itemOrder
      : [...turn.itemOrder, item.id],
    itemsById: { ...turn.itemsById, [item.id]: nextItem },
  };
}

function createItemState(
  item: CodexRenderableThreadItem,
  sequence: number,
  raw: CodexJsonObject,
): CodexItemState {
  return {
    id: item.id,
    item,
    lifecycle: "started",
    firstSeenSequence: sequence,
    lastSeenSequence: sequence,
    startedAtMs: null,
    completedAtMs: null,
    progress: [],
    raw,
  };
}

function createPlaceholderItem(
  type:
    | "agentMessage"
    | "reasoning"
    | "commandExecution"
    | "plan"
    | "mcpToolCall",
  id: string,
): CodexRenderableThreadItem {
  if (type === "agentMessage") {
    return { type, id, text: "", phase: null, memoryCitation: null };
  }
  if (type === "reasoning") return { type, id, summary: [], content: [] };
  if (type === "plan") return { type, id, text: "" };
  if (type === "commandExecution") {
    return {
      type,
      id,
      command: "",
      cwd: "",
      processId: null,
      source: "agent",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: "",
      exitCode: null,
      durationMs: null,
    };
  }
  return {
    type,
    id,
    server: "",
    tool: "",
    status: "inProgress",
    arguments: null,
    appContext: null,
    pluginId: null,
    result: null,
    error: null,
    durationMs: null,
  };
}

function readItemLocation(event: CodexAppServerEnvelope) {
  const threadId = stringValue(event.params.threadId);
  const turnId = stringValue(event.params.turnId);
  const itemId = stringValue(event.params.itemId);
  return turnId && itemId ? { threadId, turnId, itemId } : null;
}

function parseTurnStatus(
  value: CodexJsonValue | undefined,
): CodexTurnStatus | null {
  return value === "completed" ||
    value === "interrupted" ||
    value === "failed" ||
    value === "inProgress"
    ? value
    : null;
}

function parseTurnError(
  value: CodexJsonValue | undefined,
): CodexTurnError | null {
  if (value === null || value === undefined) return null;
  const error = asObject(value);
  const message = stringValue(error?.message);
  if (!error || message === null) return null;
  return {
    message,
    codexErrorInfo: parseCodexErrorInfo(error.codexErrorInfo),
    additionalDetails: stringValue(error.additionalDetails),
  };
}

function parseCodexErrorInfo(
  value: CodexJsonValue | undefined,
): CodexErrorInfo | null {
  if (
    value === "contextWindowExceeded" ||
    value === "usageLimitExceeded" ||
    value === "serverOverloaded" ||
    value === "cyberPolicy" ||
    value === "internalServerError" ||
    value === "unauthorized" ||
    value === "badRequest" ||
    value === "threadRollbackFailed" ||
    value === "sandboxError" ||
    value === "other"
  ) {
    return value;
  }
  const object = asObject(value);
  if (!object) return null;
  const httpKeys = [
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
  ] as const;
  for (const key of httpKeys) {
    const details = asObject(object[key]);
    const status = numberOrNull(details?.httpStatusCode);
    if (details && (details.httpStatusCode === null || status !== null)) {
      return { [key]: { httpStatusCode: status } } as CodexErrorInfo;
    }
  }
  const activeTurn = asObject(object.activeTurnNotSteerable);
  const turnKind = stringValue(activeTurn?.turnKind);
  return turnKind === "review" || turnKind === "compact"
    ? { activeTurnNotSteerable: { turnKind } }
    : null;
}

function parseTokenUsage(
  value: CodexJsonValue | undefined,
): CodexThreadTokenUsage | null {
  const usage = asObject(value);
  const total = parseTokenBreakdown(usage?.total);
  const last = parseTokenBreakdown(usage?.last);
  if (!usage || !total || !last) return null;
  return {
    total,
    last,
    modelContextWindow: numberOrNull(usage.modelContextWindow),
  };
}

function parseTokenBreakdown(value: CodexJsonValue | undefined) {
  const breakdown = asObject(value);
  if (!breakdown) return null;
  const keys = [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ] as const;
  const values = keys.map((key) => numberValue(breakdown[key]));
  if (values.some((entry) => entry === null)) return null;
  return {
    totalTokens: values[0] as number,
    inputTokens: values[1] as number,
    cachedInputTokens: values[2] as number,
    outputTokens: values[3] as number,
    reasoningOutputTokens: values[4] as number,
  };
}

function isPlanStatus(
  value: string | null,
): value is "pending" | "inProgress" | "completed" {
  return value === "pending" || value === "inProgress" || value === "completed";
}

function preserveUnknown(
  state: CodexThreadState,
  event: CodexAppServerEnvelope,
): CodexThreadState {
  return { ...state, unknownEvents: [...state.unknownEvents, event] };
}

function createEventKey(event: CodexAppServerEnvelope) {
  if (event.streamId) return `${event.streamId}:${event.sequence}`;
  const turn = asObject(event.params.turn);
  const turnId = stringValue(event.params.turnId) ?? stringValue(turn?.id);
  const threadId = stringValue(event.params.threadId) ?? "unknown-thread";
  const scope =
    turnId ??
    (event.kind === "serverRequest"
      ? `request:${String(event.requestId)}`
      : `${event.method}:${event.receivedAt}`);
  return `${threadId}:${scope}:${event.sequence}`;
}

function asObject(value: CodexJsonValue | undefined): CodexJsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function stringValue(value: CodexJsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function isString(value: CodexJsonValue): value is string {
  return typeof value === "string";
}

function numberValue(value: CodexJsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOrNull(value: CodexJsonValue | undefined): number | null {
  return value === null || value === undefined ? null : numberValue(value);
}

function turnTimestampMs(value: CodexJsonValue | undefined): number | null {
  const timestamp = numberOrNull(value);
  if (timestamp === null) return null;
  // Turn snapshots use Unix seconds; item `*AtMs` and local controller events
  // already use milliseconds.
  return timestamp >= 1_000_000_000 && timestamp < 100_000_000_000
    ? timestamp * 1_000
    : timestamp;
}

export { createCodexThreadState };
