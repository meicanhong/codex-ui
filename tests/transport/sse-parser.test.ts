import { describe, expect, it } from "vitest";
import {
  CodexSseDecoder,
  type CodexTransportError,
  parseAppServerEnvelopeFrame,
} from "../../src/transport/index.js";

const encoder = new TextEncoder();

describe("CodexSseDecoder", () => {
  it("decodes split chunks, CRLF, comments, and multiline data", () => {
    const decoder = new CodexSseDecoder();
    const first = decoder.push(
      encoder.encode(
        ': heartbeat\r\nevent: app_server_event\r\nid: 12\r\ndata: {"kind":"notification",\r\n',
      ),
    );
    const second = decoder.push(
      encoder.encode(
        'data: "method":"future/event","params":{},"sequence":12,"receivedAt":100,"raw":{}}\r\n\r\n',
      ),
    );

    expect(first).toEqual([]);
    expect(second).toEqual([
      {
        event: "app_server_event",
        id: "12",
        retry: null,
        data: '{"kind":"notification",\n"method":"future/event","params":{},"sequence":12,"receivedAt":100,"raw":{}}',
      },
    ]);
  });

  it("preserves a CRLF line ending split between chunks", () => {
    const decoder = new CodexSseDecoder();

    expect(decoder.push(encoder.encode("event: app_server_event\r"))).toEqual(
      [],
    );
    expect(
      decoder.push(
        encoder.encode(
          '\ndata: {"kind":"notification","method":"future/event"}\r\n\r\n',
        ),
      ),
    ).toEqual([
      {
        event: "app_server_event",
        id: null,
        retry: null,
        data: '{"kind":"notification","method":"future/event"}',
      },
    ]);
  });

  it("decodes a CRLF frame delivered one byte at a time", () => {
    const decoder = new CodexSseDecoder();
    const bytes = encoder.encode(
      "event: app_server_event\r\nid: 7\r\ndata: first\r\ndata: second\r\n\r\n",
    );
    const frames = Array.from(bytes).flatMap((byte) =>
      decoder.push(Uint8Array.of(byte)),
    );

    expect(frames).toEqual([
      {
        event: "app_server_event",
        id: "7",
        retry: null,
        data: "first\nsecond",
      },
    ]);
    expect(decoder.finish()).toEqual([]);
  });

  it("flushes a final frame without a trailing blank line", () => {
    const decoder = new CodexSseDecoder();
    decoder.push(encoder.encode("event: message\ndata: final"));
    expect(decoder.finish()).toEqual([
      { event: "message", data: "final", id: null, retry: null },
    ]);
  });
});

describe("parseAppServerEnvelopeFrame", () => {
  it("parses notification and server request envelopes", () => {
    const notification = parseAppServerEnvelopeFrame({
      event: "app_server_event",
      id: null,
      retry: null,
      data: JSON.stringify({
        kind: "notification",
        method: "turn/started",
        streamId: "stream-1",
        params: { threadId: "thread-1" },
        sequence: 1,
        receivedAt: 100,
        raw: { method: "turn/started" },
      }),
    });
    const request = parseAppServerEnvelopeFrame({
      event: "app_server_event",
      id: null,
      retry: null,
      data: JSON.stringify({
        kind: "serverRequest",
        requestId: "approval-1",
        method: "item/fileChange/requestApproval",
        params: {},
        sequence: 2,
        received_at: 101,
      }),
    });

    expect(notification).toMatchObject({
      kind: "notification",
      sequence: 1,
      streamId: "stream-1",
    });
    expect(request).toMatchObject({
      kind: "serverRequest",
      requestId: "approval-1",
      receivedAt: 101,
    });
  });

  it("reports protocol errors with stable error codes", () => {
    expect(() =>
      parseAppServerEnvelopeFrame({
        event: "legacy_delta",
        id: null,
        retry: null,
        data: "{}",
      }),
    ).toThrowError(
      expect.objectContaining<CodexTransportError>({
        code: "codex_sse_unexpected_event",
      }),
    );

    expect(() =>
      parseAppServerEnvelopeFrame({
        event: "app_server_event",
        id: null,
        retry: null,
        data: "not-json",
      }),
    ).toThrowError(
      expect.objectContaining<CodexTransportError>({
        code: "codex_sse_invalid_json",
      }),
    );
  });
});
