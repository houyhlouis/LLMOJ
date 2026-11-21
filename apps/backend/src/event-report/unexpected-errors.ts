import { randomUUID } from "crypto";

import { ReportRequest, reportErrorClass } from "./report-redaction";

const DAY = 24 * 60 * 60 * 1000;
const CAPACITY = 100;
const CLASS_LIMIT = 64;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"]);
export const REQUEST_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface UnexpectedHttpError {
  requestId: string;
  time: string;
  method: string | null;
  route: string | null;
  status: 500;
  errorClass: string;
}

/** Holds only server-generated IDs, Express route templates and counter labels. One bounded history per process. */
export class UnexpectedErrors {
  private readonly entries: UnexpectedHttpError[] = [];

  private readonly totals = new Map<string, number>();

  private expire(now: number): void {
    const cutoff = new Date(now - DAY).toISOString();
    while (this.entries.length && this.entries[0].time <= cutoff) this.entries.shift();
  }

  record(error: unknown, requestId: string, request?: ReportRequest, now = Date.now()): string {
    this.expire(now);
    let errorClass = reportErrorClass(error);
    if (!this.totals.has(errorClass) && this.totals.size >= CLASS_LIMIT - 1) errorClass = "OtherError";
    this.totals.set(errorClass, (this.totals.get(errorClass) || 0) + 1);
    if (request) {
      // baseUrl can contain substituted mount parameters. Only the router's declared template is eligible.
      const path = request.route?.path;
      const route = typeof path === "string" && /^\/[a-zA-Z0-9_./:{}*-]{0,191}$/.test(path) ? path : null;
      this.entries.push({
        requestId: REQUEST_UUID.test(requestId) ? requestId : randomUUID(),
        time: new Date(now).toISOString(),
        method: METHODS.has(request.method) ? request.method : null,
        route,
        status: 500,
        errorClass
      });
      if (this.entries.length > CAPACITY) this.entries.shift();
    }
    return errorClass;
  }

  snapshot(now = Date.now()) {
    this.expire(now);
    return {
      scope: "responding_process" as const,
      recent: this.entries.slice().reverse(),
      totals: Array.from(this.totals, ([errorClass, count]) => ({ errorClass, count }))
    };
  }
}

export const unexpectedErrors = new UnexpectedErrors();
