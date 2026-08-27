import type { CodexEvent } from "./events.js";
import { reduceCodexEvent } from "./reducer.js";
import { type CodexThreadState, createCodexThreadState } from "./state.js";

export function replayCodexEvents(
  events: Iterable<CodexEvent>,
  initialState: CodexThreadState = createCodexThreadState(),
): CodexThreadState {
  let state = initialState;
  for (const event of events) state = reduceCodexEvent(state, event);
  return state;
}
