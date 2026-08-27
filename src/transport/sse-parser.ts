import type {
  CodexAppServerEnvelope,
  CodexJsonObject,
  CodexJsonValue,
} from "../core/index.js";
import { CodexTransportError } from "./types.js";

export type CodexSseFrame = {
  event: string;
  data: string;
  id: string | null;
  retry: number | null;
};

export class CodexSseDecoder {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  push(chunk: Uint8Array): CodexSseFrame[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.consume(false);
  }

  finish(): CodexSseFrame[] {
    this.buffer += this.decoder.decode();
    return this.consume(true);
  }

  private consume(flush: boolean): CodexSseFrame[] {
    const pendingCarriageReturn =
      !flush && this.buffer.endsWith("\r") ? "\r" : "";
    if (pendingCarriageReturn) this.buffer = this.buffer.slice(0, -1);
    this.buffer = this.buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const blocks = this.buffer.split("\n\n");
    const trailingBlock = blocks.pop() ?? "";
    this.buffer = flush ? "" : trailingBlock + pendingCarriageReturn;
    if (flush && trailingBlock) blocks.push(trailingBlock);
    return blocks.flatMap(parseSseBlock);
  }
}

export function parseAppServerEnvelopeFrame(
  frame: CodexSseFrame,
): CodexAppServerEnvelope {
  if (frame.event !== "app_server_event") {
    throw new CodexTransportError(
      "codex_sse_unexpected_event",
      `Unexpected SSE event: ${frame.event}`,
      { event: frame.event },
    );
  }

  let value: CodexJsonValue;
  try {
    value = JSON.parse(frame.data) as CodexJsonValue;
  } catch (error) {
    throw new CodexTransportError(
      "codex_sse_invalid_json",
      "Codex SSE frame contains invalid JSON",
      error,
    );
  }

  const envelope = asObject(value);
  const kind = envelope?.kind;
  const method = envelope?.method;
  const params = asObject(envelope?.params);
  const streamId = envelope?.streamId ?? envelope?.stream_id;
  const sequence = envelope?.sequence;
  const receivedAt = envelope?.receivedAt ?? envelope?.received_at;
  if (
    !envelope ||
    (kind !== "notification" && kind !== "serverRequest") ||
    typeof method !== "string" ||
    !params ||
    (streamId !== undefined && typeof streamId !== "string") ||
    typeof sequence !== "number" ||
    typeof receivedAt !== "number"
  ) {
    throw new CodexTransportError(
      "codex_sse_invalid_envelope",
      "Codex SSE frame does not match the App Server envelope contract",
      envelope,
    );
  }
  const raw = asObject(envelope.raw) ?? envelope;

  if (kind === "serverRequest") {
    const requestId = envelope.requestId ?? envelope.request_id;
    if (typeof requestId !== "string" && typeof requestId !== "number") {
      throw new CodexTransportError(
        "codex_sse_invalid_envelope",
        "Codex server request is missing requestId",
        envelope,
      );
    }
    return {
      kind,
      requestId,
      method,
      params,
      raw,
      sequence,
      receivedAt,
      ...(typeof streamId === "string" ? { streamId } : {}),
    };
  }
  return {
    kind,
    method,
    params,
    raw,
    sequence,
    receivedAt,
    ...(typeof streamId === "string" ? { streamId } : {}),
  };
}

function parseSseBlock(block: string): CodexSseFrame[] {
  if (!block.trim()) return [];
  let event = "message";
  let id: string | null = null;
  let retry: number | null = null;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
    else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
  }
  return data.length > 0 ? [{ event, data: data.join("\n"), id, retry }] : [];
}

function asObject(value: CodexJsonValue | undefined): CodexJsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}
