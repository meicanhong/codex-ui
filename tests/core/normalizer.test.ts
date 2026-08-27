import { describe, expect, it } from "vitest";
import { normalizeCodexThreadItem } from "../../src/core/index.js";
import { officialThreadItems } from "../fixtures/thread-items.js";

describe("normalizeCodexThreadItem", () => {
  it("accepts one official-shaped fixture for every ThreadItem branch", () => {
    const normalized = officialThreadItems.map((item) =>
      normalizeCodexThreadItem(item),
    );

    expect(normalized).toHaveLength(18);
    expect(normalized.every((item) => item && item.type !== "unknown")).toBe(
      true,
    );
    expect(normalized.map((item) => item?.type)).toEqual(
      officialThreadItems.map((item) => item.type),
    );
  });

  it("accepts every WebSearchAction variant", () => {
    const actions = [
      { type: "search", query: "Codex", queries: ["Codex", "App Server"] },
      { type: "openPage", url: "https://example.test" },
      {
        type: "findInPage",
        url: "https://example.test",
        pattern: "Codex",
      },
      { type: "other" },
    ] as const;

    for (const [index, action] of actions.entries()) {
      expect(
        normalizeCodexThreadItem({
          type: "webSearch",
          id: `web-${index}`,
          query: "Codex",
          action,
        }),
      ).toMatchObject({ type: "webSearch", action });
    }
  });
});
