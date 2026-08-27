import { describe, expect, it } from "vitest";
import {
  type CodexAppServerEnvelope,
  type CodexJsonObject,
  createCodexThreadState,
  reduceCodexEvent,
  replayCodexEvents,
  selectPendingApprovals,
  selectPendingServerRequests,
  selectTurnItems,
} from "../../src/core/index.js";

function notification(
  sequence: number,
  method: string,
  params: CodexJsonObject,
): CodexAppServerEnvelope {
  return {
    kind: "notification",
    sequence,
    receivedAt: 1_000 + sequence,
    method,
    params,
    raw: { method, params },
  };
}

describe("reduceCodexEvent", () => {
  it("normalizes App Server turn timestamps from Unix seconds", () => {
    const state = replayCodexEvents([
      notification(1, "turn/started", {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "inProgress",
          error: null,
          startedAt: 1_787_760_111,
          completedAt: null,
          durationMs: null,
        },
      }),
    ]);

    expect(state.turnsById["turn-1"]?.startedAt).toBe(1_787_760_111_000);
  });

  it("merges message deltas and treats the completed item as authoritative", () => {
    const state = replayCodexEvents([
      notification(1, "turn/started", {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "inProgress",
          error: null,
          startedAt: 10,
          completedAt: null,
          durationMs: null,
        },
      }),
      notification(2, "item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "你",
      }),
      notification(3, "item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "好",
      }),
      notification(4, "item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 1_500,
        item: {
          type: "agentMessage",
          id: "message-1",
          text: "你好。",
          phase: "final_answer",
          memoryCitation: null,
        },
      }),
      notification(5, "item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "不应追加",
      }),
    ]);

    const item = state.turnsById["turn-1"]?.itemsById["message-1"];
    expect(item?.lifecycle).toBe("completed");
    expect(item?.completedAtMs).toBe(1_500);
    expect(item?.item).toMatchObject({
      type: "agentMessage",
      text: "你好。",
      phase: "final_answer",
    });
  });

  it("keeps reasoning summary/content indexes and original item order", () => {
    const state = replayCodexEvents([
      notification(1, "item/reasoning/summaryTextDelta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        summaryIndex: 1,
        delta: "第二步",
      }),
      notification(2, "item/reasoning/summaryTextDelta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        summaryIndex: 0,
        delta: "第一步",
      }),
      notification(3, "item/reasoning/textDelta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        contentIndex: 0,
        delta: "内部内容",
      }),
      notification(4, "item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 1_000,
        item: {
          type: "mcpToolCall",
          id: "tool-1",
          server: "starrocks",
          tool: "query",
          status: "inProgress",
          arguments: { sql: "select 1" },
          appContext: null,
          pluginId: null,
          result: null,
          error: null,
          durationMs: null,
        },
      }),
    ]);

    const turn = state.turnsById["turn-1"];
    expect(turn).toBeDefined();
    expect(
      selectTurnItems(turn as NonNullable<typeof turn>).map((item) => item.id),
    ).toEqual(["reasoning-1", "tool-1"]);
    expect(turn?.itemsById["reasoning-1"]?.item).toMatchObject({
      type: "reasoning",
      summary: ["第一步", "第二步"],
      content: ["内部内容"],
    });
  });

  it("creates official reasoning summary slots before merging their deltas", () => {
    const state = replayCodexEvents([
      notification(1, "item/reasoning/summaryPartAdded", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        summaryIndex: 1,
      }),
      notification(2, "item/reasoning/summaryPartAdded", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        summaryIndex: 0,
      }),
      notification(3, "item/reasoning/summaryTextDelta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        summaryIndex: 1,
        delta: "第二段",
      }),
      notification(4, "item/reasoning/summaryTextDelta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        summaryIndex: 0,
        delta: "第一段",
      }),
    ]);

    expect(
      state.turnsById["turn-1"]?.itemsById["reasoning-1"]?.item,
    ).toMatchObject({
      type: "reasoning",
      summary: ["第一段", "第二段"],
    });
    expect(
      state.unknownEvents.some(
        (event) => event.method === "item/reasoning/summaryPartAdded",
      ),
    ).toBe(false);
  });

  it("applies official file-change patch updates while the item is running", () => {
    const state = replayCodexEvents([
      notification(1, "item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 1_000,
        item: {
          type: "fileChange",
          id: "file-change-1",
          changes: [],
          status: "inProgress",
        },
      }),
      notification(2, "item/fileChange/patchUpdated", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "file-change-1",
        changes: [
          {
            path: "/tmp/new.ts",
            kind: { type: "add" },
            diff: "+export const value = 1;",
          },
          {
            path: "/tmp/old.ts",
            kind: { type: "update", move_path: null },
            diff: "-old\n+new",
          },
        ],
      }),
    ]);

    expect(state.turnsById["turn-1"]?.itemsById["file-change-1"]).toMatchObject(
      {
        lifecycle: "started",
        item: {
          type: "fileChange",
          status: "inProgress",
          changes: [
            { path: "/tmp/new.ts", kind: { type: "add" } },
            {
              path: "/tmp/old.ts",
              kind: { type: "update", move_path: null },
            },
          ],
        },
      },
    );
    expect(
      state.unknownEvents.some(
        (event) => event.method === "item/fileChange/patchUpdated",
      ),
    ).toBe(false);
  });

  it("merges command, plan, MCP progress, and turn diff updates before authoritative completion", () => {
    const state = replayCodexEvents([
      notification(1, "item/commandExecution/outputDelta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        delta: "partial output",
      }),
      notification(2, "item/plan/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "plan-1",
        delta: "partial plan",
      }),
      notification(3, "item/mcpToolCall/progress", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "mcp-1",
        message: "Reading schema",
      }),
      notification(4, "turn/diff/updated", {
        threadId: "thread-1",
        turnId: "turn-1",
        diff: "--- before\n+++ after",
      }),
      notification(5, "item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "command-1",
          command: "printf done",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "authoritative output",
          exitCode: 0,
          durationMs: 12,
        },
      }),
      notification(6, "item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "plan", id: "plan-1", text: "authoritative plan" },
      }),
      notification(7, "item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "mcp-1",
          server: "starrocks",
          tool: "query",
          status: "completed",
          arguments: { sql: "SELECT 1" },
          appContext: null,
          pluginId: null,
          result: null,
          error: null,
          durationMs: 8,
        },
      }),
    ]);

    expect(state.turnsById["turn-1"]?.diff).toBe("--- before\n+++ after");
    expect(
      state.turnsById["turn-1"]?.itemsById["command-1"]?.item,
    ).toMatchObject({
      type: "commandExecution",
      aggregatedOutput: "authoritative output",
      status: "completed",
    });
    expect(state.turnsById["turn-1"]?.itemsById["plan-1"]?.item).toMatchObject({
      type: "plan",
      text: "authoritative plan",
    });
    expect(state.turnsById["turn-1"]?.itemsById["mcp-1"]?.progress).toEqual([
      "Reading schema",
    ]);
    expect(state.unknownEvents).toEqual([]);
  });

  it("ignores stale sequences from the same stream without blocking a new stream", () => {
    const newer = {
      ...notification(2, "item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "newer",
      }),
      streamId: "stream-1",
    };
    const stale = {
      ...notification(1, "item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "stale",
      }),
      streamId: "stream-1",
    };
    const restarted = {
      ...notification(1, "item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "-new-stream",
      }),
      streamId: "stream-2",
    };

    const state = replayCodexEvents([newer, stale, newer, restarted]);

    expect(
      state.turnsById["turn-1"]?.itemsById["message-1"]?.item,
    ).toMatchObject({
      type: "agentMessage",
      text: "newer-new-stream",
    });
    expect(state.latestSequenceByStream).toEqual({
      "stream-1": 2,
      "stream-2": 1,
    });
  });

  it("handles completed-before-started and duplicate sequences without downgrading", () => {
    const completed = notification(2, "item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 2_000,
      item: { type: "plan", id: "plan-1", text: "完成方案" },
    });
    const state = replayCodexEvents([
      completed,
      notification(1, "item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 1_000,
        item: { type: "plan", id: "plan-1", text: "旧方案" },
      }),
      completed,
    ]);

    expect(state.seenEventKeys).toEqual([
      "thread-1:turn-1:2",
      "thread-1:turn-1:1",
    ]);
    expect(state.turnsById["turn-1"]?.itemsById["plan-1"]).toMatchObject({
      lifecycle: "completed",
      item: { type: "plan", text: "完成方案" },
    });
  });

  it("keeps consecutive turn streams when sequence numbers restart", () => {
    const first = {
      ...notification(1, "turn/started", {
        threadId: "thread-1",
        turn: { id: "turn-1", items: [], status: "inProgress" },
      }),
      streamId: "stream-1",
    };
    const second = {
      ...notification(1, "turn/started", {
        threadId: "thread-1",
        turn: { id: "turn-2", items: [], status: "inProgress" },
      }),
      streamId: "stream-2",
    };

    const state = replayCodexEvents([first, second]);

    expect(state.turnOrder).toEqual(["turn-1", "turn-2"]);
    expect(state.seenEventKeys).toEqual(["stream-1:1", "stream-2:1"]);
  });

  it("preserves unknown item types and unknown notifications", () => {
    const state = replayCodexEvents([
      notification(1, "item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 1_000,
        item: { type: "futureWidget", id: "future-1", payload: { value: 42 } },
      }),
      notification(2, "future/event", {
        threadId: "thread-1",
        future: true,
      }),
    ]);

    expect(state.turnsById["turn-1"]?.itemsById["future-1"]?.item).toEqual({
      type: "unknown",
      id: "future-1",
      originalType: "futureWidget",
      raw: { type: "futureWidget", id: "future-1", payload: { value: 42 } },
    });
    expect(state.unknownEvents).toHaveLength(1);
    expect(state.unknownEvents[0]?.method).toBe("future/event");
  });

  it("downgrades malformed known item payloads instead of trusting their type", () => {
    const state = replayCodexEvents([
      notification(1, "item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "fileChange", id: "bad-file-change" },
      }),
    ]);

    expect(
      state.turnsById["turn-1"]?.itemsById["bad-file-change"]?.item,
    ).toEqual({
      type: "unknown",
      id: "bad-file-change",
      originalType: "fileChange",
      raw: { type: "fileChange", id: "bad-file-change" },
    });
  });

  it("stores structured plan, token usage, turn errors, and multiple turns", () => {
    const state = replayCodexEvents([
      notification(1, "turn/plan/updated", {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: "执行顺序",
        plan: [
          { step: "检查", status: "completed" },
          { step: "实现", status: "inProgress" },
        ],
      }),
      notification(2, "thread/tokenUsage/updated", {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: {
            totalTokens: 100,
            inputTokens: 60,
            cachedInputTokens: 10,
            outputTokens: 40,
            reasoningOutputTokens: 20,
          },
          last: {
            totalTokens: 50,
            inputTokens: 30,
            cachedInputTokens: 5,
            outputTokens: 20,
            reasoningOutputTokens: 10,
          },
          modelContextWindow: 128000,
        },
      }),
      notification(3, "turn/completed", {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "failed",
          error: {
            message: "失败",
            codexErrorInfo: { code: "provider_error" },
            additionalDetails: "详情",
          },
          startedAt: 10,
          completedAt: 12,
          durationMs: 2_000,
        },
      }),
      notification(4, "turn/started", {
        threadId: "thread-1",
        turn: {
          id: "turn-2",
          items: [],
          status: "inProgress",
          error: null,
          startedAt: 13,
          completedAt: null,
          durationMs: null,
        },
      }),
    ]);

    expect(state.turnOrder).toEqual(["turn-1", "turn-2"]);
    expect(state.turnsById["turn-1"]?.plan?.steps).toHaveLength(2);
    expect(state.turnsById["turn-1"]?.error?.message).toBe("失败");
    expect(state.tokenUsage?.total.totalTokens).toBe(100);
  });

  it("tracks approval requests separately from ThreadItem and resolves them", () => {
    const request: CodexAppServerEnvelope = {
      kind: "serverRequest",
      requestId: 7,
      sequence: 1,
      receivedAt: 1_001,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        startedAtMs: 1_000,
        reason: "需要授权",
        command: "git status",
      },
      raw: { id: 7, method: "item/commandExecution/requestApproval" },
    };

    const pending = reduceCodexEvent(createCodexThreadState(), request);
    expect(selectPendingApprovals(pending)).toHaveLength(1);
    expect(pending.approvalsById["7"]?.availableDecisions).toEqual([
      "accept",
      "cancel",
    ]);
    const resolved = reduceCodexEvent(pending, {
      kind: "approvalResolved",
      requestId: 7,
      decision: "accept",
      resolvedAt: 2_000,
    });
    expect(selectPendingApprovals(resolved)).toHaveLength(0);
    expect(resolved.approvalsById["7"]).toMatchObject({
      status: "resolved",
      decision: "accept",
    });
    expect(selectPendingServerRequests(resolved)).toHaveLength(0);
  });

  it("preserves the ordered official command approval decisions", () => {
    const request: CodexAppServerEnvelope = {
      kind: "serverRequest",
      requestId: "approval-structured",
      sequence: 1,
      receivedAt: 1_001,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        startedAtMs: 1_000,
        availableDecisions: [
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["git", "status"],
            },
          },
          {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: {
                host: "api.example.com",
                action: "allow",
              },
            },
          },
          "decline",
        ],
      },
      raw: {},
    };

    const state = reduceCodexEvent(createCodexThreadState(), request);

    expect(
      state.approvalsById["approval-structured"]?.availableDecisions,
    ).toEqual(request.params.availableDecisions);
    expect(state.unknownEvents).toHaveLength(0);
  });

  it("derives official approval decisions when stable 0.142 omits availableDecisions", () => {
    const requests: CodexAppServerEnvelope[] = [
      {
        kind: "serverRequest",
        requestId: "exec-policy",
        sequence: 1,
        receivedAt: 1,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "command-1",
          proposedExecpolicyAmendment: ["git", "status"],
        },
        raw: {},
      },
      {
        kind: "serverRequest",
        requestId: "network-policy",
        sequence: 2,
        receivedAt: 2,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "command-2",
          networkApprovalContext: {
            host: "api.example.com",
            protocol: "https",
          },
          proposedNetworkPolicyAmendments: [
            { host: "blocked.example.com", action: "deny" },
            { host: "api.example.com", action: "allow" },
          ],
        },
        raw: {},
      },
      {
        kind: "serverRequest",
        requestId: "permissions",
        sequence: 3,
        receivedAt: 3,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "command-3",
          additionalPermissions: {
            network: { enabled: true },
            fileSystem: null,
          },
        },
        raw: {},
      },
      {
        kind: "serverRequest",
        requestId: "file-change",
        sequence: 4,
        receivedAt: 4,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "file-1",
        },
        raw: {},
      },
    ];

    const state = replayCodexEvents(requests, createCodexThreadState());

    expect(state.approvalsById["exec-policy"]?.availableDecisions).toEqual([
      "accept",
      {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ["git", "status"],
        },
      },
      "cancel",
    ]);
    expect(state.approvalsById["network-policy"]?.availableDecisions).toEqual([
      "accept",
      "acceptForSession",
      {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            host: "api.example.com",
            action: "allow",
          },
        },
      },
      "cancel",
    ]);
    expect(state.approvalsById.permissions?.availableDecisions).toEqual([
      "accept",
      "cancel",
    ]);
    expect(state.approvalsById["file-change"]?.availableDecisions).toEqual([
      "accept",
      "acceptForSession",
      "cancel",
    ]);
  });

  it("normalizes legacy approval scope and decisions against the active turn", () => {
    let state = reduceCodexEvent(
      createCodexThreadState(),
      notification(1, "turn/started", {
        threadId: "legacy-thread",
        turn: { id: "turn-1", status: "inProgress", items: [], startedAt: 1 },
      }),
    );
    state = reduceCodexEvent(state, {
      kind: "serverRequest",
      requestId: 7,
      sequence: 2,
      receivedAt: 2,
      method: "execCommandApproval",
      params: {
        conversationId: "legacy-thread",
        callId: "call-1",
        command: ["git", "status"],
        cwd: "/workspace",
        reason: null,
        parsedCmd: [],
      },
      raw: {},
    });

    expect(state.approvalsById["7"]).toMatchObject({
      threadId: "legacy-thread",
      turnId: "turn-1",
      itemId: "call-1",
      availableDecisions: ["accept", "cancel"],
    });
  });

  it("keeps non-approval server requests out of approval cards", () => {
    const request: CodexAppServerEnvelope = {
      kind: "serverRequest",
      requestId: "input-1",
      sequence: 1,
      receivedAt: 1_001,
      method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId: "turn-1", questions: [] },
      raw: { id: "input-1", method: "item/tool/requestUserInput" },
    };
    const pending = reduceCodexEvent(createCodexThreadState(), request);

    expect(selectPendingApprovals(pending)).toHaveLength(0);
    expect(selectPendingServerRequests(pending)).toHaveLength(1);

    const resolved = reduceCodexEvent(
      pending,
      notification(2, "serverRequest/resolved", {
        threadId: "thread-1",
        requestId: "input-1",
      }),
    );
    expect(selectPendingServerRequests(resolved)).toHaveLength(0);
  });

  it("keeps permission grants out of decision-only approval cards", () => {
    const request: CodexAppServerEnvelope = {
      kind: "serverRequest",
      requestId: "permissions-1",
      sequence: 1,
      receivedAt: 1_001,
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        environmentId: null,
        permissions: {},
      },
      raw: { id: "permissions-1", method: "item/permissions/requestApproval" },
    };
    const pending = reduceCodexEvent(createCodexThreadState(), request);

    expect(selectPendingApprovals(pending)).toHaveLength(0);
    expect(selectPendingServerRequests(pending)).toHaveLength(1);
  });

  it("fails a running turn and its pending requests after transport failure", () => {
    let state = reduceCodexEvent(
      createCodexThreadState(),
      notification(1, "turn/started", {
        threadId: "thread-1",
        turn: { id: "turn-1", items: [], status: "inProgress", startedAt: 10 },
      }),
    );
    state = reduceCodexEvent(state, {
      kind: "serverRequest",
      requestId: 7,
      sequence: 2,
      receivedAt: 12,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "command-1" },
      raw: {},
    });
    state = reduceCodexEvent(state, {
      kind: "transportError",
      threadId: "thread-1",
      turnId: "turn-1",
      code: "network_failed",
      message: "network failed",
      occurredAt: 30,
    });

    expect(state.turnsById["turn-1"]).toMatchObject({
      status: "failed",
      completedAt: 30,
      durationMs: 20,
    });
    expect(state.approvalsById["7"]?.status).toBe("failed");
    expect(state.serverRequestsById["7"]?.status).toBe("failed");
  });

  it("closes pending requests when their turn is interrupted locally", () => {
    let state = reduceCodexEvent(
      createCodexThreadState(),
      notification(1, "turn/started", {
        threadId: "thread-1",
        turn: { id: "turn-1", items: [], status: "inProgress", startedAt: 10 },
      }),
    );
    state = reduceCodexEvent(state, {
      kind: "serverRequest",
      requestId: 7,
      sequence: 2,
      receivedAt: 12,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "command-1" },
      raw: {},
    });
    state = reduceCodexEvent(state, {
      kind: "turnInterrupted",
      threadId: "thread-1",
      turnId: "turn-1",
      interruptedAt: 30,
    });

    expect(state.turnsById["turn-1"]?.status).toBe("interrupted");
    expect(state.approvalsById["7"]?.status).toBe("failed");
    expect(state.serverRequestsById["7"]?.status).toBe("failed");
    expect(selectPendingApprovals(state)).toHaveLength(0);
    expect(selectPendingServerRequests(state)).toHaveLength(0);

    const staleApproval = reduceCodexEvent(state, {
      kind: "approvalResolved",
      requestId: 7,
      decision: "accept",
      resolvedAt: 31,
    });
    const staleRequest = reduceCodexEvent(staleApproval, {
      kind: "serverRequestResponded",
      requestId: 7,
      resolvedAt: 32,
    });
    expect(staleRequest.approvalsById["7"]?.status).toBe("failed");
    expect(staleRequest.serverRequestsById["7"]?.status).toBe("failed");
  });

  it("does not retain retryable protocol errors after a successful retry", () => {
    const state = replayCodexEvents([
      notification(1, "turn/started", {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "inProgress",
          error: null,
          startedAt: 10,
          completedAt: null,
          durationMs: null,
        },
      }),
      notification(2, "error", {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: true,
        error: {
          message: "temporary disconnect",
          codexErrorInfo: {
            responseStreamDisconnected: { httpStatusCode: 502 },
          },
          additionalDetails: null,
        },
      }),
      notification(3, "turn/completed", {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "completed",
          error: null,
          startedAt: 10,
          completedAt: 12,
          durationMs: 2_000,
        },
      }),
    ]);

    expect(state.lastError).toBeNull();
    expect(state.turnsById["turn-1"]?.status).toBe("completed");
  });

  it("replaces a terminal protocol alert with the authoritative turn error", () => {
    const state = replayCodexEvents([
      notification(1, "error", {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: {
          message: "provider failed",
          codexErrorInfo: "internalServerError",
          additionalDetails: null,
        },
      }),
      notification(2, "turn/completed", {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "failed",
          error: {
            message: "provider failed",
            codexErrorInfo: "internalServerError",
            additionalDetails: null,
          },
          startedAt: 10,
          completedAt: 12,
          durationMs: 2_000,
        },
      }),
    ]);

    expect(state.lastError).toBeNull();
    expect(state.turnsById["turn-1"]?.error?.message).toBe("provider failed");
  });

  it("closes interrupted turns, clears errors, and resets thread state", () => {
    const failed = reduceCodexEvent(createCodexThreadState(), {
      kind: "transportError",
      threadId: "thread-1",
      turnId: "turn-1",
      code: "failed",
      message: "failed",
      occurredAt: 20,
    });
    const running = reduceCodexEvent(
      failed,
      notification(1, "turn/started", {
        threadId: "thread-1",
        turn: { id: "turn-1", items: [], status: "inProgress", startedAt: 10 },
      }),
    );
    const cleared = reduceCodexEvent(running, { kind: "clearTransportError" });
    const interrupted = reduceCodexEvent(cleared, {
      kind: "turnInterrupted",
      threadId: "thread-1",
      turnId: "turn-1",
      interruptedAt: 30,
    });

    expect(interrupted.lastError).toBeNull();
    expect(interrupted.turnsById["turn-1"]).toMatchObject({
      status: "interrupted",
      completedAt: 30,
      durationMs: 20,
    });
    expect(
      reduceCodexEvent(interrupted, {
        kind: "resetThread",
        threadId: "thread-2",
      }),
    ).toEqual(createCodexThreadState("thread-2"));
  });
});
