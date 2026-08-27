// @vitest-environment happy-dom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CodexMarkdown } from "../../src/react/index.js";

afterEach(cleanup);

describe("CodexMarkdown streaming updates", () => {
  it("replaces an incomplete fenced-code fallback with highlighted content", async () => {
    const { container, rerender } = render(
      <CodexMarkdown>{"```ts\nconst streamedValue ="}</CodexMarkdown>,
    );

    expect(container.querySelector(".animate-spin")).not.toBeNull();

    rerender(
      <CodexMarkdown>
        {"```ts\nconst streamedValue = 1;\n```\n\n完成"}
      </CodexMarkdown>,
    );

    await waitFor(() => {
      expect(
        container.querySelector('[data-streamdown="code-block-body"]'),
      ).not.toBeNull();
    });
    expect(container.textContent).toContain("const streamedValue = 1;");
    expect(container.textContent).toContain("完成");
    expect(container.innerHTML).not.toContain("bg-black");
  });
});
