import type {
  CodexItemState,
  CodexThreadState,
  CodexTurnState,
} from "./state.js";

export function selectTurns(state: CodexThreadState): CodexTurnState[] {
  return state.turnOrder.flatMap((turnId) => {
    const turn = state.turnsById[turnId];
    return turn ? [turn] : [];
  });
}

export function selectTurnItems(turn: CodexTurnState): CodexItemState[] {
  return turn.itemOrder
    .flatMap((itemId) => {
      const item = turn.itemsById[itemId];
      return item ? [item] : [];
    })
    .sort((left, right) => left.firstSeenSequence - right.firstSeenSequence);
}

export function selectPendingApprovals(state: CodexThreadState) {
  return Object.values(state.approvalsById).filter(
    (approval) => approval.status === "pending",
  );
}

export function selectPendingServerRequests(state: CodexThreadState) {
  return Object.values(state.serverRequestsById).filter(
    (request) => request.status === "pending",
  );
}
