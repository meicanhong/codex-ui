import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type CodexAppServerEnvelope,
  createCodexThreadState,
  replayCodexEvents,
} from "../../src/core/index.js";
import { CodexThreadView } from "../../src/react/index.js";
import { officialThreadItems } from "../fixtures/thread-items.js";

function event(
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

describe("CodexThreadView", () => {
  it("keeps transport errors visible before the first turn starts", () => {
    const state = replayCodexEvents(
      [
        {
          kind: "transportError",
          threadId: "thread-1",
          turnId: null,
          code: "codex_turn_unavailable",
          message: "Codex is temporarily unavailable",
          occurredAt: 100,
        },
      ],
      createCodexThreadState(),
    );

    const html = renderToStaticMarkup(<CodexThreadView state={state} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Codex is temporarily unavailable");
  });

  it("renders user text, summarized reasoning, tools, and final newlines", () => {
    const state = replayCodexEvents(
      [
        event(1, "turn/started", {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "inProgress",
            items: [],
            startedAt: 100,
          },
        }),
        event(2, "item/completed", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "userMessage",
            id: "user-1",
            clientId: null,
            content: [
              { type: "text", text: "第一行\n第二行", text_elements: [] },
              { type: "image", url: "https://example.test/input.png" },
            ],
          },
        }),
        event(3, "item/completed", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "hookPrompt",
            id: "hook-1",
            fragments: [{ text: "Hook 内容", hookRunId: "hook-run-1" }],
          },
        }),
        event(4, "item/completed", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "reasoning",
            id: "reasoning-1",
            summary: ["Checking the schema"],
            content: ["raw-private-reasoning"],
          },
        }),
        event(5, "item/completed", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "mcpToolCall",
            id: "tool-1",
            server: "StarRocks",
            tool: "query",
            status: "completed",
            arguments: {},
            appContext: null,
            pluginId: null,
            result: null,
            error: null,
            durationMs: 120,
          },
        }),
        event(6, "item/completed", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "webSearch",
            id: "web-1",
            query: "Codex App Server",
            action: { type: "openPage", url: "https://example.test/docs" },
          },
        }),
        event(7, "item/completed", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "imageGeneration",
            id: "image-1",
            status: "completed",
            revisedPrompt: "blue square",
            result: "https://example.test/generated.png",
          },
        }),
        event(8, "turn/completed", {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "completed",
            startedAt: 100,
            completedAt: 2100,
            durationMs: 2000,
            items: [
              {
                type: "agentMessage",
                id: "answer-1",
                text: "答案第一行\n答案第二行",
                phase: "final_answer",
                memoryCitation: {
                  entries: [
                    {
                      path: "memory.md",
                      lineStart: 7,
                      lineEnd: 9,
                      note: "历史依据",
                    },
                  ],
                  threadIds: ["thread-source"],
                },
              },
            ],
          },
        }),
      ],
      createCodexThreadState(),
    );

    const html = renderToStaticMarkup(<CodexThreadView state={state} />);
    expect(html).toContain("第一行\n第二行");
    expect(html).toContain("Checking the schema");
    expect(html).toContain("Hook 内容");
    expect(html).toContain("Used StarRocks");
    expect(html).toContain("codex-ui-tool-heading is-inline");
    expect(html).toContain(
      '<code class="codex-ui-tool-inline-detail">query</code>',
    );
    expect(html).toContain("codex-ui-tool-wrench");
    expect(html).toContain("openPage");
    expect(html).toContain("generated.png");
    expect(html).toContain("input.png");
    expect(html).toContain("答案第一行\n答案第二行");
    expect(html).toContain("memory.md");
    expect(html).not.toContain("raw-private-reasoning");
  });

  it("allows host applications to replace tool presentation", () => {
    const state = replayCodexEvents(
      [
        event(1, "item/completed", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "unknown-tool-kind",
            id: "future-1",
            payload: "preserved",
          },
        }),
      ],
      createCodexThreadState(),
    );
    const html = renderToStaticMarkup(
      <CodexThreadView
        getToolPresentation={() => ({ label: "Host-defined tool" })}
        state={state}
      />,
    );
    expect(html).toContain("Host-defined tool");
  });

  it("renders every supported ThreadItem through the default presentation", () => {
    const state = replayCodexEvents(
      officialThreadItems.map((item, index) =>
        event(index + 1, "item/completed", {
          threadId: "thread-1",
          turnId: "turn-1",
          item,
        }),
      ),
      createCodexThreadState(),
    );

    const html = renderToStaticMarkup(<CodexThreadView state={state} />);
    const visibleContent = [
      "用户消息",
      "input.png",
      "/tmp/local.png",
      "$schema",
      "@customer",
      "Hook prompt text",
      "Commentary message",
      "Plan item text",
      "Reasoning summary",
      "Ran a command",
      "command-output",
      "Edited files",
      "/tmp/add.ts",
      "Used analytics",
      "Used lookupCustomer",
      "Coordinated agents",
      "Updated a sub-agent",
      "Searched the web",
      "Viewed an image",
      "Waited 2s",
      "Generated an image",
      "Entered review mode",
      "Exited review mode",
      "Compacted context",
    ];
    for (const content of visibleContent) expect(html).toContain(content);
    expect(html).not.toContain("private reasoning");
  });
});
