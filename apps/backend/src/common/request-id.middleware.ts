import { randomUUID } from "crypto";

import { Injectable, NestMiddleware } from "@nestjs/common";

import { Request, Response } from "express"; // eslint-disable-line import/no-extraneous-dependencies

export interface RequestWithId extends Request {
  requestId?: string;
}

/**
 * Every API response carries an `X-Request-Id`. Error responses and server logs quote the same ID, so a user can
 * report it and an administrator can find the matching log line.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: RequestWithId, res: Response, next: () => void): void {
    req.requestId = randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    next();
  }
}
