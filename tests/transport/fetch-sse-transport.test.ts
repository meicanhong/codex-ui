import { describe, expect, it, vi } from "vitest";
import {
  CodexTransportError,
  CodexTransportUnsupportedError,
  createFetchSseCodexTransport,
} from "../../src/transport/index.js";

const encoder = new TextEncoder();

function sseResponse(events: unknown[], includeCompleted = true) {
  const values = [
    ...events,
    ...(includeCompleted
      ? [
          {
            kind: "notification",
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-1", items: [], status: "completed" },
            },
            sequence: 99,
            receivedAt: 200,
            raw: {},
          },
        ]
      : []),
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of values) {
        const frame = `event: app_server_event\ndata: ${JSON.stringify(value)}\n\n`;
        const midpoint = Math.floor(frame.length / 2);
        controller.enqueue(encoder.encode(frame.slice(0, midpoint)));
        controller.enqueue(encoder.encode(frame.slice(midpoint)));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function rawSseResponse(value: string) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(value));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

async function collectTurn(
  stream: ReturnType<
    ReturnType<typeof createFetchSseCodexTransport>["startTurn"]
  >,
) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function failedResponse() {
  return Response.json({ error: "upstream failed" }, { status: 500 });
}

describe("createFetchSseCodexTransport", () => {
  it("normalizes status and sends protocol v2 by default", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runtime_ready: true,
            turns_enabled: true,
            tools_enabled: false,
          }),
        ),
      )
      .mockResolvedValueOnce(
        sseResponse([
          {
            kind: "notification",
            method: "turn/started",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-1", items: [], status: "inProgress" },
            },
            sequence: 1,
            receivedAt: 100,
            raw: {},
          },
        ]),
      );
    const transport = createFetchSseCodexTransport({
      statusUrl: "/status",
      startTurnUrl: "/turns",
      fetch: fetchMock,
    });

    await expect(transport.getStatus()).resolves.toMatchObject({
      state: "ready",
      runtimeReady: true,
      turnsEnabled: true,
      toolsEnabled: false,
    });
    const events = [];
    for await (const event of transport.startTurn({
      conversationId: "thread-1",
      threadId: "native-thread-1",
      message: "hello",
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.method)).toEqual([
      "turn/started",
      "turn/completed",
    ]);
    const request = fetchMock.mock.calls[1]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      conversation_id: "thread-1",
      message: "hello",
      protocol_version: 2,
    });
  });

  it("rejects incomplete streams with a stable error code", async () => {
    const transport = createFetchSseCodexTransport({
      statusUrl: "/status",
      startTurnUrl: "/turns",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(sseResponse([], false)),
    });

    const consume = async () => {
      for await (const _event of transport.startTurn({
        conversationId: "thread-1",
        threadId: null,
        message: "hello",
      })) {
        // Consume the stream to trigger terminal validation.
      }
    };
    await expect(consume()).rejects.toMatchObject<CodexTransportError>({
      code: "codex_stream_incomplete",
    });
  });

  it("accepts the proxy completed control event after App Server completion", async () => {
    const completed = {
      kind: "notification",
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", items: [], status: "completed" },
      },
      sequence: 1,
      receivedAt: 200,
      raw: {},
    };
    const transport = createFetchSseCodexTransport({
      statusUrl: "/status",
      startTurnUrl: "/turns",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          rawSseResponse(
            `event: app_server_event\ndata: ${JSON.stringify(completed)}\n\n` +
              'event: completed\ndata: {"status":"completed"}\n\n',
          ),
        ),
    });

    const events = [];
    for await (const event of transport.startTurn({
      conversationId: "thread-1",
      threadId: null,
      message: "hello",
    })) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.method).toBe("turn/completed");
  });

  it("turns proxy error frames into stable transport errors", async () => {
    const transport = createFetchSseCodexTransport({
      statusUrl: "/status",
      startTurnUrl: "/turns",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          rawSseResponse(
            'event: error\ndata: {"code":"codex_server_request_rejected"}\n\n',
          ),
        ),
    });

    const consume = async () => {
      for await (const _event of transport.startTurn({
        conversationId: "thread-1",
        threadId: null,
        message: "hello",
      })) {
        // Consume the stream to surface the terminal proxy error.
      }
    };
    await expect(consume()).rejects.toMatchObject<CodexTransportError>({
      code: "codex_server_request_rejected",
    });
  });

  it("makes optional capabilities explicit", async () => {
    const transport = createFetchSseCodexTransport({
      statusUrl: "/status",
      startTurnUrl: "/turns",
      fetch: vi.fn<typeof fetch>(),
    });
    expect(transport.capabilities).toEqual({
      interrupt: false,
      loadThread: false,
      approvals: false,
      serverRequests: false,
    });
    await expect(
      transport.interruptTurn({ threadId: "thread-1", turnId: "turn-1" }),
    ).rejects.toBeInstanceOf(CodexTransportUnsupportedError);
  });

  it("loads thread events and interrupts a turn through configured endpoints", async () => {
    const loaded = {
      kind: "notification",
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", items: [], status: "inProgress" },
      },
      sequence: 1,
      receivedAt: 1,
      raw: {},
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ events: [loaded] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const transport = createFetchSseCodexTransport({
      statusUrl: "/status",
      startTurnUrl: "/turns",
      loadThreadUrl: (threadId) => `/threads/${threadId}`,
      interruptTurnUrl: (threadId, turnId) =>
        `/threads/${threadId}/turns/${turnId}/interrupt`,
      fetch: fetchMock,
    });

    await expect(
      transport.loadThread({ threadId: "thread-1" }),
    ).resolves.toMatchObject([{ method: "turn/started", sequence: 1 }]);
    await expect(
      transport.interruptTurn({ threadId: "thread-1", turnId: "turn-1" }),
    ).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/threads/thread-1",
      "/threads/thread-1/turns/turn-1/interrupt",
    ]);
  });

  it("returns stable endpoint-specific errors for every HTTP operation", async () => {
    const cases = [
      {
        code: "codex_status_unavailable",
        run: (transport: ReturnType<typeof createFetchSseCodexTransport>) =>
          transport.getStatus(),
      },
      {
        code: "codex_turn_unavailable",
        run: (transport: ReturnType<typeof createFetchSseCodexTransport>) =>
          collectTurn(
            transport.startTurn({
              conversationId: "conversation-1",
              threadId: null,
              message: "hello",
            }),
          ),
      },
      {
        code: "codex_thread_load_failed",
        run: (transport: ReturnType<typeof createFetchSseCodexTransport>) =>
          transport.loadThread({ threadId: "thread-1" }),
      },
      {
        code: "codex_interrupt_failed",
        run: (transport: ReturnType<typeof createFetchSseCodexTransport>) =>
          transport.interruptTurn({ threadId: "thread-1", turnId: "turn-1" }),
      },
      {
        code: "codex_approval_failed",
        run: (transport: ReturnType<typeof createFetchSseCodexTransport>) =>
          transport.respondToApproval({
            requestId: "approval-1",
            method: "item/commandExecution/requestApproval",
            decision: "decline",
          }),
      },
      {
        code: "codex_server_request_failed",
        run: (transport: ReturnType<typeof createFetchSseCodexTransport>) =>
          transport.respondToServerRequest({
            requestId: "request-1",
            method: "item/tool/requestUserInput",
            result: { answers: {} },
          }),
      },
    ];

    for (const testCase of cases) {
      const transport = createFetchSseCodexTransport({
        statusUrl: "/status",
        startTurnUrl: "/turns",
        loadThreadUrl: "/load",
        interruptTurnUrl: "/interrupt",
        approvalUrl: "/approval",
        serverRequestUrl: "/server-request",
        fetch: vi.fn<typeof fetch>().mockResolvedValue(failedResponse()),
      });
      await expect(testCase.run(transport)).rejects.toMatchObject({
        code: testCase.code,
      });
    }
  });

  it("times out every HTTP operation without imposing a total turn limit", async () => {
    const cases = [
      (transport: ReturnType<typeof createFetchSseCodexTransport>) =>
        transport.getStatus(),
      (transport: ReturnType<typeof createFetchSseCodexTransport>) =>
        collectTurn(
          transport.startTurn({
            conversationId: "conversation-1",
            threadId: null,
            message: "hello",
          }),
        ),
      (transport: ReturnType<typeof createFetchSseCodexTransport>) =>
        transport.loadThread({ threadId: "thread-1" }),
      (transport: ReturnType<typeof createFetchSseCodexTransport>) =>
        transport.interruptTurn({ threadId: "thread-1", turnId: "turn-1" }),
      (transport: ReturnType<typeof createFetchSseCodexTransport>) =>
        transport.respondToApproval({
          requestId: "approval-1",
          method: "item/commandExecution/requestApproval",
          decision: "accept",
        }),
      (transport: ReturnType<typeof createFetchSseCodexTransport>) =>
        transport.respondToServerRequest({
          requestId: "request-1",
          method: "item/tool/requestUserInput",
          result: { answers: {} },
        }),
    ];

    for (const run of cases) {
      const transport = createFetchSseCodexTransport({
        statusUrl: "/status",
        startTurnUrl: "/turns",
        loadThreadUrl: "/load",
        interruptTurnUrl: "/interrupt",
        approvalUrl: "/approval",
        serverRequestUrl: "/server-request",
        requestTimeoutMs: 5,
        turnStartTimeoutMs: 5,
        fetch: vi.fn<typeof fetch>(() => new Promise<Response>(() => {})),
      });
      await expect(run(transport)).rejects.toMatchObject<CodexTransportError>({
        code: "codex_request_timeout",
      });
    }
  });

  it("fails an established SSE stream after the configured idle timeout", async () => {
    const idleResponse = new Response(
      new ReadableStream<Uint8Array>({
        start() {
          // Intentionally leave the stream open without producing a chunk.
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const transport = createFetchSseCodexTransport({
      statusUrl: "/status",
      startTurnUrl: "/turns",
      streamIdleTimeoutMs: 5,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(idleResponse),
    });

    await expect(
      collectTurn(
        transport.startTurn({
          conversationId: "conversation-1",
          threadId: null,
          message: "hello",
        }),
      ),
    ).rejects.toMatchObject<CodexTransportError>({
      code: "codex_stream_idle_timeout",
    });
  });

  it("clears the turn-start deadline after SSE headers are established", async () => {
    const completed = {
      kind: "notification",
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", items: [], status: "completed" },
      },
      sequence: 1,
      receivedAt: 1,
      raw: {},
    };
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          globalThis.setTimeout(() => {
            controller.enqueue(
              encoder.encode(
                `event: app_server_event\ndata: ${JSON.stringify(completed)}\n\n`,
              ),
            );
            controller.close();
          }, 20);
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const transport = createFetchSseCodexTransport({
      statusUrl: "/status",
      startTurnUrl: "/turns",
      turnStartTimeoutMs: 5,
      streamIdleTimeoutMs: 100,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
    });

    await expect(
      collectTurn(
        transport.startTurn({
          conversationId: "conversation-1",
          threadId: null,
          message: "hello",
        }),
      ),
    ).resolves.toMatchObject([{ method: "turn/completed" }]);
  });

  it("preserves caller AbortError instead of reporting a transport timeout", async () => {
    const controller = new AbortController();
    const transport = createFetchSseCodexTransport({
      statusUrl: "/status",
      startTurnUrl: "/turns",
      turnStartTimeoutMs: 1_000,
      fetch: vi.fn<typeof fetch>(() => new Promise<Response>(() => {})),
    });
    const result = collectTurn(
      transport.startTurn(
        {
          conversationId: "conversation-1",
          threadId: null,
          message: "hello",
        },
        { signal: controller.signal },
      ),
    );

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    await expect(result).rejects.not.toBeInstanceOf(CodexTransportError);
  });

  it("serializes generic server-request responses through an opt-in endpoint", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const transport = createFetchSseCodexTransport({
      statusUrl: "/status",
      startTurnUrl: "/turns",
      serverRequestUrl: "/server-request",
      fetch: fetchMock,
    });

    await transport.respondToServerRequest({
      requestId: "request-1",
      method: "item/tool/requestUserInput",
      result: { answers: { region: "华东" } },
    });

    expect(transport.capabilities.serverRequests).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/server-request",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          request_id: "request-1",
          method: "item/tool/requestUserInput",
          result: { answers: { region: "华东" } },
        }),
      }),
    );
  });

  it("maps legacy approval decisions to the official ReviewDecision wire values", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const transport = createFetchSseCodexTransport({
      statusUrl: "/status",
      startTurnUrl: "/turns",
      approvalUrl: "/approval",
      fetch: fetchMock,
    });

    await transport.respondToApproval({
      requestId: 1,
      method: "execCommandApproval",
      decision: "accept",
    });
    await transport.respondToApproval({
      requestId: 2,
      method: "execCommandApproval",
      decision: "decline",
    });
    await transport.respondToApproval({
      requestId: 3,
      method: "applyPatchApproval",
      decision: "cancel",
    });
    await transport.respondToApproval({
      requestId: 4,
      method: "execCommandApproval",
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ["git", "status"],
        },
      },
    });
    await transport.respondToApproval({
      requestId: 5,
      method: "applyPatchApproval",
      decision: "acceptForSession",
    });
    await transport.respondToApproval({
      requestId: 6,
      method: "execCommandApproval",
      decision: {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            host: "api.example.com",
            action: "allow",
          },
        },
      },
    });

    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))),
    ).toEqual([
      { request_id: 1, method: "execCommandApproval", decision: "approved" },
      { request_id: 2, method: "execCommandApproval", decision: "denied" },
      { request_id: 3, method: "applyPatchApproval", decision: "abort" },
      {
        request_id: 4,
        method: "execCommandApproval",
        decision: {
          approved_execpolicy_amendment: {
            proposed_execpolicy_amendment: ["git", "status"],
          },
        },
      },
      {
        request_id: 5,
        method: "applyPatchApproval",
        decision: "approved_for_session",
      },
      {
        request_id: 6,
        method: "execCommandApproval",
        decision: {
          network_policy_amendment: {
            network_policy_amendment: {
              host: "api.example.com",
              action: "allow",
            },
          },
        },
      },
    ]);
  });

  it("keeps a structured unavailable status from HTTP 503", async () => {
    const transport = createFetchSseCodexTransport({
      statusUrl: "/status",
      startTurnUrl: "/turns",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            state: "unavailable",
            runtime_ready: false,
            turns_enabled: false,
            tools_enabled: false,
            error_code: "codex_runtime_starting",
          },
          { status: 503 },
        ),
      ),
    });

    await expect(transport.getStatus()).resolves.toMatchObject({
      state: "unavailable",
      runtimeReady: false,
      errorCode: "codex_runtime_starting",
    });
  });
});
