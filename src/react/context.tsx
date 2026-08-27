import {
  createContext,
  type Dispatch,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  type CodexApprovalDecision,
  type CodexEvent,
  type CodexJsonValue,
  type CodexThreadState,
  createCodexThreadState,
  reduceCodexEvent,
  selectTurns,
} from "../core/index.js";
import {
  type CodexRuntimeStatus,
  type CodexTransport,
  CodexTransportError,
} from "../transport/index.js";

export type CodexThreadController = {
  state: CodexThreadState;
  runtimeStatus: CodexRuntimeStatus | null;
  statusLoading: boolean;
  threadLoading: boolean;
  running: boolean;
  activeTurnId: string | null;
  error: Error | null;
  transport: CodexTransport;
  refreshStatus: () => Promise<void>;
  sendMessage: (message: string) => Promise<boolean>;
  stop: () => Promise<void>;
  loadThread: (thread: string | CodexThreadReference) => Promise<void>;
  respondToApproval: (
    requestId: string | number,
    decision: CodexApprovalDecision,
  ) => Promise<boolean>;
  respondToServerRequest: (
    requestId: string | number,
    result: CodexJsonValue,
  ) => Promise<boolean>;
};

export type CodexThreadReference = {
  /** Stable host-owned conversation key for subsequent turns. */
  conversationId: string;
  /** Native App Server thread id used to load protocol history. */
  threadId: string;
};

export type CodexThreadProviderProps = PropsWithChildren<{
  transport: CodexTransport;
  initialState?: CodexThreadState;
  initialThreadId?: string | null;
  initialConversationId?: string | null;
  createConversationId?: () => string;
  /** @deprecated Use createConversationId; kept as a compatibility alias. */
  createThreadId?: () => string;
  autoRefreshStatus?: boolean;
  onError?: (error: Error) => void;
  onEvent?: (event: CodexEvent, state: CodexThreadState) => void;
}>;

const CodexThreadContext = createContext<CodexThreadController | null>(null);

export function CodexThreadProvider({
  autoRefreshStatus = true,
  children,
  createConversationId,
  createThreadId,
  initialConversationId = null,
  initialState,
  initialThreadId = null,
  onError,
  onEvent,
  transport,
}: CodexThreadProviderProps) {
  const [state, baseDispatch] = useReducer(
    reduceCodexEvent,
    initialState ?? createCodexThreadState(initialThreadId),
  );
  const [runtimeStatus, setRuntimeStatus] = useState<CodexRuntimeStatus | null>(
    null,
  );
  const [statusLoading, setStatusLoading] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const stateRef = useRef(state);
  const conversationIdRef = useRef<string | null>(initialConversationId);
  const abortRef = useRef<AbortController | null>(null);
  const activeTurnIdRef = useRef<string | null>(null);
  const loadEpochRef = useRef(0);
  const loadActiveRef = useRef(false);
  const mountedRef = useRef(false);
  const dispatch = useEventDispatch(baseDispatch, stateRef, onEvent);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const reportError = useCallback(
    (value: unknown) => {
      const nextError = toError(value);
      if (mountedRef.current) {
        setError(nextError);
        onError?.(nextError);
      }
      return nextError;
    },
    [onError],
  );

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    setError(null);
    try {
      const status = await transport.getStatus();
      if (mountedRef.current) setRuntimeStatus(status);
    } catch (value) {
      reportError(value);
      if (mountedRef.current) setRuntimeStatus(null);
    } finally {
      if (mountedRef.current) setStatusLoading(false);
    }
  }, [reportError, transport]);

  useEffect(() => {
    if (autoRefreshStatus) void refreshStatus();
  }, [autoRefreshStatus, refreshStatus]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadEpochRef.current += 1;
      loadActiveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const sendMessage = useCallback(
    async (rawMessage: string) => {
      const message = rawMessage.trim();
      if (!message) return true;
      if (abortRef.current) {
        throw new Error("codex_turn_already_running");
      }
      if (loadActiveRef.current) {
        throw new CodexTransportError(
          "codex_turn_start_while_loading",
          "Cannot start a turn while a thread is loading",
        );
      }

      const controller = new AbortController();
      const conversationId =
        conversationIdRef.current ??
        (createConversationId ?? createThreadId ?? createDefaultId)();
      conversationIdRef.current = conversationId;
      const threadId = stateRef.current.threadId ?? initialThreadId;
      abortRef.current = controller;
      setRunning(true);
      setActiveTurnId(null);
      activeTurnIdRef.current = null;
      setError(null);
      dispatch({ kind: "clearTransportError" });

      try {
        for await (const event of transport.startTurn(
          { conversationId, threadId, message },
          { signal: controller.signal },
        )) {
          if (controller.signal.aborted) break;
          if (event.method === "turn/started") {
            const turn = event.params.turn;
            if (turn && typeof turn === "object" && !Array.isArray(turn)) {
              const id = turn.id;
              if (typeof id === "string") {
                activeTurnIdRef.current = id;
                setActiveTurnId(id);
              }
            }
          }
          dispatch(event);
        }
        return true;
      } catch (value) {
        if (controller.signal.aborted || isAbortError(value)) return true;
        const nextError = reportError(value);
        dispatch({
          kind: "transportError",
          threadId: stateRef.current.threadId ?? threadId,
          turnId: activeTurnIdRef.current,
          code: readErrorCode(nextError),
          message: nextError.message,
          occurredAt: Date.now(),
        });
        return false;
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          activeTurnIdRef.current = null;
          if (mountedRef.current) {
            setRunning(false);
            setActiveTurnId(null);
          }
        }
      }
    },
    [
      createConversationId,
      createThreadId,
      dispatch,
      initialThreadId,
      reportError,
      transport,
    ],
  );

  const stop = useCallback(async () => {
    const controller = abortRef.current;
    if (!controller) return;
    const threadId = stateRef.current.threadId;
    const turnId =
      activeTurnIdRef.current ?? findRunningTurnId(stateRef.current);
    abortRef.current = null;
    controller.abort();
    activeTurnIdRef.current = null;
    setActiveTurnId(null);
    setRunning(false);
    if (turnId) {
      dispatch({
        kind: "turnInterrupted",
        threadId,
        turnId,
        interruptedAt: Date.now(),
      });
    }
    if (transport.capabilities.interrupt && threadId && turnId) {
      void Promise.resolve()
        .then(() => transport.interruptTurn({ threadId, turnId }))
        .catch((value) => {
          if (!mountedRef.current) return;
          const nextError = reportError(value);
          dispatch({
            kind: "transportError",
            threadId,
            turnId,
            code: readErrorCode(nextError),
            message: nextError.message,
            occurredAt: Date.now(),
          });
        });
    }
  }, [dispatch, reportError, transport]);

  const loadThread = useCallback(
    async (thread: string | CodexThreadReference) => {
      if (abortRef.current) {
        reportError(
          new CodexTransportError(
            "codex_thread_load_while_running",
            "Cannot load a thread while a turn is running",
          ),
        );
        return;
      }
      const reference =
        typeof thread === "string"
          ? { conversationId: thread, threadId: thread }
          : thread;
      const epoch = loadEpochRef.current + 1;
      loadEpochRef.current = epoch;
      loadActiveRef.current = true;
      setThreadLoading(true);
      setError(null);
      try {
        const events = await transport.loadThread({
          threadId: reference.threadId,
        });
        if (!mountedRef.current || loadEpochRef.current !== epoch) return;
        conversationIdRef.current = reference.conversationId;
        dispatch({ kind: "resetThread", threadId: reference.threadId });
        for (const event of events) dispatch(event);
      } catch (value) {
        if (mountedRef.current && loadEpochRef.current === epoch) {
          reportError(value);
        }
      } finally {
        if (mountedRef.current && loadEpochRef.current === epoch) {
          loadActiveRef.current = false;
          setThreadLoading(false);
        }
      }
    },
    [dispatch, reportError, transport],
  );

  const respondToApproval = useCallback(
    async (requestId: string | number, decision: CodexApprovalDecision) => {
      setError(null);
      try {
        const approval = stateRef.current.approvalsById[String(requestId)];
        if (!approval || approval.status !== "pending") {
          throw new CodexTransportError(
            "codex_approval_not_found",
            "Approval request is no longer pending",
          );
        }
        if (
          !approval.availableDecisions.some((entry) =>
            approvalDecisionEquals(entry, decision),
          )
        ) {
          throw new CodexTransportError(
            "codex_approval_decision_unavailable",
            "Approval decision was not offered by the server",
          );
        }
        await transport.respondToApproval({
          requestId,
          method: approval.method,
          decision,
        });
        dispatch({
          kind: "approvalResolved",
          requestId,
          decision,
          resolvedAt: Date.now(),
        });
        return true;
      } catch (value) {
        reportError(value);
        return false;
      }
    },
    [dispatch, reportError, transport],
  );

  const respondToServerRequest = useCallback(
    async (requestId: string | number, result: CodexJsonValue) => {
      setError(null);
      try {
        const request = stateRef.current.serverRequestsById[String(requestId)];
        if (!request || request.status !== "pending") {
          throw new CodexTransportError(
            "codex_server_request_not_found",
            "Server request is no longer pending",
          );
        }
        await transport.respondToServerRequest({
          requestId,
          method: request.method,
          result,
        });
        dispatch({
          kind: "serverRequestResponded",
          requestId,
          resolvedAt: Date.now(),
        });
        return true;
      } catch (value) {
        reportError(value);
        return false;
      }
    },
    [dispatch, reportError, transport],
  );

  const value = useMemo<CodexThreadController>(
    () => ({
      state,
      runtimeStatus,
      statusLoading,
      threadLoading,
      running,
      activeTurnId,
      error,
      transport,
      refreshStatus,
      sendMessage,
      stop,
      loadThread,
      respondToApproval,
      respondToServerRequest,
    }),
    [
      activeTurnId,
      error,
      loadThread,
      refreshStatus,
      respondToApproval,
      respondToServerRequest,
      running,
      runtimeStatus,
      sendMessage,
      state,
      statusLoading,
      stop,
      threadLoading,
      transport,
    ],
  );

  return (
    <CodexThreadContext.Provider value={value}>
      {children}
    </CodexThreadContext.Provider>
  );
}

export function useCodexThread() {
  const context = useContext(CodexThreadContext);
  if (!context) {
    throw new Error("useCodexThread must be used inside CodexThreadProvider");
  }
  return context;
}

function useEventDispatch(
  dispatch: Dispatch<CodexEvent>,
  stateRef: { current: CodexThreadState },
  onEvent: CodexThreadProviderProps["onEvent"],
) {
  return useCallback(
    (event: CodexEvent) => {
      const nextState = reduceCodexEvent(stateRef.current, event);
      stateRef.current = nextState;
      dispatch(event);
      onEvent?.(event, nextState);
    },
    [dispatch, onEvent, stateRef],
  );
}

function findRunningTurnId(state: CodexThreadState) {
  return (
    [...selectTurns(state)]
      .reverse()
      .find((turn) => turn.status === "inProgress")?.id ?? null
  );
}

function createDefaultId() {
  const runtimeCrypto = globalThis.crypto;
  if (typeof runtimeCrypto?.randomUUID === "function") {
    return runtimeCrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof runtimeCrypto?.getRandomValues === "function") {
    runtimeCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function isAbortError(value: unknown) {
  return value instanceof Error && value.name === "AbortError";
}

function toError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}

function readErrorCode(error: Error) {
  return "code" in error && typeof error.code === "string"
    ? error.code
    : "codex_transport_error";
}

function approvalDecisionEquals(
  left: CodexApprovalDecision,
  right: CodexApprovalDecision,
) {
  if (typeof left === "string" || typeof right === "string") {
    return left === right;
  }
  if ("acceptWithExecpolicyAmendment" in left) {
    if (!("acceptWithExecpolicyAmendment" in right)) return false;
    const leftAmendment =
      left.acceptWithExecpolicyAmendment.execpolicy_amendment;
    const rightAmendment =
      right.acceptWithExecpolicyAmendment.execpolicy_amendment;
    return (
      leftAmendment.length === rightAmendment.length &&
      leftAmendment.every((entry, index) => entry === rightAmendment[index])
    );
  }
  if (!("applyNetworkPolicyAmendment" in right)) return false;
  const leftAmendment =
    left.applyNetworkPolicyAmendment.network_policy_amendment;
  const rightAmendment =
    right.applyNetworkPolicyAmendment.network_policy_amendment;
  return (
    leftAmendment.host === rightAmendment.host &&
    leftAmendment.action === rightAmendment.action
  );
}
