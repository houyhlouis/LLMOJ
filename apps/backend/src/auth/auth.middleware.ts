import { NestMiddleware, Injectable } from "@nestjs/common";

import { Request, Response } from "express"; // eslint-disable-line import/no-extraneous-dependencies

import { AuthSessionService } from "./auth-session.service";
import { bearerSessionKey, cookieSessionAllowed, cookieSessionKey } from "./session-cookie";

import { UserEntity } from "../user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";
import { requestContext } from "../common/request-context";

export interface Session {
  sessionKey?: string;
  sessionId?: number;
  /** The session came from the session cookie rather than the Authorization header. */
  viaCookie?: boolean;
  user?: UserEntity;
  userHasSkipRecaptchaPrivilege: () => Promise<boolean>;
}

export interface RequestWithSession extends Request {
  session: Session;
}

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    private readonly authSessionService: AuthSessionService,
    private readonly userPrivilegeService: UserPrivilegeService
  ) {}

  async use(req: RequestWithSession, res: Response, next: () => void): Promise<void> {
    // A token in the Authorization header comes first. Without one, a page of the same origin may have its session in
    // the cookie, which it may use only as session-cookie.ts allows.
    let sessionKey = bearerSessionKey(req);
    const viaCookie = !sessionKey && !!cookieSessionKey(req) && cookieSessionAllowed(req);
    if (viaCookie) sessionKey = cookieSessionKey(req);
    if (sessionKey) {
      const { sessionId, user, ended } = await this.authSessionService.resolveSession(sessionKey);
      // The request continues as a visitor's. The header lets the client sign out instead of acting signed in.
      if (ended) {
        res.setHeader("X-Session-Ended", "1");
        if (viaCookie) this.authSessionService.forgetSessionCookie(req);
      }
      if (user) {
        let userHasSkipRecaptchaPrivilegePromise: Promise<boolean>;
        req.session = {
          sessionKey,
          sessionId,
          viaCookie,
          user,
          userHasSkipRecaptchaPrivilege: () => {
            if (!userHasSkipRecaptchaPrivilegePromise) {
              userHasSkipRecaptchaPrivilegePromise = this.userPrivilegeService.userHasPrivilege(
                user,
                UserPrivilegeType.SkipRecaptcha
              );
            }
            return userHasSkipRecaptchaPrivilegePromise;
          }
        };
      }
    }

    requestContext.run(req, () => next());
  }
}

/**
 * Get the current request object from async local storage.
 *
 * Calling it in a EventEmitter's callback may be not working since EventEmitter's callbacks
 * run in different contexts.
 */
export function getCurrentRequest(): RequestWithSession {
  return requestContext.getStore() as RequestWithSession;
}
