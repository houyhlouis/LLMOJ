import { Logger } from "@nestjs/common";

import { AdvancedConsoleLogger, Logger as TypeOrmLogger, QueryRunner } from "typeorm";

import { requestContext } from "../common/request-context";

/** What a request's queries took, kept on the request object. */
export interface RequestQueries {
  requestId?: string;
  sqlQueries?: number;
  // Only queries over QUERY_TIMING_THRESHOLD_MS are timed, so this slightly underestimates
  sqlMilliseconds?: number;
}

// TypeORM times a query only when it takes longer than this (its `maxQueryExecutionTime`)
export const QUERY_TIMING_THRESHOLD_MS = 1;

// Queries that take this long are logged, without their parameters
export const SLOW_QUERY_MS = Number(process.env.LIBREOJ_SLOW_QUERY_MS) || 1000;

// At most this many slow queries are logged a minute; the rest are counted
const SLOW_QUERY_LOGS_PER_MINUTE = 10;

/** Since the process started. */
export const queryTotals = { slow: 0 };

const logger = new Logger("SQL");

function answeredRequest(): RequestQueries | undefined {
  const request = requestContext.getStore() as (RequestQueries & { res?: { writableEnded?: boolean } }) | undefined;
  // Work a request started that runs on after its response (an AI job) isn't counted for it
  return request && !request.res?.writableEnded ? request : undefined;
}

/**
 * Counts each request's queries and the time of those slower than 1 ms, and logs slow queries. With
 * `LIBREOJ_LOG_SQL` set, it also prints every query as TypeORM's own logger does.
 */
export class QueryMetricsLogger implements TypeOrmLogger {
  private readonly printer: TypeOrmLogger;

  private slowLogged: { minute: number; count: number } = { minute: 0, count: 0 };

  // The request each query runner last started a query for. The driver reports a query's time from its own callback,
  // outside the request's context; a runner runs one query at a time.
  private readonly runnerRequests = new WeakMap<QueryRunner, RequestQueries>();

  constructor(printAll = false) {
    this.printer = printAll ? new AdvancedConsoleLogger("all") : null;
  }

  logQuery(query: string, parameters?: unknown[], queryRunner?: QueryRunner): void {
    const request = answeredRequest();
    if (request) request.sqlQueries = (request.sqlQueries ?? 0) + 1;
    if (queryRunner) {
      if (request) this.runnerRequests.set(queryRunner, request);
      else this.runnerRequests.delete(queryRunner);
    }
    this.printer?.logQuery(query, parameters, queryRunner);
  }

  logQuerySlow(time: number, query: string, parameters?: unknown[], queryRunner?: QueryRunner): void {
    const request = (queryRunner && this.runnerRequests.get(queryRunner)) ?? answeredRequest();
    if (request) request.sqlMilliseconds = (request.sqlMilliseconds ?? 0) + time;
    if (time < SLOW_QUERY_MS) return;
    queryTotals.slow++;
    const minute = Math.floor(Date.now() / 60000);
    if (this.slowLogged.minute !== minute) this.slowLogged = { minute, count: 0 };
    if (++this.slowLogged.count > SLOW_QUERY_LOGS_PER_MINUTE) return;
    // The statement only: parameters can hold user data
    const statement = query.replace(/\s+/g, " ").trim();
    logger.warn(
      `${request?.requestId ? `[request ${request.requestId}] ` : ""}Slow query (${time} ms): ${
        statement.length > 300 ? `${statement.slice(0, 300)}…` : statement
      }`
    );
    this.printer?.logQuerySlow(time, query, parameters, queryRunner);
  }

  logQueryError(error: string | Error, query: string, parameters?: unknown[], queryRunner?: QueryRunner): void {
    this.printer?.logQueryError(error, query, parameters, queryRunner);
  }

  logSchemaBuild(message: string, queryRunner?: QueryRunner): void {
    this.printer?.logSchemaBuild(message, queryRunner);
  }

  logMigration(message: string, queryRunner?: QueryRunner): void {
    this.printer?.logMigration(message, queryRunner);
  }

  log(level: "log" | "info" | "warn", message: unknown, queryRunner?: QueryRunner): void {
    this.printer?.log(level, message, queryRunner);
  }
}
