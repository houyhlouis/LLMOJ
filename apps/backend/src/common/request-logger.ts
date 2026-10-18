import { ConsoleLogger, LogLevel } from "@nestjs/common";

import { requestContext } from "./request-context";

/** The ID (`X-Request-Id`) of the request being answered, if any. */
export function currentRequestId(): string | undefined {
  const request = requestContext.getStore() as { requestId?: string; res?: { writableEnded?: boolean } } | undefined;
  // Background work a request starts (an AI job) keeps its context after the response, but isn't that request.
  if (!request?.requestId || request.res?.writableEnded) return undefined;
  return request.requestId;
}

/**
 * Marks each message logged while a request is answered with the request's ID, the one its `X-Request-Id` header and
 * error messages quote, so that an administrator can find every log line of a reported error.
 */
export class RequestLogger extends ConsoleLogger {
  protected formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string
  ): string {
    const id = currentRequestId();
    const marked = id && !(typeof message === "string" && message.includes(id));
    return super.formatMessage(
      logLevel,
      message,
      pidMessage,
      formattedLogLevel,
      marked ? `${contextMessage}[request ${id}] ` : contextMessage,
      timestampDiff
    );
  }
}
