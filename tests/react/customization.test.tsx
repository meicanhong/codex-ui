// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CodexApprovalState,
  createCodexThreadState,
  createCodexTurnState,
} from "../../src/core/index.js";
import {
  CodexChat,
  CodexThreadProvider,
  CodexThreadView,
} from "../../src/react/index.js";
import type { CodexTransport } from "../../src/transport/index.js";

afterEach(cleanup);

const transport: CodexTransport = {
  capabilities: {
    approvals: true,
    interrupt: false,
    loadThread: false,
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
  startTurn: vi.fn(async function* () {}),
  interruptTurn: vi.fn(),
  loadThread: vi.fn().mockResolvedValue([]),
  respondToApproval: vi.fn().mockResolvedValue(undefined),
  respondToServerRequest: vi.fn().mockResolvedValue(undefined),
};

describe("Codex UI customization", () => {
  it("lets a host replace the header, empty state, and thread error", () => {
    const state = createCodexThreadState("native-thread-1");
    state.lastError = {
      code: "offline",
      message: "Default error should be replaced",
      occurredAt: 1,
      threadId: "native-thread-1",
      turnId: null,
    };

    render(
      <CodexThreadProvider
        autoRefreshStatus={false}
        initialState={state}
        transport={transport}
      >
        <CodexChat
          renderHeader={(controller) => (
            <header>Host header: {controller.state.threadId}</header>
          )}
          thread={{
            renderEmpty: ({ labels }) => (
              <div>Host empty: {labels.emptyTitle}</div>
            ),
            renderError: ({ error, scope }) => (
              <div>
                Host {scope} error: {error.message}
              </div>
            ),
          }}
        />
      </CodexThreadProvider>,
    );

    expect(screen.getByText("Host header: native-thread-1")).toBeTruthy();
    expect(screen.getByText("Host empty: What can I help with?")).toBeTruthy();
    expect(
      screen.getByText("Host thread error: Default error should be replaced"),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByText(
        "Ask Codex to investigate, explain, or build something.",
      ),
    ).toBeNull();
  });

  it("treats null as an explicit request to hide empty and error UI", () => {
    const state = createCodexThreadState();
    state.lastError = {
      code: "hidden",
      message: "Hidden error",
      occurredAt: 1,
      threadId: null,
      turnId: null,
    };

    const { container } = render(
      <CodexThreadView
        renderEmpty={() => null}
        renderError={() => null}
        state={state}
      />,
    );

    expect(container.textContent).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders turn errors through the scoped error slot", () => {
    const state = createCodexThreadState("thread-1");
    const turn = createCodexTurnState("turn-1");
    turn.status = "failed";
    turn.error = {
      message: "Turn failed",
      codexErrorInfo: null,
      additionalDetails: null,
    };
    state.turnOrder = [turn.id];
    state.turnsById = { [turn.id]: turn };

    render(
      <CodexThreadView
        renderError={({ error, scope }) => (
          <div>
            Host {scope} error: {error.message}
          </div>
        )}
        state={state}
      />,
    );

    expect(screen.getByText("Host turn error: Turn failed")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps pending approval visible and moves decisions into turn history", () => {
    const state = createCodexThreadState("thread-1");
    const turn = createCodexTurnState("turn-1");
    turn.status = "completed";
    state.turnOrder = [turn.id];
    state.turnsById = { [turn.id]: turn };
    state.approvalsById = {
      pending: approval("pending", "pending", null, "Pending command"),
      accepted: approval("accepted", "resolved", "accept", "Accepted command"),
      rejected: approval("rejected", "resolved", "decline", "Rejected command"),
      canceled: approval("canceled", "resolved", "cancel", "Canceled command"),
      unscoped: {
        ...approval("unscoped", "resolved", "accept", "Unscoped approval"),
        turnId: null,
      },
    };

    render(
      <CodexThreadProvider
        autoRefreshStatus={false}
        initialState={state}
        transport={transport}
      >
        <CodexChat />
      </CodexThreadProvider>,
    );

    expect(screen.getByText("Waiting for approval")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getAllByText("Approval accepted")).toHaveLength(2);
    expect(screen.getByText("Approval rejected")).toBeTruthy();
    expect(screen.getByText("Approval canceled")).toBeTruthy();
    expect(screen.getByText("Accepted command")).toBeTruthy();
    expect(screen.getByText("Rejected command")).toBeTruthy();
    expect(screen.getByText("Canceled command")).toBeTruthy();
    expect(screen.getByText("Unscoped approval")).toBeTruthy();
  });
});

function approval(
  requestId: string,
  status: CodexApprovalState["status"],
  decision: CodexApprovalState["decision"],
  reason: string,
): CodexApprovalState {
  return {
    requestId,
    method: "item/commandExecution/requestApproval",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: null,
    reason,
    startedAtMs: 1,
    availableDecisions: ["accept", "decline"],
    status,
    decision,
    resolvedAt: status === "pending" ? null : 2,
    params: {},
    raw: {},
  };
}
