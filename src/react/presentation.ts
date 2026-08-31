import type {
  CodexItemState,
  CodexRenderableThreadItem,
  CodexTurnState,
} from "../core/index.js";

export type CodexMarkdownTone = "commentary" | "reasoning" | "answer" | "code";

export type CodexToolPresentation = {
  label: string;
  detail?: string | null;
};

export type CodexUiLabels = {
  emptyTitle: string;
  emptyDescription: string;
  composerPlaceholder: string;
  send: string;
  stop: string;
  attachImages: string;
  removeImage: (name: string) => string;
  imageLimitReached: (limit: number) => string;
  imageTooLarge: (name: string, maxMegabytes: number) => string;
  imageTypeUnsupported: (name: string) => string;
  imageReadFailed: (name: string) => string;
  starting: string;
  working: (duration: string) => string;
  completed: (duration: string) => string;
  interrupted: (duration: string) => string;
  failed: (duration: string) => string;
  approve: string;
  approveForSession: string;
  approveWithExecPolicy: string;
  applyNetworkPolicy: (host: string, action: "allow" | "deny") => string;
  decline: string;
  cancel: string;
  approvalTitle: string;
  approvalWaiting: string;
  approvalAccepted: string;
  approvalRejected: string;
  approvalCanceled: string;
  approvalResolved: string;
  approvalUnavailable: string;
  approvalFailed: string;
  approvalCommand: string;
  approvalWorkingDirectory: string;
  approvalNetworkHost: string;
  approvalFiles: string;
  approvalWriteRoot: string;
  serverRequestPending: (method: string) => string;
  details: string;
  plan: string;
  changes: string;
  citations: string;
  hookPrompt: string;
  tokenUsage: (tokens: number) => string;
  unknownItem: (type: string) => string;
};

export const defaultCodexUiLabels: CodexUiLabels = {
  emptyTitle: "What can I help with?",
  emptyDescription: "Ask Codex to investigate, explain, or build something.",
  composerPlaceholder: "Message Codex",
  send: "Send message",
  stop: "Stop",
  attachImages: "Attach images",
  removeImage: (name) => `Remove ${name}`,
  imageLimitReached: (limit) => `You can attach up to ${limit} images.`,
  imageTooLarge: (name, maxMegabytes) =>
    `${name} is larger than ${maxMegabytes} MB.`,
  imageTypeUnsupported: (name) => `${name} is not a supported image type.`,
  imageReadFailed: (name) => `${name} could not be read.`,
  starting: "Starting",
  working: (duration) => `Worked for ${duration}`,
  completed: (duration) => `Worked for ${duration}`,
  interrupted: (duration) => `Interrupted after ${duration}`,
  failed: (duration) => `Stopped after ${duration}`,
  approve: "Approve",
  approveForSession: "Approve for session",
  approveWithExecPolicy: "Approve and remember this command",
  applyNetworkPolicy: (host, action) =>
    `${action === "allow" ? "Allow" : "Deny"} ${host} and remember`,
  decline: "Decline",
  cancel: "Cancel",
  approvalTitle: "Codex needs your approval",
  approvalWaiting: "Waiting for approval",
  approvalAccepted: "Approval accepted",
  approvalRejected: "Approval rejected",
  approvalCanceled: "Approval canceled",
  approvalResolved: "Approval completed",
  approvalUnavailable: "The host has not configured approval handling.",
  approvalFailed: "The decision could not be sent. Try again.",
  approvalCommand: "Command",
  approvalWorkingDirectory: "Working directory",
  approvalNetworkHost: "Network host",
  approvalFiles: "Files",
  approvalWriteRoot: "Write scope",
  serverRequestPending: (method) =>
    `Codex is waiting for the host to handle ${method}.`,
  details: "Details",
  plan: "Plan",
  changes: "Changes",
  citations: "Sources",
  hookPrompt: "Hook prompt",
  tokenUsage: (tokens) => `${tokens.toLocaleString()} tokens`,
  unknownItem: (type) => `Received ${type}`,
};

export function defaultToolPresentation(
  itemState: CodexItemState,
): CodexToolPresentation | null {
  const item = itemState.item;
  const done = itemState.lifecycle === "completed";
  switch (item.type) {
    case "commandExecution":
      return {
        label:
          item.status === "failed"
            ? "Command failed"
            : item.status === "declined"
              ? "Command declined"
              : done
                ? "Ran a command"
                : "Running a command",
        detail: item.command || null,
      };
    case "fileChange":
      return {
        label:
          item.status === "failed"
            ? "File change failed"
            : item.status === "declined"
              ? "File change declined"
              : done
                ? "Edited files"
                : "Editing files",
        detail: item.changes.map((change) => change.path).join(", ") || null,
      };
    case "mcpToolCall":
      return {
        label:
          item.status === "failed"
            ? `${item.server} failed`
            : done
              ? `Used ${item.server}`
              : `Using ${item.server}`,
        detail: item.tool,
      };
    case "dynamicToolCall":
      return {
        label:
          item.status === "failed"
            ? `${item.tool} failed`
            : done
              ? `Used ${item.tool}`
              : `Using ${item.tool}`,
        detail: item.namespace,
      };
    case "collabAgentToolCall":
      return {
        label:
          item.status === "failed"
            ? "Agent coordination failed"
            : done
              ? "Coordinated agents"
              : "Coordinating agents",
        detail: item.tool,
      };
    case "subAgentActivity":
      return { label: "Updated a sub-agent", detail: item.agentPath };
    case "webSearch":
      return {
        label: done ? "Searched the web" : "Searching the web",
        detail: item.query,
      };
    case "imageView":
      return { label: "Viewed an image", detail: item.path };
    case "imageGeneration":
      return { label: done ? "Generated an image" : "Generating an image" };
    case "sleep":
      return { label: `Waited ${formatDuration(item.durationMs)}` };
    case "enteredReviewMode":
      return { label: "Entered review mode" };
    case "exitedReviewMode":
      return { label: "Exited review mode" };
    case "contextCompaction":
      return { label: "Compacted context" };
    case "unknown":
      return { label: `Received ${item.originalType}` };
    default:
      return null;
  }
}

export function getTurnDuration(turn: CodexTurnState, now: number) {
  if (turn.durationMs !== null) return turn.durationMs;
  if (turn.startedAt === null) return 0;
  return Math.max(0, (turn.completedAt ?? now) - turn.startedAt);
}

export function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function extractUserText(item: CodexRenderableThreadItem) {
  if (item.type !== "userMessage") return "";
  return item.content
    .map((content) => {
      switch (content.type) {
        case "text":
          return content.text;
        case "image":
          return formatMediaReference(content.url);
        case "localImage":
          return formatMediaReference(content.path);
        case "skill":
          return `$${content.name}`;
        case "mention":
          return `@${content.name}`;
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

function formatMediaReference(reference: string) {
  return reference.startsWith("data:") ? "[Image]" : `[Image] ${reference}`;
}
