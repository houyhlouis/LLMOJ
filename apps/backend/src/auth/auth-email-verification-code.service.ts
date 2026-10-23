import { randomInt } from "crypto";
import { join } from "path";
import fs from "fs";

import { Injectable, Inject, forwardRef } from "@nestjs/common";

import { Redis } from "ioredis";

import { RedisService } from "../redis/redis.service";

/*
 * Email verification codes (review N09). A code proves control of an address for one purpose: registering with it,
 * changing an account's address to it, or resetting the password of the account that has it. Changing and resetting
 * codes are also bound to that account. A code is used up by its first right answer, in one Redis step, so two
 * requests with the same code cannot both act, whichever backend process serves them.
 *
 * - A new code for the same purpose and address replaces the earlier one, which stops working.
 * - A code stops working after 5 wrong answers. A purpose and address accept at most 20 wrong answers an hour across
 *   codes, which bounds guessing however many codes are requested.
 * - A used code is never given back, even if the change it allowed then fails: the user requests a new code.
 * - Codes are never logged.
 */

// Seconds between codes sent to one address
const RATE_LIMIT = 60;
const CODE_VALID_TIME = 60 * 15;
const CODE_MAX_FAILURES = 5;
const ADDRESS_MAX_FAILURES = 20;
const ADDRESS_FAILURE_WINDOW = 60 * 60;

const REDIS_KEY_EMAIL_VERIFICATION_CODE_RATE_LIMIT = "email-verification-code-rate-limit:%s";
const REDIS_KEY_EMAIL_VERIFICATION_CHALLENGE = "email-verification-challenge:%s:%s";
const REDIS_KEY_EMAIL_VERIFICATION_FAILURES = "email-verification-failures:%s:%s";

export enum EmailVerificationCodeType {
  Register = "Register",
  ChangeEmail = "ChangeEmail",
  ResetPassword = "ResetPassword"
}

/** "used": this caller, and no other, may now do what the code was sent for. "limited": too many wrong answers. */
export type EmailVerificationCodeCheck = "used" | "wrong" | "limited";

// Refer to scripts/email-verification-code.lua
interface RedisWithEmailVerificationCode extends Redis {
  useEmailVerificationCode(...args: (string | number)[]): Promise<"OK" | "WRONG" | "LIMITED">;
}

/** The site compares addresses without regard to case, so a code is for the address in any case. */
function canonicalAddress(email: string): string {
  return String(email).trim().toLowerCase();
}

function subject(userId: number): string {
  return userId == null ? "" : String(userId);
}

@Injectable()
export class AuthEmailVerificationCodeService {
  private readonly redis: RedisWithEmailVerificationCode;

  constructor(
    @Inject(forwardRef(() => RedisService))
    private readonly redisService: RedisService
  ) {
    this.redis = this.redisService.getClient() as RedisWithEmailVerificationCode;
    this.redis.defineCommand("useEmailVerificationCode", {
      numberOfKeys: 2,
      lua: fs.readFileSync(join(__dirname, "scripts", "email-verification-code.lua"), "utf-8")
    });
  }

  /**
   * A new code for a purpose and an address, and for changing or resetting, the account it is for. Returns null if
   * a code was sent to the address less than a minute ago.
   */
  async generate(type: EmailVerificationCodeType, email: string, userId?: number): Promise<string> {
    const address = canonicalAddress(email);
    // If rate limit key already exists it will fail
    if (
      !(await this.redis.set(REDIS_KEY_EMAIL_VERIFICATION_CODE_RATE_LIMIT.format(address), "1", "EX", RATE_LIMIT, "NX"))
    ) {
      return null;
    }

    const code = String(randomInt(1000000)).padStart(6, "0");
    const key = REDIS_KEY_EMAIL_VERIFICATION_CHALLENGE.format(type, address);
    await this.redis
      .multi()
      .del(key)
      .hset(key, { code, subject: subject(userId), failures: "0" })
      .expire(key, CODE_VALID_TIME)
      .exec();

    return code;
  }

  /** Checks a code for a purpose, an address and the account, using it up if it is right. */
  async consume(
    type: EmailVerificationCodeType,
    email: string,
    code: string,
    userId?: number
  ): Promise<EmailVerificationCodeCheck> {
    const address = canonicalAddress(email);
    const result = await this.redis.useEmailVerificationCode(
      REDIS_KEY_EMAIL_VERIFICATION_CHALLENGE.format(type, address),
      REDIS_KEY_EMAIL_VERIFICATION_FAILURES.format(type, address),
      typeof code === "string" ? code : "",
      subject(userId),
      CODE_MAX_FAILURES,
      ADDRESS_MAX_FAILURES,
      ADDRESS_FAILURE_WINDOW
    );
    return result === "OK" ? "used" : result === "LIMITED" ? "limited" : "wrong";
  }
}
