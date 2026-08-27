// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexSessionProvider,
  CodexSessionSwitcher,
  CodexThreadProvider,
} from "../../src/react/index.js";
import type {
  CodexSession,
  CodexSessionTransport,
  CodexTransport,
} from "../../src/transport/index.js";

afterEach(cleanup);

const firstSession: CodexSession = {
  id: "session-1",
  threadId: "thread-1",
  title: "第一段会话",
  preview: "查询订单",
  createdAt: 1,
  updatedAt: 2,
  archived: false,
  raw: {},
};

const secondSession: CodexSession = {
  ...firstSession,
  id: "session-2",
  threadId: "thread-2",
  title: "第二段会话",
  preview: "分析复购",
  updatedAt: 1,
};

function threadTransport(
  loadThread: CodexTransport["loadThread"],
): CodexTransport {
  return {
    capabilities: {
      approvals: false,
      interrupt: false,
      loadThread: true,
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
    loadThread,
    respondToApproval: vi.fn(),
    respondToServerRequest: vi.fn(),
  };
}

function sessionTransport(overrides: Partial<CodexSessionTransport> = {}) {
  return {
    listSessions: vi.fn().mockResolvedValue({
      sessions: [firstSession, secondSession],
    }),
    createSession: vi.fn().mockResolvedValue({
      ...firstSession,
      id: "session-3",
      threadId: "thread-3",
      title: "新会话",
      updatedAt: 3,
    }),
    renameSession: vi.fn(),
    archiveSession: vi.fn(),
    unarchiveSession: vi.fn(),
    deleteSession: vi.fn(),
    ...overrides,
  } satisfies CodexSessionTransport;
}

describe("Codex sessions", () => {
  it("loads, switches, and creates native Codex sessions", async () => {
    const loadThread = vi
      .fn<CodexTransport["loadThread"]>()
      .mockResolvedValue([]);
    const sessions = sessionTransport();
    const user = userEvent.setup();
    render(
      <CodexThreadProvider
        autoRefreshStatus={false}
        transport={threadTransport(loadThread)}
      >
        <CodexSessionProvider transport={sessions}>
          <CodexSessionSwitcher />
        </CodexSessionProvider>
      </CodexThreadProvider>,
    );

    expect(await screen.findByText("第一段会话")).toBeTruthy();
    expect(loadThread).toHaveBeenLastCalledWith({
      conversationId: "session-1",
      threadId: "thread-1",
    });

    await user.click(screen.getByRole("button", { name: /第一段会话/ }));
    const secondSessionButtons = screen.getAllByRole("button", {
      name: /^第二段会话/,
    });
    await user.click(secondSessionButtons.at(-1) as HTMLButtonElement);
    await waitFor(() =>
      expect(loadThread).toHaveBeenLastCalledWith({
        conversationId: "session-2",
        threadId: "thread-2",
      }),
    );

    await user.click(screen.getByRole("button", { name: /第二段会话/ }));
    await user.click(screen.getByRole("button", { name: /New session/ }));
    await waitFor(() =>
      expect(sessions.createSession).toHaveBeenCalledTimes(1),
    );
    expect(loadThread).toHaveBeenLastCalledWith({
      conversationId: "session-3",
      threadId: "thread-3",
    });
  });
});
