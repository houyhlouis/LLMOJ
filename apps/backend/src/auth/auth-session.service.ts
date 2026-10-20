import { join } from "path";
import fs from "fs-extra";

import { ForbiddenException, Injectable } from "@nestjs/common";

import jwt from "jsonwebtoken";
import { Redis } from "ioredis";

import type { Request } from "express"; // eslint-disable-line import/no-extraneous-dependencies

import { RegistrationReviewService } from "./registration-review.service";
import {
  cookieSessionKey,
  expiredSessionCookie,
  sessionCookie,
  sessionMarker,
  wantsCookieSession
} from "./session-cookie";

import { UserEntity } from "../user/user.entity";
import { ConfigService } from "../config/config.service";
import { UserService } from "../user/user.service";
import { RedisService } from "../redis/redis.service";

// Refer to scripts/session-manager.lua for session management details
interface RedisWithSessionManager extends Redis {
  callSessionManager(...args: (string | number)[]): Promise<unknown>;
}

interface SessionInfoInternal {
  loginIp: string;
  userAgent: string;
  loginTime: number;
}

export interface SessionInfo extends SessionInfoInternal {
  sessionId: number;
  lastAccessTime: number;
}

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

// Sensitive account changes require a password (and second factor) entered this recently in the same session.
const RECENT_AUTHENTICATION_SECONDS = 10 * 60;
const REDIS_KEY_RECENT_AUTHENTICATION = "session-recent-authentication:%d:%d";

// Used when the configuration doesn't set `security.sessionIdleTimeoutDays` / `security.sessionMaxAgeDays`.
export const DEFAULT_SESSION_IDLE_TIMEOUT_DAYS = 30;
export const DEFAULT_SESSION_MAX_AGE_DAYS = 90;
// Site administrators' sessions end sooner (`security.adminSessionIdleTimeoutDays` / `security.adminSessionMaxAgeDays`).
export const DEFAULT_ADMIN_SESSION_IDLE_TIMEOUT_DAYS = 3;
export const DEFAULT_ADMIN_SESSION_MAX_AGE_DAYS = 30;

/** Returned for a sensitive change when the password wasn't entered recently; the client confirms and repeats it. */
export const REAUTHENTICATION_REQUIRED = "REAUTHENTICATION_REQUIRED";

export interface ResolvedSession {
  sessionId?: number;
  user?: UserEntity;
  /** The key can never be used again: invalid, revoked, expired, or its account may no longer sign in. */
  ended?: boolean;
}

@Injectable()
export class AuthSessionService {
  private redis: RedisWithSessionManager;

  constructor(
    private readonly configService: ConfigService,
    private readonly userService: UserService,
    private readonly redisService: RedisService,
    private readonly registrationReviews: RegistrationReviewService
  ) {
    this.redis = this.redisService.getClient() as RedisWithSessionManager;
    this.redis.defineCommand("callSessionManager", {
      numberOfKeys: 0,
      lua: fs.readFileSync(join(__dirname, "scripts", "session-manager.lua")).toString("utf-8")
    });
  }

  async newSession(user: UserEntity, loginIp: string, userAgent: string): Promise<string> {
    await this.registrationReviews.requireApproved(user);
    const timeStamp = +new Date();
    const sessionInfo: SessionInfoInternal = {
      loginIp,
      userAgent,
      loginTime: timeStamp
    };

    const sessionId = await this.redis.callSessionManager("new", timeStamp, user.id, JSON.stringify(sessionInfo));
    // Signing in is a full authentication.
    await this.markRecentlyAuthenticated(user.id, Number(sessionId));

    return jwt.sign(`${user.id.toString()} ${sessionId}`, this.configService.config.security.sessionSecret);
  }

  /**
   * Signs the user in with a new session for this request's device. A page that asks for the session cookie (from
   * the same origin) gets the cookie, and keeps a marker of the session instead of its token: see session-cookie.ts.
   *
   * @returns What the client keeps: the session token, or the marker.
   */
  async issueSession(user: UserEntity, req: Request): Promise<string> {
    return this.deliverSession(req, await this.newSession(user, req.ip, req.headers["user-agent"]));
  }

  /** Puts the session in the cookie if the page asks for that and the site allows it; returns what the client keeps. */
  deliverSession(req: Request, sessionKey: string): string {
    if (!this.sessionCookiesEnabled() || !wantsCookieSession(req) || !req.res) return sessionKey;
    const [, sessionId] = this.decodeSessionKey(sessionKey);
    const { sessionMaxAgeDays } = this.configService.config.security;
    req.res.append("Set-Cookie", sessionCookie(req, sessionKey, sessionMaxAgeDays ?? DEFAULT_SESSION_MAX_AGE_DAYS));
    return sessionMarker(sessionId);
  }

  /** Removes the session cookie from the browser, if the request has one. */
  forgetSessionCookie(req: Request): void {
    if (cookieSessionKey(req) && req.res) req.res.append("Set-Cookie", expiredSessionCookie(req));
  }

  /** Sessions are kept in cookies unless the configuration turns that off (`security.sessionCookie: false`). */
  sessionCookiesEnabled(): boolean {
    return this.configService.config.security.sessionCookie !== false;
  }

  async markRecentlyAuthenticated(userId: number, sessionId: number): Promise<void> {
    await this.redis.set(
      REDIS_KEY_RECENT_AUTHENTICATION.format(userId, sessionId),
      "1",
      "EX",
      RECENT_AUTHENTICATION_SECONDS
    );
  }

  /** Whether the session's user entered their credentials in the last few minutes. */
  async isRecentlyAuthenticated(userId: number, sessionId: number): Promise<boolean> {
    if (!userId || !sessionId) return false;
    return (await this.redis.exists(REDIS_KEY_RECENT_AUTHENTICATION.format(userId, sessionId))) === 1;
  }

  /**
   * For routes that report errors with HTTP status codes: refuses a sensitive change with 403
   * `{ error: "REAUTHENTICATION_REQUIRED" }` unless the password was entered recently in this session.
   */
  async requireRecentAuthentication(user: UserEntity, sessionId: number): Promise<void> {
    if (!(await this.isRecentlyAuthenticated(user?.id, sessionId)))
      throw new ForbiddenException({ error: REAUTHENTICATION_REQUIRED });
  }

  private decodeSessionKey(sessionKey: string): [userId: number, sessionId: number] {
    const jwtString = jwt.verify(sessionKey, this.configService.config.security.sessionSecret) as string;
    return jwtString.split(" ").map(s => Number(s)) as [userId: number, sessionId: number];
  }

  /**
   * A session expires when unused for the idle timeout, or when older than the maximum age (0: no limit).
   * A site administrator's session gets the stricter of the general and the administrator limits.
   */
  private sessionLimits(user: UserEntity): [idleTimeout: number, maxAge: number] {
    const { security } = this.configService.config;
    const days = (value: number, fallback: number) => (value ?? fallback) * DAY_MILLISECONDS;
    const idleTimeout = days(security.sessionIdleTimeoutDays, DEFAULT_SESSION_IDLE_TIMEOUT_DAYS);
    const maxAge = days(security.sessionMaxAgeDays, DEFAULT_SESSION_MAX_AGE_DAYS);
    if (!user?.isAdmin) return [idleTimeout, maxAge];
    const stricter = (a: number, b: number) => (a && b ? Math.min(a, b) : a || b);
    return [
      stricter(idleTimeout, days(security.adminSessionIdleTimeoutDays, DEFAULT_ADMIN_SESSION_IDLE_TIMEOUT_DAYS)),
      stricter(maxAge, days(security.adminSessionMaxAgeDays, DEFAULT_ADMIN_SESSION_MAX_AGE_DAYS))
    ];
  }

  async revokeSession(userId: number, sessionId: number): Promise<void> {
    await this.redis.callSessionManager("revoke", userId, sessionId);
  }

  async revokeAllSessionsExcept(userId: number, sessionId: number): Promise<void> {
    await this.redis.callSessionManager("revoke_all_except", userId, sessionId);
  }

  async endSession(sessionKey: string): Promise<void> {
    try {
      const [userId, sessionId] = this.decodeSessionKey(sessionKey);
      await this.revokeSession(userId, sessionId);
    } catch (e) {
      // Do nothing if we can't decide the session key.
    }
  }

  /** Checks a session key and refreshes its last use. Storage errors resolve to neither a user nor `ended`. */
  async resolveSession(sessionKey: string): Promise<ResolvedSession> {
    let ids: [userId: number, sessionId: number];
    try {
      ids = this.decodeSessionKey(sessionKey);
    } catch {
      return { ended: true };
    }
    const [userId, sessionId] = ids;
    try {
      const user = await this.accessSessionById(userId, sessionId);
      return user ? { sessionId, user } : { ended: true };
    } catch {
      return {};
    }
  }

  async accessSession(sessionKey: string): Promise<[sessionId: number, user: UserEntity]> {
    const { sessionId, user } = await this.resolveSession(sessionKey);
    return user ? [sessionId, user] : [null, null];
  }

  /**
   * The session's user, or null when the session is unknown, expired, or its account may not sign in.
   * Subscription credentials carry the issuing session's IDs, never its login token.
   */
  async accessSessionById(userId: number, sessionId: number): Promise<UserEntity> {
    // The user decides the session's limits: administrators' sessions end sooner.
    const user = await this.userService.findUserById(userId);
    if (!user) {
      await this.revokeSession(userId, sessionId);
      return null;
    }
    const success = await this.redis.callSessionManager(
      "access",
      Date.now(),
      userId,
      sessionId,
      ...this.sessionLimits(user)
    );
    if (!success) return null;
    try {
      await this.registrationReviews.requireApproved(user);
      return user;
    } catch (error) {
      // A pending or rejected registration may not use its sessions; storage errors propagate.
      if (error instanceof ForbiddenException) return null;
      throw error;
    }
  }

  async listUserSessions(userId: number): Promise<SessionInfo[]> {
    const user = await this.userService.findUserById(userId);
    const result = (await this.redis.callSessionManager("list", userId, Date.now(), ...this.sessionLimits(user))) as [
      sessionId: string,
      lastAccessTime: string,
      sessionInfo: string
    ][];
    return result.map(([sessionId, lastAccessTime, sessionInfo]): SessionInfo => ({
      sessionId: Number(sessionId),
      lastAccessTime: Number(lastAccessTime),
      ...JSON.parse(sessionInfo)
    }));
  }
}
