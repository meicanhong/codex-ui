import type { CodexJsonObject, CodexJsonValue } from "./protocol.js";

type EnvelopeBase = {
  streamId?: string;
  sequence: number;
  receivedAt: number;
  method: string;
  params: CodexJsonObject;
  raw: CodexJsonObject;
};

export type CodexAppServerEnvelope =
  | (EnvelopeBase & { kind: "notification" })
  | (EnvelopeBase & {
      kind: "serverRequest";
      requestId: string | number;
    });

export type CodexExecPolicyAmendment = string[];

export type CodexNetworkPolicyAmendment = {
  host: string;
  action: "allow" | "deny";
};

export type CodexApprovalDecision =
  | "accept"
  | "acceptForSession"
  | {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: CodexExecPolicyAmendment;
      };
    }
  | {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: CodexNetworkPolicyAmendment;
      };
    }
  | "decline"
  | "cancel";

export type CodexLocalEvent =
  | {
      kind: "approvalResolved";
      requestId: string | number;
      decision: CodexApprovalDecision;
      resolvedAt: number;
    }
  | {
      kind: "serverRequestResponded";
      requestId: string | number;
      resolvedAt: number;
    }
  | {
      kind: "transportError";
      threadId: string | null;
      turnId: string | null;
      code: string;
      message: string;
      details?: CodexJsonValue;
      occurredAt: number;
    }
  | { kind: "clearTransportError" }
  | { kind: "resetThread"; threadId: string | null }
  | {
      kind: "turnInterrupted";
      threadId: string | null;
      turnId: string;
      interruptedAt: number;
    };

export type CodexEvent = CodexAppServerEnvelope | CodexLocalEvent;
