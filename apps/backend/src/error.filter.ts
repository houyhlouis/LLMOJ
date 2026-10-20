import { randomUUID } from "crypto";

import { ExceptionFilter, Catch, ArgumentsHost, HttpException, Logger } from "@nestjs/common";

import { Response } from "express"; // eslint-disable-line import/no-extraneous-dependencies

import { RequestWithSession } from "./auth/auth.middleware";
import { RequestWithId } from "./common/request-id.middleware";
import { EventReportService, EventReportType } from "./event-report/event-report.service";
import { MetricsService } from "./metrics/metrics.service";
import { isAiRequest, AI_ERROR_REPORT_MESSAGE } from "./ai/ai-security";

const logger = new Logger("ErrorFilter");

const CONNECTION_ERROR_LOG_INTERVAL = 60 * 1000;

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(
    private readonly eventReportService: EventReportService,
    private readonly metricsService: MetricsService
  ) {}

  private readonly metricErrorCount = this.metricsService.counter("libreoj_error_count", ["error"]);

  private connectionErrorLoggedAt = -Infinity;

  catch(error: Error, host: ArgumentsHost) {
    const contextType = host.getType();
    let request: RequestWithSession & RequestWithId;
    // Unhandled errors are only described in server logs; clients get a stable code and an ID to quote.
    let requestId: string = randomUUID();
    if (contextType === "http") {
      request = host.switchToHttp().getRequest<RequestWithSession & RequestWithId>();
      requestId = request.requestId ?? requestId;
      const response = host.switchToHttp().getResponse<Response>();
      if (error instanceof HttpException) response.status(error.getStatus()).send(error.getResponse());
      else response.status(500).send({ error: "INTERNAL_ERROR", requestId });
    }

    if (!(error instanceof HttpException)) {
      if (error instanceof Error) {
        // Lost or refused connections (a dependency restarting or overloaded) are counted and logged at most once a
        // minute, without event reports.
        if (this.isignoredError(error)) {
          this.metricErrorCount.inc({ error: error.constructor.name });
          if (Date.now() - this.connectionErrorLoggedAt >= CONNECTION_ERROR_LOG_INTERVAL) {
            this.connectionErrorLoggedAt = Date.now();
            const description = isAiRequest(request?.originalUrl) ? error.constructor.name : error.message;
            logger.warn(`[${requestId}] Connection error, not logged again for a minute: ${description}`);
          }
          return;
        }

        // The error's class (never its message) is safe to log for AI requests.
        if (isAiRequest(request?.originalUrl))
          logger.error(`[${requestId}] ${AI_ERROR_REPORT_MESSAGE} (${error.constructor.name})`);
        else logger.error(`[${requestId}] ${error.message}`, error.stack);
      } else logger.error(isAiRequest(request?.originalUrl) ? `[${requestId}] ${AI_ERROR_REPORT_MESSAGE}` : error);

      this.metricErrorCount.inc({ error: error.constructor.name });
      this.eventReportService.report({
        type: EventReportType.Error,
        error,
        request,
        message: `ErrorFilter has caught a uncaught exception (request ${requestId}).`
      });
    }
  }

  isignoredError(error: Error) {
    if (error.message.includes("Too many connections")) return true;
    if (error.message === "connect ETIMEDOUT") return true;
    if (error.message === "Connection lost: The server closed the connection.") return true;
    if (error.message === "read ECONNRESET") return true;

    return false;
  }
}
