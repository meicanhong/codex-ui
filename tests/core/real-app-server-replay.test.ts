import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createCodexThreadState,
  replayCodexEvents,
  selectTurnItems,
} from "../../src/core/index.js";
import {
  CodexSseDecoder,
  parseAppServerEnvelopeFrame,
} from "../../src/transport/index.js";

describe("recorded Codex App Server v2 turn", () => {
  it("decodes and replays a real sanitized stream", () => {
    const fixture = readFileSync(
      fileURLToPath(
        new URL("../fixtures/real-app-server-v2-turn.sse", import.meta.url),
      ),
    );
    const decoder = new CodexSseDecoder();
    const frames = [...decoder.push(fixture), ...decoder.finish()].filter(
      (frame) => frame.event === "app_server_event",
    );
    const events = frames.map(parseAppServerEnvelopeFrame);
    const state = replayCodexEvents(events, createCodexThreadState());
    const turn = state.turnsById["recorded-id-2"];
    const items = turn ? selectTurnItems(turn) : [];

    expect(events).toHaveLength(20);
    expect(state.threadId).toBe("recorded-id-1");
    expect(turn?.status).toBe("completed");
    expect(turn?.startedAt).toBe(1_700_000_000_000);
    expect(turn?.durationMs).toBe(4_976);
    expect(
      items.find((entry) => entry.item.type === "reasoning")?.item,
    ).toMatchObject({ summary: ["**Providing exact phrase**"] });
    expect(
      items.find((entry) => entry.item.type === "agentMessage")?.item,
    ).toMatchObject({ text: "真实回放通过", phase: "final_answer" });
    expect(state.tokenUsage?.total.totalTokens).toBe(6_567);
    expect(
      state.unknownEvents.some(
        (event) => event.method === "item/reasoning/summaryPartAdded",
      ),
    ).toBe(false);
  });
});
