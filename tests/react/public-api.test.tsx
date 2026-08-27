import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type CodexItemState,
  createCodexTurnState,
} from "../../src/core/index.js";
import {
  CodexAgentMessage,
  CodexError,
  CodexMarkdown,
  CodexPlan,
  CodexProvider,
  CodexReasoning,
  CodexRunStatus,
  CodexThread,
  CodexThreadProvider,
  CodexThreadView,
  CodexToolCall,
  CodexUserMessage,
} from "../../src/react/index.js";

const turn = createCodexTurnState("turn-1");

function itemState(item: CodexItemState["item"]): CodexItemState {
  return {
    id: item.id,
    item,
    lifecycle: "completed",
    firstSeenSequence: 1,
    lastSeenSequence: 1,
    startedAtMs: 1,
    completedAtMs: 2,
    progress: [],
    raw: {},
  };
}

describe("public React API", () => {
  it("exports stable provider and controlled-thread aliases", () => {
    expect(CodexProvider).toBe(CodexThreadProvider);
    expect(CodexThread).toBe(CodexThreadView);
  });

  it("renders streaming Markdown with lists, inline code, and fenced code", () => {
    const html = renderToStaticMarkup(
      <CodexMarkdown>
        {"第一行\n\n- 条目\n\n`inline`\n\n```sql\nSELECT 1;\n```"}
      </CodexMarkdown>,
    );

    expect(html).toContain("codex-ui-markdown");
    expect(html).toContain("<ul");
    expect(html).toContain("<code");
    expect(html).toContain("rounded-xl border");
    expect(html).not.toContain("bg-black");
  });

  it("keeps incomplete streaming list, emphasis, and code-fence fragments renderable", () => {
    const fragments = [
      "正在分析\n\n- 第一项\n- **第二项",
      "正在分析\n\n- 第一项\n- **第二项**\n\n```ts\nconst value = 1",
      "正在分析\n\n- 第一项\n- **第二项**\n\n```ts\nconst value = 1;\n```",
    ];

    const rendered = fragments.map((fragment) =>
      renderToStaticMarkup(<CodexMarkdown>{fragment}</CodexMarkdown>),
    );

    for (const html of rendered) {
      expect(html).toContain("正在分析");
      expect(html).toContain("第一项");
      expect(html).toContain("codex-ui-markdown");
      expect(html).not.toContain("bg-black");
    }
    expect(rendered[0]).toContain("<ul");
    expect(rendered[1]).toContain("animate-spin");
    expect(rendered[2]).toContain("rounded-xl border");
  });

  it("renders tables, safe links, long text, and long code without changing tone", () => {
    const longToken = "customer_identifier_".repeat(80);
    const longCode = `SELECT '${"value".repeat(400)}';`;
    const html = renderToStaticMarkup(
      <CodexMarkdown tone="reasoning">
        {`| 字段 | 值 |\n| --- | --- |\n| customer | [详情](https://example.test/customer) |\n\n${longToken}\n\n\`\`\`sql\n${longCode}\n\`\`\``}
      </CodexMarkdown>,
    );

    expect(html).toContain("<table");
    expect(html).toContain('data-streamdown="link"');
    expect(html).toContain("详情");
    expect(html).toContain(longToken);
    expect(html).toContain("rounded-xl border");
    expect(html).toContain("codex-ui-markdown--reasoning");
    expect(html).not.toContain("bg-black");
  });

  it("renders the named turn primitives through their public contracts", () => {
    const user = itemState({
      type: "userMessage",
      id: "user-1",
      clientId: null,
      content: [{ type: "text", text: "用户消息", text_elements: [] }],
    });
    const agent = itemState({
      type: "agentMessage",
      id: "agent-1",
      text: "最终回答",
      phase: "final_answer",
      memoryCitation: null,
    });
    const reasoning = itemState({
      type: "reasoning",
      id: "reasoning-1",
      summary: ["分析摘要"],
      content: ["private content"],
    });
    const tool = itemState({
      type: "webSearch",
      id: "tool-1",
      query: "Codex App Server",
      action: { type: "search", query: "Codex", queries: null },
    });

    const html = renderToStaticMarkup(
      <>
        <CodexRunStatus now={2_000} turn={turn} />
        <CodexPlan
          plan={{
            explanation: "执行计划",
            steps: [{ step: "查询", status: "inProgress" }],
          }}
        />
        <CodexUserMessage itemState={user} turn={turn} />
        <CodexAgentMessage itemState={agent} turn={turn} />
        <CodexReasoning itemState={reasoning} />
        <CodexToolCall itemState={tool} />
        <CodexError message="测试错误" />
      </>,
    );

    expect(html).toContain("用户消息");
    expect(html).toContain("最终回答");
    expect(html).toContain("分析摘要");
    expect(html).not.toContain("private content");
    expect(html).toContain("Codex App Server");
    expect(html).toContain("执行计划");
    expect(html).toContain('role="alert"');
  });
});
