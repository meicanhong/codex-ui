// @vitest-environment happy-dom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CodexAppServerEnvelope,
  createCodexThreadState,
  reduceCodexEvent,
} from "../../src/core/index.js";
import {
  CodexChat,
  CodexThreadProvider,
  useCodexThread,
} from "../../src/react/index.js";
import {
  type CodexTransport,
  CodexTransportError,
  createFetchSseCodexTransport,
} from "../../src/transport/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function envelope(
  sequence: number,
  method: string,
  params: CodexAppServerEnvelope["params"],
): CodexAppServerEnvelope {
  return {
    kind: "notification",
    method,
    params,
    raw: {},
    sequence,
    receivedAt: sequence,
  };
}

function createTransport(
  stream: CodexTransport["startTurn"],
  overrides: Partial<CodexTransport> = {},
): CodexTransport {
  return {
    capabilities: {
      interrupt: false,
      loadThread: false,
      approvals: false,
      serverRequests: false,
    },
    getStatus: vi.fn().mockResolvedValue({
      state: "ready",
      runtimeReady: true,
      turnsEnabled: true,
      toolsEnabled: true,
      errorCode: null,
      raw: {},
    }),
    startTurn: stream,
    interruptTurn: vi.fn(),
    loadThread: vi.fn().mockResolvedValue([]),
    respondToApproval: vi.fn(),
    respondToServerRequest: vi.fn(),
    ...overrides,
  };
}

describe("CodexThreadProvider", () => {
  it("streams a complete turn into the reusable chat", async () => {
    const startTurn = vi.fn<CodexTransport["startTurn"]>(async function* () {
      yield envelope(1, "turn/started", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "inProgress", items: [], startedAt: 1 },
      });
      yield envelope(2, "item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "userMessage",
          id: "user-1",
          clientId: null,
          content: [{ type: "text", text: "hello", text_elements: [] }],
        },
      });
      yield envelope(3, "item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "answer-1",
          text: "done",
          phase: "final_answer",
          memoryCitation: null,
        },
      });
      yield envelope(4, "turn/completed", {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [],
          durationMs: 20,
        },
      });
    });
    const transport = createTransport(startTurn);
    const user = userEvent.setup();
    render(
      <CodexThreadProvider
        createThreadId={() => "thread-1"}
        transport={transport}
      >
        <CodexChat />
      </CodexThreadProvider>,
    );

    const composer = await screen.findByRole("textbox", {
      name: "Message Codex",
    });
    await waitFor(() =>
      expect((composer as HTMLTextAreaElement).disabled).toBe(false),
    );
    await user.type(composer, "hello{Enter}");

    expect(await screen.findByText("done")).toBeTruthy();
    expect(startTurn).toHaveBeenCalledWith(
      {
        conversationId: "thread-1",
        threadId: null,
        message: "hello",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps the host conversation stable across native App Server turns", async () => {
    let call = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      call += 1;
      const turnId = `turn-${call}`;
      return appServerTurnResponse([
        envelope(1, "turn/started", {
          threadId: "native-thread-1",
          turn: { id: turnId, status: "inProgress", items: [], startedAt: 1 },
        }),
        envelope(2, "turn/completed", {
          threadId: "native-thread-1",
          turn: { id: turnId, status: "completed", items: [], durationMs: 20 },
        }),
      ]);
    });
    const transport = createFetchSseCodexTransport({
      fetch: fetchMock,
      startTurnUrl: "/turns",
      statusUrl: "/status",
    });
    const user = userEvent.setup();
    render(
      <CodexThreadProvider
        autoRefreshStatus={false}
        createConversationId={() => "conversation-1"}
        transport={transport}
      >
        <ThreadIdProbe />
        <CodexChat />
      </CodexThreadProvider>,
    );
    const composer = screen.getByRole("textbox", { name: "Message Codex" });

    await user.type(composer, "first{Enter}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("native-thread-1")).toBeTruthy();
    await waitFor(() =>
      expect((composer as HTMLTextAreaElement).disabled).toBe(false),
    );
    await user.type(composer, "second{Enter}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))),
    ).toEqual([
      {
        conversation_id: "conversation-1",
        message: "first",
        protocol_version: 2,
      },
      {
        conversation_id: "conversation-1",
        message: "second",
        protocol_version: 2,
      },
    ]);
  });

  it("generates an RFC 4122 conversation id without crypto.randomUUID", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues(bytes: Uint8Array) {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = index;
        }
        return bytes;
      },
    });
    const startTurn = vi.fn<CodexTransport["startTurn"]>(async function* () {});
    const user = userEvent.setup();
    render(
      <CodexThreadProvider
        autoRefreshStatus={false}
        transport={createTransport(startTurn)}
      >
        <CodexChat />
      </CodexThreadProvider>,
    );

    const composer = screen.getByRole("textbox", { name: "Message Codex" });
    await user.type(composer, "fallback id{Enter}");
    await waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1));

    expect(startTurn.mock.calls[0]?.[0].conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("does not send while an IME composition is being confirmed", async () => {
    const startTurn = vi.fn<CodexTransport["startTurn"]>(async function* () {});
    const user = userEvent.setup();
    render(
      <CodexThreadProvider
        autoRefreshStatus={false}
        transport={createTransport(startTurn)}
      >
        <CodexChat />
      </CodexThreadProvider>,
    );
    const composer = screen.getByRole("textbox", { name: "Message Codex" });
    await user.type(composer, "中文");
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });

    expect(startTurn).not.toHaveBeenCalled();
    expect((composer as HTMLTextAreaElement).value).toBe("中文");
  });

  it("stops locally without waiting and surfaces transport interrupt failures", async () => {
    const interruptResponse = deferred<void>();
    const firstStreamRelease = deferred<void>();
    const interruptTurn = vi.fn(() => interruptResponse.promise);
    let turnSequence = 0;
    const startTurn = vi.fn<CodexTransport["startTurn"]>(
      async function* (_request, options) {
        turnSequence += 1;
        const turnId = `turn-${turnSequence}`;
        yield envelope(1, "turn/started", {
          threadId: "thread-1",
          turn: { id: turnId, status: "inProgress", items: [], startedAt: 1 },
        });
        if (turnSequence === 1) {
          yield {
            kind: "serverRequest",
            requestId: "approval-1",
            sequence: 2,
            receivedAt: 2,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: "thread-1",
              turnId,
              itemId: "command-1",
              reason: "Approve the command",
            },
            raw: {},
          };
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          await firstStreamRelease.promise;
          return;
        }
        yield envelope(2, "turn/completed", {
          threadId: "thread-1",
          turn: { id: turnId, status: "completed", items: [], durationMs: 20 },
        });
      },
    );
    const transport = createTransport(startTurn, {
      capabilities: {
        interrupt: true,
        loadThread: false,
        approvals: true,
        serverRequests: false,
      },
      interruptTurn,
    });
    const user = userEvent.setup();
    render(
      <CodexThreadProvider
        createThreadId={() => "thread-1"}
        transport={transport}
      >
        <CodexChat />
      </CodexThreadProvider>,
    );

    const composer = await screen.findByRole("textbox", {
      name: "Message Codex",
    });
    await waitFor(() =>
      expect((composer as HTMLTextAreaElement).disabled).toBe(false),
    );
    await user.type(composer, "keep going{Enter}");
    expect(await screen.findByText("Approve the command")).toBeTruthy();
    const stop = await screen.findByRole("button", { name: "Stop" });
    await user.click(stop);

    await waitFor(() =>
      expect(interruptTurn).toHaveBeenCalledWith({
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    );
    expect(await screen.findByText(/Interrupted after/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    await waitFor(() =>
      expect((composer as HTMLTextAreaElement).disabled).toBe(false),
    );

    await act(async () =>
      interruptResponse.reject(
        new CodexTransportError("codex_interrupt_failed", "interrupt failed"),
      ),
    );
    expect(await screen.findByText("interrupt failed")).toBeTruthy();
    expect(await screen.findByText(/Interrupted after/)).toBeTruthy();
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);

    await user.type(composer, "next turn{Enter}");
    await waitFor(() => expect(startTurn).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect((composer as HTMLTextAreaElement).disabled).toBe(false),
    );

    await act(async () => firstStreamRelease.resolve());
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
  });

  it("marks a broken stream failed and restores the submitted draft", async () => {
    let attempt = 0;
    const startTurn = vi.fn<CodexTransport["startTurn"]>(async function* () {
      attempt += 1;
      yield envelope(1, "turn/started", {
        threadId: "thread-1",
        turn: {
          id: `turn-${attempt}`,
          status: "inProgress",
          items: [],
          startedAt: 1,
        },
      });
      if (attempt === 1) {
        throw new CodexTransportError("network_failed", "network failed");
      }
      yield envelope(2, "turn/completed", {
        threadId: "thread-1",
        turn: {
          id: "turn-2",
          status: "completed",
          items: [],
          durationMs: 20,
        },
      });
    });
    const user = userEvent.setup();
    render(
      <CodexThreadProvider
        autoRefreshStatus={false}
        createThreadId={() => "thread-1"}
        transport={createTransport(startTurn)}
      >
        <CodexChat />
      </CodexThreadProvider>,
    );

    const composer = screen.getByRole("textbox", { name: "Message Codex" });
    await user.type(composer, "retry me{Enter}");

    expect(await screen.findByText(/Stopped after/)).toBeTruthy();
    expect(await screen.findByText("network failed")).toBeTruthy();
    await waitFor(() =>
      expect((composer as HTMLTextAreaElement).value).toBe("retry me"),
    );

    await user.click(composer);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(startTurn).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect((composer as HTMLTextAreaElement).value).toBe(""),
    );
  });

  it("keeps the current thread and conversation when loading another thread fails", async () => {
    const loadThread = vi
      .fn<CodexTransport["loadThread"]>()
      .mockRejectedValue(
        new CodexTransportError("codex_thread_load_failed", "load failed"),
      );
    const startTurn = vi.fn<CodexTransport["startTurn"]>(async function* () {});
    const onError = vi.fn();
    const transport = createTransport(startTurn, {
      capabilities: {
        interrupt: false,
        loadThread: true,
        approvals: false,
        serverRequests: false,
      },
      loadThread,
    });
    const user = userEvent.setup();
    render(
      <CodexThreadProvider
        autoRefreshStatus={false}
        initialConversationId="conversation-current"
        initialThreadId="thread-current"
        onError={onError}
        transport={transport}
      >
        <ThreadLoadProbe />
      </CodexThreadProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Load A" }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(screen.getByText("thread-current")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1));
    expect(startTurn.mock.calls[0]?.[0]).toEqual({
      conversationId: "conversation-current",
      threadId: "thread-current",
      message: "after load",
    });
  });

  it("ignores a stale thread load rejection after unmount", async () => {
    const pendingLoad = deferred<CodexAppServerEnvelope[]>();
    const onError = vi.fn();
    const transport = createTransport(async function* () {}, {
      capabilities: {
        interrupt: false,
        loadThread: true,
        approvals: false,
        serverRequests: false,
      },
      loadThread: vi.fn(() => pendingLoad.promise),
    });
    const user = userEvent.setup();
    const view = render(
      <CodexThreadProvider
        autoRefreshStatus={false}
        onError={onError}
        transport={transport}
      >
        <ThreadLoadProbe />
      </CodexThreadProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Load A" }));
    expect(screen.getByText("loading")).toBeTruthy();
    view.unmount();
    await act(async () =>
      pendingLoad.reject(
        new CodexTransportError("codex_thread_load_failed", "stale load"),
      ),
    );

    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps only the newest concurrent thread load", async () => {
    const first = deferred<CodexAppServerEnvelope[]>();
    const second = deferred<CodexAppServerEnvelope[]>();
    const loadThread = vi.fn(({ threadId }: { threadId: string }) =>
      threadId === "thread-a" ? first.promise : second.promise,
    );
    const startTurn = vi.fn<CodexTransport["startTurn"]>(async function* () {});
    const transport = createTransport(startTurn, {
      capabilities: {
        interrupt: false,
        loadThread: true,
        approvals: false,
        serverRequests: false,
      },
      loadThread,
    });
    const user = userEvent.setup();
    render(
      <CodexThreadProvider autoRefreshStatus={false} transport={transport}>
        <ThreadLoadProbe />
      </CodexThreadProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Load A" }));
    await user.click(screen.getByRole("button", { name: "Load B" }));
    expect(screen.getByText("loading")).toBeTruthy();

    await act(async () => second.resolve([]));
    expect(await screen.findByText("thread-b")).toBeTruthy();
    await act(async () => first.resolve([]));
    expect(screen.getByText("thread-b")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1));
    expect(startTurn.mock.calls[0]?.[0]).toEqual({
      conversationId: "conversation-b",
      threadId: "thread-b",
      message: "after load",
    });
  });

  it("disables an approval while its decision is being sent", async () => {
    const response = deferred<void>();
    const respondToApproval = vi.fn(() => response.promise);
    const transport = createTransport(async function* () {}, {
      capabilities: {
        interrupt: false,
        loadThread: false,
        approvals: true,
        serverRequests: false,
      },
      respondToApproval,
    });
    const initialState = reduceCodexEvent(createCodexThreadState(), {
      kind: "serverRequest",
      requestId: 7,
      sequence: 1,
      receivedAt: 1,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        reason: "Run command",
      },
      raw: {},
    });
    const user = userEvent.setup();
    render(
      <CodexThreadProvider
        autoRefreshStatus={false}
        initialState={initialState}
        transport={transport}
      >
        <CodexChat />
      </CodexThreadProvider>,
    );

    const approve = screen.getByRole("button", { name: "Approve" });
    await user.click(approve);
    await user.click(approve);
    expect(respondToApproval).toHaveBeenCalledTimes(1);
    expect(respondToApproval).toHaveBeenCalledWith({
      requestId: 7,
      method: "item/commandExecution/requestApproval",
      decision: "accept",
    });
    expect((approve as HTMLButtonElement).disabled).toBe(true);

    await act(async () => response.resolve());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull(),
    );
    expect(screen.getByText("Approval accepted")).not.toBeNull();
    expect(screen.getByText("Run command")).not.toBeNull();
  });

  it("rejects a headless approval decision the server did not offer", async () => {
    const respondToApproval = vi.fn().mockResolvedValue(undefined);
    const initialState = reduceCodexEvent(createCodexThreadState(), {
      kind: "serverRequest",
      requestId: "approval-1",
      sequence: 1,
      receivedAt: 1,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        availableDecisions: ["accept", "cancel"],
      },
      raw: {},
    });
    const transport = createTransport(async function* () {}, {
      capabilities: {
        interrupt: false,
        loadThread: false,
        approvals: true,
        serverRequests: false,
      },
      respondToApproval,
    });
    const user = userEvent.setup();
    render(
      <CodexThreadProvider
        autoRefreshStatus={false}
        initialState={initialState}
        transport={transport}
      >
        <HeadlessRequestProbe />
      </CodexThreadProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Unsupported" }));
    expect(respondToApproval).not.toHaveBeenCalled();
  });

  it("rejects stale headless callbacks after their turn is interrupted", async () => {
    let initialState = reduceCodexEvent(createCodexThreadState(), {
      kind: "notification",
      sequence: 1,
      receivedAt: 1,
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "inProgress", items: [], startedAt: 1 },
      },
      raw: {},
    });
    initialState = reduceCodexEvent(initialState, {
      kind: "serverRequest",
      requestId: "approval-1",
      sequence: 2,
      receivedAt: 2,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
      },
      raw: {},
    });
    initialState = reduceCodexEvent(initialState, {
      kind: "serverRequest",
      requestId: "input-1",
      sequence: 3,
      receivedAt: 3,
      method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId: "turn-1" },
      raw: {},
    });
    initialState = reduceCodexEvent(initialState, {
      kind: "turnInterrupted",
      threadId: "thread-1",
      turnId: "turn-1",
      interruptedAt: 4,
    });
    const respondToApproval = vi.fn().mockResolvedValue(undefined);
    const respondToServerRequest = vi.fn().mockResolvedValue(undefined);
    const transport = createTransport(async function* () {}, {
      capabilities: {
        interrupt: false,
        loadThread: false,
        approvals: true,
        serverRequests: true,
      },
      respondToApproval,
      respondToServerRequest,
    });
    const user = userEvent.setup();
    render(
      <CodexThreadProvider
        autoRefreshStatus={false}
        initialState={initialState}
        transport={transport}
      >
        <HeadlessRequestProbe />
      </CodexThreadProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Stale approval" }));
    await user.click(screen.getByRole("button", { name: "Stale request" }));
    expect(respondToApproval).not.toHaveBeenCalled();
    expect(respondToServerRequest).not.toHaveBeenCalled();
  });

  it("shows the command, network, and file scope before asking for approval", () => {
    const transport = createTransport(async function* () {}, {
      capabilities: {
        interrupt: false,
        loadThread: false,
        approvals: true,
        serverRequests: false,
      },
    });
    let initialState = reduceCodexEvent(createCodexThreadState(), {
      kind: "notification",
      sequence: 1,
      receivedAt: 1,
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "file-1",
          status: "inProgress",
          changes: [
            {
              path: "/workspace/src/customer.ts",
              kind: { type: "update", move_path: null },
              diff: "+change",
            },
          ],
        },
      },
      raw: {},
    });
    initialState = reduceCodexEvent(initialState, {
      kind: "serverRequest",
      requestId: "command-approval",
      sequence: 2,
      receivedAt: 2,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        command: "curl https://api.example.com/customers",
        cwd: "/workspace/service",
        networkApprovalContext: {
          host: "api.example.com",
          protocol: "https",
        },
      },
      raw: {},
    });
    initialState = reduceCodexEvent(initialState, {
      kind: "serverRequest",
      requestId: "file-approval",
      sequence: 3,
      receivedAt: 3,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "file-1",
        grantRoot: "/workspace/src",
      },
      raw: {},
    });

    render(
      <CodexThreadProvider
        autoRefreshStatus={false}
        initialState={initialState}
        transport={transport}
      >
        <CodexChat />
      </CodexThreadProvider>,
    );

    expect(
      screen.getByText("curl https://api.example.com/customers"),
    ).toBeTruthy();
    expect(screen.getByText("/workspace/service")).toBeTruthy();
    expect(screen.getByText("api.example.com")).toBeTruthy();
    expect(screen.getAllByText("/workspace/src/customer.ts")).toHaveLength(2);
    expect(screen.getByText("/workspace/src")).toBeTruthy();
  });

  it("renders and sends only the official available command decisions", async () => {
    const respondToApproval = vi.fn().mockResolvedValue(undefined);
    const transport = createTransport(async function* () {}, {
      capabilities: {
        interrupt: false,
        loadThread: false,
        approvals: true,
        serverRequests: false,
      },
      respondToApproval,
    });
    let initialState = reduceCodexEvent(createCodexThreadState(), {
      kind: "serverRequest",
      requestId: "exec-policy",
      sequence: 1,
      receivedAt: 1,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        reason: "Remember command",
        availableDecisions: [
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["git", "status"],
            },
          },
          "decline",
        ],
      },
      raw: {},
    });
    initialState = reduceCodexEvent(initialState, {
      kind: "serverRequest",
      requestId: "network-policy",
      sequence: 2,
      receivedAt: 2,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-2",
        reason: "Remember network host",
        availableDecisions: [
          {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: {
                host: "api.example.com",
                action: "allow",
              },
            },
          },
          "cancel",
        ],
      },
      raw: {},
    });
    const user = userEvent.setup();
    render(
      <CodexThreadProvider
        autoRefreshStatus={false}
        initialState={initialState}
        transport={transport}
      >
        <CodexChat />
      </CodexThreadProvider>,
    );

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Approve for session" }),
    ).toBeNull();

    await user.click(
      screen.getByRole("button", {
        name: "Approve and remember this command",
      }),
    );
    await waitFor(() =>
      expect(respondToApproval).toHaveBeenCalledWith({
        requestId: "exec-policy",
        method: "item/commandExecution/requestApproval",
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: ["git", "status"],
          },
        },
      }),
    );

    await user.click(
      screen.getByRole("button", {
        name: "Allow api.example.com and remember",
      }),
    );
    await waitFor(() =>
      expect(respondToApproval).toHaveBeenCalledWith({
        requestId: "network-policy",
        method: "item/commandExecution/requestApproval",
        decision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: {
              host: "api.example.com",
              action: "allow",
            },
          },
        },
      }),
    );
  });

  it("lets a host render and resolve non-approval server requests", async () => {
    const respondToServerRequest = vi.fn().mockResolvedValue(undefined);
    const transport = createTransport(async function* () {}, {
      capabilities: {
        interrupt: false,
        loadThread: false,
        approvals: false,
        serverRequests: true,
      },
      respondToServerRequest,
    });
    const initialState = reduceCodexEvent(createCodexThreadState(), {
      kind: "serverRequest",
      requestId: "input-1",
      sequence: 1,
      receivedAt: 1,
      method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId: "turn-1", questions: [] },
      raw: {},
    });
    const user = userEvent.setup();
    render(
      <CodexThreadProvider
        autoRefreshStatus={false}
        initialState={initialState}
        transport={transport}
      >
        <CodexChat
          renderServerRequest={(request, respond) => (
            <button onClick={() => void respond({ answers: {} })} type="button">
              Answer {request.requestId}
            </button>
          )}
        />
      </CodexThreadProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Answer input-1" }));
    await waitFor(() =>
      expect(respondToServerRequest).toHaveBeenCalledWith({
        requestId: "input-1",
        method: "item/tool/requestUserInput",
        result: { answers: {} },
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Answer input-1" }),
      ).toBeNull(),
    );
  });
});

function ThreadLoadProbe() {
  const { loadThread, sendMessage, state, threadLoading } = useCodexThread();
  return (
    <div>
      <button
        onClick={() =>
          void loadThread({
            conversationId: "conversation-a",
            threadId: "thread-a",
          })
        }
        type="button"
      >
        Load A
      </button>
      <button
        onClick={() =>
          void loadThread({
            conversationId: "conversation-b",
            threadId: "thread-b",
          })
        }
        type="button"
      >
        Load B
      </button>
      <button onClick={() => void sendMessage("after load")} type="button">
        Send
      </button>
      <span>{threadLoading ? "loading" : (state.threadId ?? "empty")}</span>
    </div>
  );
}

function HeadlessRequestProbe() {
  const { respondToApproval, respondToServerRequest } = useCodexThread();
  return (
    <div>
      <button
        onClick={() => void respondToApproval("approval-1", "acceptForSession")}
        type="button"
      >
        Unsupported
      </button>
      <button
        onClick={() => void respondToApproval("approval-1", "accept")}
        type="button"
      >
        Stale approval
      </button>
      <button
        onClick={() => void respondToServerRequest("input-1", { answers: {} })}
        type="button"
      >
        Stale request
      </button>
    </div>
  );
}

function ThreadIdProbe() {
  const { state } = useCodexThread();
  return <output>{state.threadId ?? "no-native-thread"}</output>;
}

function appServerTurnResponse(events: CodexAppServerEnvelope[]) {
  const encoder = new TextEncoder();
  const payload = events
    .map(
      (event) => `event: app_server_event\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
