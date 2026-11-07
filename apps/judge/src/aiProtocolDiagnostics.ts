import { OmittableString, omittableStringToString } from "./omittableString";

export interface ProtocolTransition {
  stage: number;
  event: "started" | "finished";
  status?: string;
}

/** Kept only in an author-private evidence artifact, never ordinary contestant-visible results. */
export function protocolDiagnostics(
  stage: number,
  helper: "manager" | "interactor",
  result: {
    status: string;
    userError?: OmittableString;
    interactorMessage?: OmittableString;
    systemMessage?: OmittableString;
    roleDiagnostics?: { contestant: OmittableString; helper: OmittableString };
  },
  transitions: ProtocolTransition[]
): Buffer {
  const bounded = (value: OmittableString) => {
    const text = value == null ? "" : omittableStringToString(value);
    const bytes = Buffer.from(text);
    return {
      text: bytes.subarray(0, 4096).toString("utf8"),
      truncated: bytes.length > 4096 || (value != null && typeof value !== "string")
    };
  };
  return Buffer.from(
    JSON.stringify({
      version: 1,
      stage,
      status: result.status,
      roles: {
        std: bounded(result.roleDiagnostics?.contestant ?? result.userError),
        [helper]: bounded(result.roleDiagnostics?.helper ?? result.interactorMessage)
      },
      system: bounded(result.systemMessage),
      transitions: transitions.slice(0, 8),
      transcript: {
        status: "unexported",
        reason: "Protocol streams can contain hidden inputs; only role stderr and lifecycle transitions are retained."
      }
    })
  );
}
