import type { CodexJsonObject } from "../core/index.js";
import type {
  CodexSession,
  CodexSessionPage,
  CodexSessionTransport,
} from "./session-types.js";
import { CodexTransportError } from "./types.js";

type RequestHeaders = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);

export type CodexFetchSessionTransportOptions = {
  sessionsUrl: string;
  headers?: RequestHeaders;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function createFetchCodexSessionTransport(
  options: CodexFetchSessionTransportOptions,
): CodexSessionTransport {
  const request = options.fetch ?? globalThis.fetch;
  if (!request) {
    throw new CodexTransportError(
      "codex_session_fetch_unavailable",
      "This environment does not provide fetch",
    );
  }
  const timeoutMs = normalizeTimeout(options.requestTimeoutMs);

  return {
    async listSessions(listRequest = {}) {
      const url = new URL(options.sessionsUrl, resolveBaseUrl());
      if (listRequest.cursor)
        url.searchParams.set("cursor", listRequest.cursor);
      if (listRequest.limit)
        url.searchParams.set("limit", String(listRequest.limit));
      if (listRequest.includeArchived)
        url.searchParams.set("include_archived", "true");
      const value = await requestJson(
        request,
        relativeUrl(options.sessionsUrl, url),
        { headers: await resolveHeaders(options.headers) },
        timeoutMs,
        "codex_session_list_failed",
      );
      return parseSessionPage(value);
    },
    async createSession(createRequest = {}) {
      const value = await requestJson(
        request,
        options.sessionsUrl,
        {
          method: "POST",
          headers: await jsonHeaders(options.headers),
          body: JSON.stringify(
            createRequest.title ? { title: createRequest.title } : {},
          ),
        },
        timeoutMs,
        "codex_session_create_failed",
      );
      return parseSession(readObject(value, "session") ?? value);
    },
    async renameSession(sessionId, title) {
      const value = await requestJson(
        request,
        sessionUrl(options.sessionsUrl, sessionId),
        {
          method: "PATCH",
          headers: await jsonHeaders(options.headers),
          body: JSON.stringify({ title }),
        },
        timeoutMs,
        "codex_session_rename_failed",
      );
      return parseSession(readObject(value, "session") ?? value);
    },
    async archiveSession(sessionId) {
      await requestJson(
        request,
        `${sessionUrl(options.sessionsUrl, sessionId)}/archive`,
        { method: "POST", headers: await jsonHeaders(options.headers) },
        timeoutMs,
        "codex_session_archive_failed",
      );
    },
    async unarchiveSession(sessionId) {
      const value = await requestJson(
        request,
        `${sessionUrl(options.sessionsUrl, sessionId)}/unarchive`,
        { method: "POST", headers: await jsonHeaders(options.headers) },
        timeoutMs,
        "codex_session_unarchive_failed",
      );
      return parseSession(readObject(value, "session") ?? value);
    },
    async deleteSession(sessionId) {
      await requestJson(
        request,
        sessionUrl(options.sessionsUrl, sessionId),
        { method: "DELETE", headers: await resolveHeaders(options.headers) },
        timeoutMs,
        "codex_session_delete_failed",
      );
    },
  };
}

async function requestJson(
  request: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  code: string,
): Promise<CodexJsonObject> {
  const controller = new AbortController();
  const timer =
    timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await request(url, { ...init, signal: controller.signal });
    const value = await response.json().catch(() => null);
    if (!response.ok || !isObject(value)) {
      throw new CodexTransportError(
        code,
        `Codex session request failed: ${code}`,
        value,
      );
    }
    return value;
  } catch (error) {
    if (error instanceof CodexTransportError) throw error;
    const timedOut = controller.signal.aborted;
    throw new CodexTransportError(
      timedOut ? "codex_session_request_timeout" : code,
      timedOut
        ? "Codex session request timed out"
        : `Codex session request failed: ${code}`,
      error,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseSessionPage(value: CodexJsonObject): CodexSessionPage {
  const rawSessions = value.sessions ?? value.data;
  if (!Array.isArray(rawSessions)) {
    throw new CodexTransportError(
      "codex_session_invalid_response",
      "Codex session list is missing sessions",
      value,
    );
  }
  return {
    sessions: rawSessions.map((entry) => parseSession(entry)),
    nextCursor: readString(value, "nextCursor", "next_cursor"),
  };
}

function parseSession(value: unknown): CodexSession {
  if (!isObject(value)) return invalidSession(value);
  const id = readString(value, "id", "conversation_id");
  const threadId = readString(value, "threadId", "thread_id");
  const createdAt = readNumber(value, "createdAt", "created_at");
  const updatedAt = readNumber(value, "updatedAt", "updated_at");
  if (!id || !threadId || createdAt === null || updatedAt === null) {
    return invalidSession(value);
  }
  return {
    id,
    threadId,
    title: readString(value, "title", "name") ?? "New session",
    preview: readString(value, "preview") ?? "",
    createdAt,
    updatedAt,
    archived: readBoolean(value, "archived") ?? false,
    raw: value,
  };
}

function invalidSession(value: unknown): never {
  throw new CodexTransportError(
    "codex_session_invalid_response",
    "Codex session response is invalid",
    value,
  );
}

function sessionUrl(base: string, id: string) {
  return `${base.replace(/\/$/, "")}/${encodeURIComponent(id)}`;
}

function resolveBaseUrl() {
  return typeof window === "undefined"
    ? "http://codex-ui.local"
    : window.location.href;
}

function relativeUrl(original: string, resolved: URL) {
  if (/^https?:\/\//.test(original)) return resolved.toString();
  return `${resolved.pathname}${resolved.search}`;
}

function normalizeTimeout(value: number | undefined) {
  const timeout = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new TypeError(
      "requestTimeoutMs must be a finite non-negative number",
    );
  }
  return timeout;
}

async function resolveHeaders(headers?: RequestHeaders) {
  return typeof headers === "function" ? headers() : (headers ?? {});
}

async function jsonHeaders(headers?: RequestHeaders) {
  const value = new Headers(await resolveHeaders(headers));
  if (!value.has("Content-Type")) value.set("Content-Type", "application/json");
  return value;
}

function isObject(value: unknown): value is CodexJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readObject(value: CodexJsonObject, key: string) {
  const candidate = value[key];
  return isObject(candidate) ? candidate : null;
}

function readString(value: CodexJsonObject, ...keys: string[]) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
  }
  return null;
}

function readNumber(value: CodexJsonObject, ...keys: string[]) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate))
      return candidate;
  }
  return null;
}

function readBoolean(value: CodexJsonObject, key: string) {
  const candidate = value[key];
  return typeof candidate === "boolean" ? candidate : null;
}
