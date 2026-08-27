import type {
  CodexApprovalDecision,
  CodexAppServerEnvelope,
  CodexJsonObject,
  CodexJsonValue,
} from "../core/index.js";
import { CodexSseDecoder, parseAppServerEnvelopeFrame } from "./sse-parser.js";
import {
  type CodexRuntimeStatus,
  type CodexStartTurnRequest,
  type CodexTransport,
  CodexTransportError,
  CodexTransportUnsupportedError,
} from "./types.js";

type RequestHeaders = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);

export type CodexFetchSseTransportOptions = {
  statusUrl: string;
  startTurnUrl: string;
  interruptTurnUrl?: string | ((threadId: string, turnId: string) => string);
  loadThreadUrl?: string | ((threadId: string) => string);
  approvalUrl?: string;
  serverRequestUrl?: string;
  headers?: RequestHeaders;
  fetch?: typeof globalThis.fetch;
  serializeStartTurn?: (request: CodexStartTurnRequest) => CodexJsonObject;
  serializeInterrupt?: (threadId: string, turnId: string) => CodexJsonObject;
  serializeApproval?: (
    requestId: string | number,
    method: string,
    decision: CodexApprovalDecision,
  ) => CodexJsonObject;
  serializeServerRequestResponse?: (
    requestId: string | number,
    method: string,
    result: CodexJsonValue,
  ) => CodexJsonObject;
  parseStatus?: (value: CodexJsonObject) => CodexRuntimeStatus;
  /** Timeout for status/load/interrupt/approval/request HTTP operations. Defaults to 30s; 0 disables it. */
  requestTimeoutMs?: number;
  /** Timeout for receiving the initial start-turn SSE response. Defaults to 60s; 0 disables it. */
  turnStartTimeoutMs?: number;
  /** Maximum silence between SSE chunks. Defaults to 5 minutes; 0 disables it. */
  streamIdleTimeoutMs?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_START_TIMEOUT_MS = 60_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

export function createFetchSseCodexTransport(
  options: CodexFetchSseTransportOptions,
): CodexTransport {
  const request = options.fetch ?? globalThis.fetch;
  if (!request) {
    throw new CodexTransportError(
      "codex_transport_fetch_unavailable",
      "This environment does not provide fetch",
    );
  }
  const requestTimeoutMs = normalizeTimeout(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    "requestTimeoutMs",
  );
  const turnStartTimeoutMs = normalizeTimeout(
    options.turnStartTimeoutMs,
    options.requestTimeoutMs ?? DEFAULT_TURN_START_TIMEOUT_MS,
    "turnStartTimeoutMs",
  );
  const streamIdleTimeoutMs = normalizeTimeout(
    options.streamIdleTimeoutMs,
    DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    "streamIdleTimeoutMs",
  );

  return {
    capabilities: {
      interrupt: Boolean(options.interruptTurnUrl),
      loadThread: Boolean(options.loadThreadUrl),
      approvals: Boolean(options.approvalUrl),
      serverRequests: Boolean(options.serverRequestUrl),
    },
    async getStatus(requestOptions) {
      return runRequestWithTimeout(
        "status",
        requestTimeoutMs,
        requestOptions?.signal,
        async (signal) => {
          const response = await request(options.statusUrl, {
            headers: await resolveHeaders(options.headers),
            signal,
          });
          const value =
            response.ok || response.status === 503
              ? await readJsonObject(response, "codex_status_unavailable")
              : await readJsonResponse(response, "codex_status_unavailable");
          return (options.parseStatus ?? parseDefaultStatus)(value);
        },
      );
    },
    async *startTurn(turnRequest, requestOptions) {
      const deadline = createRequestDeadline(
        "startTurn",
        turnStartTimeoutMs,
        requestOptions?.signal,
      );
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let reachedStreamEnd = false;
      let completed = false;
      try {
        const response = await deadline.race(
          (async () => {
            const value = await request(options.startTurnUrl, {
              method: "POST",
              headers: await jsonHeaders(options.headers),
              body: JSON.stringify(
                options.serializeStartTurn?.(turnRequest) ??
                  defaultSerializeStartTurn(turnRequest),
              ),
              signal: deadline.signal,
            });
            if (!value.ok || !value.body) {
              throw await responseError(value, "codex_turn_unavailable");
            }
            return value;
          })(),
        );
        deadline.clearTimer();
        const decoder = new CodexSseDecoder();
        const body = response.body;
        if (!body) {
          throw new CodexTransportError(
            "codex_turn_unavailable",
            "Codex turn response did not include an SSE body",
          );
        }
        reader = body.getReader();
        while (true) {
          const chunk = await readStreamChunk(
            reader,
            deadline,
            streamIdleTimeoutMs,
          );
          if (chunk.done) {
            reachedStreamEnd = true;
            break;
          }
          for (const frame of decoder.push(chunk.value)) {
            const envelope = parseTurnFrame(frame);
            if (!envelope) continue;
            if (envelope.method === "turn/completed") completed = true;
            yield envelope;
          }
        }
        for (const frame of decoder.finish()) {
          const envelope = parseTurnFrame(frame);
          if (!envelope) continue;
          if (envelope.method === "turn/completed") completed = true;
          yield envelope;
        }
      } finally {
        deadline.dispose();
        if (reader) {
          if (!reachedStreamEnd) {
            try {
              await reader.cancel();
            } catch {
              // The underlying fetch stream may already be aborted.
            }
          }
          reader.releaseLock();
        }
      }

      if (!completed) {
        throw new CodexTransportError(
          "codex_stream_incomplete",
          "Codex stream ended without turn/completed",
        );
      }
    },
    async interruptTurn({ threadId, turnId }) {
      if (!options.interruptTurnUrl) {
        throw new CodexTransportUnsupportedError("interrupt");
      }
      const url = resolveUrl(options.interruptTurnUrl, threadId, turnId);
      await runRequestWithTimeout(
        "interruptTurn",
        requestTimeoutMs,
        undefined,
        async (signal) => {
          const response = await request(url, {
            method: "POST",
            headers: await jsonHeaders(options.headers),
            body: JSON.stringify(
              options.serializeInterrupt?.(threadId, turnId) ?? {
                thread_id: threadId,
                turn_id: turnId,
              },
            ),
            signal,
          });
          if (!response.ok) {
            throw await responseError(response, "codex_interrupt_failed");
          }
        },
      );
    },
    async loadThread({ threadId }) {
      if (!options.loadThreadUrl) {
        throw new CodexTransportUnsupportedError("loadThread");
      }
      const url = resolveUrl(options.loadThreadUrl, threadId, "");
      return runRequestWithTimeout(
        "loadThread",
        requestTimeoutMs,
        undefined,
        async (signal) => {
          const response = await request(url, {
            headers: await resolveHeaders(options.headers),
            signal,
          });
          const value = await readJsonResponse(
            response,
            "codex_thread_load_failed",
          );
          const events = value.events;
          if (!Array.isArray(events)) {
            throw new CodexTransportError(
              "codex_thread_invalid_response",
              "Thread response is missing events",
            );
          }
          return events.map(parseEnvelopeValue);
        },
      );
    },
    async respondToApproval({ requestId, method, decision }) {
      if (!options.approvalUrl) {
        throw new CodexTransportUnsupportedError("approvals");
      }
      await runRequestWithTimeout(
        "respondToApproval",
        requestTimeoutMs,
        undefined,
        async (signal) => {
          const response = await request(options.approvalUrl as string, {
            method: "POST",
            headers: await jsonHeaders(options.headers),
            body: JSON.stringify(
              options.serializeApproval?.(requestId, method, decision) ?? {
                request_id: requestId,
                method,
                decision: defaultSerializeApprovalDecision(method, decision),
              },
            ),
            signal,
          });
          if (!response.ok) {
            throw await responseError(response, "codex_approval_failed");
          }
        },
      );
    },
    async respondToServerRequest({ requestId, method, result }) {
      if (!options.serverRequestUrl) {
        throw new CodexTransportUnsupportedError("serverRequests");
      }
      await runRequestWithTimeout(
        "respondToServerRequest",
        requestTimeoutMs,
        undefined,
        async (signal) => {
          const response = await request(options.serverRequestUrl as string, {
            method: "POST",
            headers: await jsonHeaders(options.headers),
            body: JSON.stringify(
              options.serializeServerRequestResponse?.(
                requestId,
                method,
                result,
              ) ?? {
                request_id: requestId,
                method,
                result,
              },
            ),
            signal,
          });
          if (!response.ok) {
            throw await responseError(response, "codex_server_request_failed");
          }
        },
      );
    },
  };
}

type RequestDeadline = {
  signal: AbortSignal;
  race: <T>(promise: Promise<T>) => Promise<T>;
  clearTimer: () => void;
  fail: (error: Error) => void;
  dispose: () => void;
};

async function runRequestWithTimeout<T>(
  operation: string,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
  request: (signal: AbortSignal) => Promise<T>,
) {
  const deadline = createRequestDeadline(operation, timeoutMs, externalSignal);
  try {
    return await deadline.race(request(deadline.signal));
  } finally {
    deadline.dispose();
  }
}

function createRequestDeadline(
  operation: string,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): RequestDeadline {
  const controller = new AbortController();
  let rejectInterruption: (error: Error) => void = () => {};
  let interrupted = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const interruption = new Promise<never>((_resolve, reject) => {
    rejectInterruption = reject;
  });
  const fail = (error: Error) => {
    if (interrupted) return;
    interrupted = true;
    controller.abort(error);
    rejectInterruption(error);
  };
  const onExternalAbort = () => fail(readAbortReason(externalSignal));

  if (externalSignal?.aborted) onExternalAbort();
  else
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  if (timeoutMs > 0) {
    timer = globalThis.setTimeout(
      () =>
        fail(
          new CodexTransportError(
            "codex_request_timeout",
            `Codex ${operation} request timed out after ${timeoutMs}ms`,
            { operation, timeoutMs },
          ),
        ),
      timeoutMs,
    );
  }

  const clearTimer = () => {
    if (timer !== undefined) globalThis.clearTimeout(timer);
    timer = undefined;
  };
  return {
    signal: controller.signal,
    race: <T>(promise: Promise<T>) => Promise.race([promise, interruption]),
    clearTimer,
    fail,
    dispose: () => {
      clearTimer();
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: RequestDeadline,
  idleTimeoutMs: number,
) {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  if (idleTimeoutMs > 0) {
    timer = globalThis.setTimeout(
      () =>
        deadline.fail(
          new CodexTransportError(
            "codex_stream_idle_timeout",
            `Codex stream was idle for ${idleTimeoutMs}ms`,
            { idleTimeoutMs },
          ),
        ),
      idleTimeoutMs,
    );
  }
  try {
    return await deadline.race(reader.read());
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}

function normalizeTimeout(
  value: number | undefined,
  fallback: number,
  option: string,
) {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new CodexTransportError(
      "codex_transport_invalid_timeout",
      `${option} must be a finite non-negative number`,
      { option, value: timeout },
    );
  }
  return timeout;
}

function readAbortReason(signal: AbortSignal | undefined) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function parseTurnFrame(frame: {
  event: string;
  data: string;
  id: string | null;
  retry: number | null;
}): CodexAppServerEnvelope | null {
  if (frame.event === "app_server_event") {
    return parseAppServerEnvelopeFrame(frame);
  }
  if (frame.event === "completed") return null;
  if (frame.event === "error") {
    let details: unknown = frame.data;
    let code = "codex_turn_failed";
    try {
      details = JSON.parse(frame.data) as unknown;
      const value = asObject(details);
      if (typeof value?.code === "string") code = value.code;
    } catch {
      // Preserve the raw upstream payload as transport error details.
    }
    throw new CodexTransportError(code, `Codex turn failed: ${code}`, details);
  }
  throw new CodexTransportError(
    "codex_sse_unexpected_event",
    `Unexpected SSE event: ${frame.event}`,
    { event: frame.event },
  );
}

function defaultSerializeStartTurn(
  request: CodexStartTurnRequest,
): CodexJsonObject {
  return {
    conversation_id: request.conversationId,
    message: request.message,
    protocol_version: 2,
    ...(request.clientTurnId ? { client_turn_id: request.clientTurnId } : {}),
  };
}

function defaultSerializeApprovalDecision(
  method: string,
  decision: CodexApprovalDecision,
): CodexJsonValue {
  if (method !== "applyPatchApproval" && method !== "execCommandApproval") {
    return decision;
  }
  if (decision === "accept") return "approved";
  if (decision === "acceptForSession") return "approved_for_session";
  if (decision === "decline") return "denied";
  if (decision === "cancel") return "abort";
  if ("acceptWithExecpolicyAmendment" in decision) {
    return {
      approved_execpolicy_amendment: {
        proposed_execpolicy_amendment:
          decision.acceptWithExecpolicyAmendment.execpolicy_amendment,
      },
    };
  }
  return {
    network_policy_amendment: {
      network_policy_amendment:
        decision.applyNetworkPolicyAmendment.network_policy_amendment,
    },
  };
}

function parseDefaultStatus(value: CodexJsonObject): CodexRuntimeStatus {
  const runtimeReady = readBoolean(value, "runtimeReady", "runtime_ready");
  const turnsEnabled = readBoolean(value, "turnsEnabled", "turns_enabled");
  const toolsEnabled = readBoolean(value, "toolsEnabled", "tools_enabled");
  const rawState = readString(value, "state");
  const state = isRuntimeState(rawState)
    ? rawState
    : runtimeReady && turnsEnabled
      ? "ready"
      : "unavailable";
  return {
    state,
    runtimeReady,
    turnsEnabled,
    toolsEnabled,
    errorCode: readString(value, "errorCode", "error_code"),
    raw: value,
  };
}

async function resolveHeaders(headers: RequestHeaders | undefined) {
  return typeof headers === "function" ? headers() : headers;
}

async function jsonHeaders(headers: RequestHeaders | undefined) {
  const result = new Headers(await resolveHeaders(headers));
  if (!result.has("Content-Type"))
    result.set("Content-Type", "application/json");
  return result;
}

function resolveUrl(
  value: string | ((threadId: string, turnId: string) => string),
  threadId: string,
  turnId: string,
) {
  return typeof value === "function" ? value(threadId, turnId) : value;
}

async function readJsonResponse(response: Response, code: string) {
  if (!response.ok) throw await responseError(response, code);
  return readJsonObject(response, code);
}

async function readJsonObject(response: Response, code: string) {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new CodexTransportError(
      code,
      "Codex endpoint returned invalid JSON",
      error,
    );
  }
  const object = asObject(value);
  if (!object) {
    throw new CodexTransportError(
      code,
      "Codex endpoint returned a non-object response",
    );
  }
  return object;
}

async function responseError(response: Response, code: string) {
  let details: unknown;
  try {
    details = await response.json();
  } catch {
    details = { status: response.status, statusText: response.statusText };
  }
  return new CodexTransportError(
    code,
    `Codex request failed (${response.status})`,
    details,
  );
}

function parseEnvelopeValue(value: CodexJsonValue): CodexAppServerEnvelope {
  return parseAppServerEnvelopeFrame({
    event: "app_server_event",
    data: JSON.stringify(value),
    id: null,
    retry: null,
  });
}

function readBoolean(value: CodexJsonObject, ...keys: string[]) {
  for (const key of keys) {
    if (typeof value[key] === "boolean") return value[key] as boolean;
  }
  return false;
}

function readString(value: CodexJsonObject, ...keys: string[]) {
  for (const key of keys) {
    if (typeof value[key] === "string") return value[key] as string;
  }
  return null;
}

function isRuntimeState(
  value: string | null,
): value is CodexRuntimeStatus["state"] {
  return (
    value === "disabled" ||
    value === "starting" ||
    value === "ready" ||
    value === "unavailable"
  );
}

function asObject(value: unknown): CodexJsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as CodexJsonObject)
    : null;
}
