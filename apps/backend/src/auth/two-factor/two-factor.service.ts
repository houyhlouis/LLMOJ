import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

import { Injectable } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";

import { DataSource, IsNull, Not, Repository } from "typeorm";
import { Redis } from "ioredis";

import { UserTwoFactorEntity } from "./user-two-factor.entity";
import { UserPasskeyEntity } from "./user-passkey.entity";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  totpUri,
  verifyTotp
} from "./totp";
import {
  base64url,
  CeremonyExpectation,
  fromBase64url,
  relyingPartyForOrigin,
  verifyAssertion,
  verifyRegistration,
  WEBAUTHN_ALGORITHMS,
  WebAuthnError
} from "./webauthn";

import { UserEntity } from "../../user/user.entity";
import { RedisService } from "../../redis/redis.service";
import { LockService } from "../../redis/lock.service";
import { ConfigService } from "../../config/config.service";
import { loadServiceKey } from "../../common/service-key";

export enum TwoFactorError {
  ALREADY_ENABLED = "ALREADY_ENABLED",
  NOT_ENABLED = "NOT_ENABLED",
  SETUP_EXPIRED = "SETUP_EXPIRED",
  INVALID_CODE = "INVALID_CODE",
  INVALID_PASSKEY = "INVALID_PASSKEY",
  PASSKEY_UNAVAILABLE = "PASSKEY_UNAVAILABLE",
  TOO_MANY_PASSKEYS = "TOO_MANY_PASSKEYS",
  NO_SUCH_PASSKEY = "NO_SUCH_PASSKEY",
  CHALLENGE_EXPIRED = "CHALLENGE_EXPIRED",
  TOO_MANY_ATTEMPTS = "TOO_MANY_ATTEMPTS"
}

export type TwoFactorMethod = "totp" | "passkey" | "recoveryCode";

/** One second factor: an authenticator code, a recovery code, or a passkey assertion. */
export interface TwoFactorProof {
  totpCode?: string;
  recoveryCode?: string;
  passkey?: PasskeyAssertion;
}

export interface PasskeyAssertion {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

export interface PasskeyRegistration {
  id: string;
  clientDataJSON: string;
  attestationObject: string;
  transports?: string[];
}

export type PasskeyRequestOptions = {
  challenge: string;
  rpId: string;
  allowCredentials: { type: "public-key"; id: string; transports: string[] }[];
  userVerification: "preferred";
  timeout: number;
};

export interface TwoFactorChallenge {
  token: string;
  methods: TwoFactorMethod[];
  passkey?: PasskeyRequestOptions;
}

export interface TwoFactorStatus {
  enabled: boolean;
  totp: boolean;
  totpEnabledAt: Date;
  recoveryCodesRemaining: number;
  passkeys: { id: number; name: string; createdAt: Date; lastUsedAt: Date; rpId: string }[];
}

// Either an error, or the result fields.
type Result<T> = { error?: TwoFactorError } & Partial<T>;

const MAX_PASSKEYS = 10;
const SETUP_TTL_SECONDS = 10 * 60;
const CEREMONY_TIMEOUT_SECONDS = 5 * 60;
const MAX_CHALLENGE_ATTEMPTS = 5;
// Failed second factors per user, across challenges, before refusing further attempts for the window.
const MAX_USER_FAILURES = 10;
const USER_FAILURE_WINDOW_SECONDS = 15 * 60;

const REDIS_KEY_TOTP_SETUP = "two-factor:totp-setup:%d";
const REDIS_KEY_PASSKEY_REGISTRATION = "two-factor:passkey-registration:%d";
const REDIS_KEY_CHALLENGE = "two-factor:challenge:%s";
const REDIS_KEY_FAILURES = "two-factor:failures:%d";
const REDIS_KEY_TOTP_USED_STEP = "two-factor:totp-used:%d:%s:%d";

@Injectable()
export class TwoFactorService {
  private readonly redis: Redis;

  private keyPromise: Promise<Buffer>;

  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    @InjectRepository(UserTwoFactorEntity)
    private readonly settingsRepository: Repository<UserTwoFactorEntity>,
    @InjectRepository(UserPasskeyEntity)
    private readonly passkeyRepository: Repository<UserPasskeyEntity>,
    private readonly redisService: RedisService,
    private readonly lockService: LockService,
    private readonly configService: ConfigService
  ) {
    this.redis = this.redisService.getClient();
  }

  /** Authenticator secrets are encrypted with a key in the backend's private state directory. */
  private async encryptionKey(): Promise<Buffer> {
    if (!this.keyPromise)
      this.keyPromise = (async () => {
        const enrolled = await this.settingsRepository.countBy({ totpSecret: Not(IsNull()) });
        return await loadServiceKey(
          process.env.HYHOJ_AI_STATE_DIR || "/opt/LLMOJ/data/ai",
          "two-factor.key",
          "Two-factor encryption key",
          enrolled > 0
        );
      })().catch(error => {
        this.keyPromise = null;
        throw error;
      });
    return await this.keyPromise;
  }

  private async encryptSecret(userId: number, secret: Buffer): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", await this.encryptionKey(), iv);
    cipher.setAAD(Buffer.from(`user_two_factor:${userId}`));
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
    return ["v1", iv, cipher.getAuthTag(), ciphertext]
      .map(part => (typeof part === "string" ? part : base64url(part)))
      .join(".");
  }

  private async decryptSecret(userId: number, value: string): Promise<Buffer> {
    const [version, ...parts] = value.split(".");
    if (version !== "v1" || parts.length !== 3) throw new Error("Unsupported two-factor secret format");
    const [iv, tag, ciphertext] = parts.map(part => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", await this.encryptionKey(), iv);
    decipher.setAAD(Buffer.from(`user_two_factor:${userId}`));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  private async lockUser<T>(userId: number, callback: () => Promise<T>): Promise<T> {
    return await this.lockService.lock(`TwoFactor_${userId}`, callback);
  }

  async getStatus(userId: number): Promise<TwoFactorStatus> {
    const [settings, passkeys] = await Promise.all([
      this.settingsRepository.findOneBy({ userId }),
      this.passkeyRepository.find({ where: { userId }, order: { id: "ASC" } })
    ]);
    const enabled = !!settings?.totpSecret || passkeys.length > 0;
    return {
      enabled,
      totp: !!settings?.totpSecret,
      totpEnabledAt: settings?.totpSecret ? settings.totpEnabledAt : null,
      recoveryCodesRemaining: enabled ? (settings?.recoveryCodes?.length ?? 0) : 0,
      passkeys: passkeys.map(({ id, name, createdAt, lastUsedAt, rpId }) => ({ id, name, createdAt, lastUsedAt, rpId }))
    };
  }

  async isEnabled(userId: number): Promise<boolean> {
    const [settings, passkeyCount] = await Promise.all([
      this.settingsRepository.findOneBy({ userId }),
      this.passkeyRepository.countBy({ userId })
    ]);
    return !!settings?.totpSecret || passkeyCount > 0;
  }

  /**
   * Saves second-factor changes. Recovery codes are created with the first factor (and returned once) and
   * removed with the last one.
   */
  private async saveSettings(
    userId: number,
    change: (settings: UserTwoFactorEntity) => void,
    passkeyDelta = 0
  ): Promise<string[] | null> {
    const settings =
      (await this.settingsRepository.findOneBy({ userId })) ??
      Object.assign(new UserTwoFactorEntity(), { userId, totpSecret: null, totpEnabledAt: null, recoveryCodes: null });
    const passkeyCount = (await this.passkeyRepository.countBy({ userId })) + passkeyDelta;
    change(settings);
    let recoveryCodes: string[] = null;
    if (!settings.totpSecret && passkeyCount <= 0) settings.recoveryCodes = null;
    else if (!settings.recoveryCodes) {
      recoveryCodes = generateRecoveryCodes();
      settings.recoveryCodes = recoveryCodes.map(hashRecoveryCode);
    }
    settings.updatedAt = new Date();
    await this.settingsRepository.save(settings);
    return recoveryCodes;
  }

  async beginTotpSetup(user: UserEntity): Promise<Result<{ secret: string; uri: string }>> {
    const settings = await this.settingsRepository.findOneBy({ userId: user.id });
    if (settings?.totpSecret) return { error: TwoFactorError.ALREADY_ENABLED };
    const secret = generateTotpSecret();
    await this.redis.set(REDIS_KEY_TOTP_SETUP.format(user.id), base32Encode(secret), "EX", SETUP_TTL_SECONDS);
    return {
      secret: base32Encode(secret),
      uri: totpUri(secret, this.configService.config.preference.siteName, user.username)
    };
  }

  /** Enables the authenticator once the user proves it produces valid codes. */
  async confirmTotpSetup(user: UserEntity, code: string): Promise<Result<{ recoveryCodes: string[] }>> {
    const pending = await this.redis.get(REDIS_KEY_TOTP_SETUP.format(user.id));
    if (!pending) return { error: TwoFactorError.SETUP_EXPIRED };
    const secret = base32Decode(pending);
    const step = verifyTotp(secret, code);
    if (step == null || !(await this.consumeTotpStep(user.id, secret, step)))
      return { error: TwoFactorError.INVALID_CODE };
    const encrypted = await this.encryptSecret(user.id, secret);
    return await this.lockUser(user.id, async () => {
      if ((await this.settingsRepository.findOneBy({ userId: user.id }))?.totpSecret)
        return { error: TwoFactorError.ALREADY_ENABLED };
      const recoveryCodes = await this.saveSettings(user.id, settings => {
        settings.totpSecret = encrypted;
        settings.totpEnabledAt = new Date();
      });
      await this.redis.del(REDIS_KEY_TOTP_SETUP.format(user.id));
      return { recoveryCodes };
    });
  }

  async disableTotp(userId: number): Promise<Result<unknown>> {
    return await this.lockUser(userId, async () => {
      if (!(await this.settingsRepository.findOneBy({ userId }))?.totpSecret)
        return { error: TwoFactorError.NOT_ENABLED };
      await this.saveSettings(userId, settings => {
        settings.totpSecret = null;
        settings.totpEnabledAt = null;
      });
      return {};
    });
  }

  async regenerateRecoveryCodes(userId: number): Promise<Result<{ recoveryCodes: string[] }>> {
    return await this.lockUser(userId, async () => {
      if (!(await this.isEnabled(userId))) return { error: TwoFactorError.NOT_ENABLED };
      const recoveryCodes = await this.saveSettings(userId, settings => {
        settings.recoveryCodes = null;
      });
      return { recoveryCodes };
    });
  }

  /** Removes every second factor, e.g. by an administrator for a user who lost them. */
  async reset(userId: number): Promise<void> {
    await this.lockUser(userId, async () => {
      await this.connection.transaction("READ COMMITTED", async manager => {
        await manager.delete(UserPasskeyEntity, { userId });
        await manager.delete(UserTwoFactorEntity, { userId });
      });
    });
  }

  private static webAuthnUserId(userId: number): string {
    return base64url(createHash("sha256").update(`llmoj-webauthn-user:${userId}`).digest().subarray(0, 16));
  }

  private static passkeyDescriptor(passkey: UserPasskeyEntity) {
    return {
      type: "public-key" as const,
      id: passkey.credentialId,
      transports: passkey.transports ? passkey.transports.split(",") : []
    };
  }

  /** Options for navigator.credentials.create(), bound to the site the user is on. */
  async beginPasskeyRegistration(user: UserEntity, origin: unknown): Promise<Result<{ options: unknown }>> {
    const relyingParty = relyingPartyForOrigin(origin);
    if (!relyingParty) return { error: TwoFactorError.PASSKEY_UNAVAILABLE };
    const existing = await this.passkeyRepository.findBy({ userId: user.id });
    if (existing.length >= MAX_PASSKEYS) return { error: TwoFactorError.TOO_MANY_PASSKEYS };
    const challenge = base64url(randomBytes(32));
    const ceremony: CeremonyExpectation = { challenge, ...relyingParty };
    await this.redis.set(
      REDIS_KEY_PASSKEY_REGISTRATION.format(user.id),
      JSON.stringify(ceremony),
      "EX",
      CEREMONY_TIMEOUT_SECONDS
    );
    return {
      options: {
        rp: { id: relyingParty.rpId, name: this.configService.config.preference.siteName },
        user: {
          id: TwoFactorService.webAuthnUserId(user.id),
          name: user.username,
          displayName: user.nickname || user.username
        },
        challenge,
        pubKeyCredParams: Object.values(WEBAUTHN_ALGORITHMS).map(alg => ({ type: "public-key", alg })),
        timeout: CEREMONY_TIMEOUT_SECONDS * 1000,
        excludeCredentials: existing
          .filter(passkey => passkey.rpId === relyingParty.rpId)
          .map(TwoFactorService.passkeyDescriptor),
        authenticatorSelection: { residentKey: "discouraged", userVerification: "preferred" },
        attestation: "none"
      }
    };
  }

  async finishPasskeyRegistration(
    user: UserEntity,
    origin: unknown,
    name: string,
    credential: PasskeyRegistration
  ): Promise<Result<{ recoveryCodes: string[] }>> {
    const pending = await this.redis.getdel(REDIS_KEY_PASSKEY_REGISTRATION.format(user.id));
    if (!pending) return { error: TwoFactorError.SETUP_EXPIRED };
    const ceremony: CeremonyExpectation = JSON.parse(pending);
    if (relyingPartyForOrigin(origin)?.origin !== ceremony.origin) return { error: TwoFactorError.INVALID_PASSKEY };
    let registered: ReturnType<typeof verifyRegistration>;
    try {
      registered = verifyRegistration(
        {
          clientDataJSON: fromBase64url(credential.clientDataJSON),
          attestationObject: fromBase64url(credential.attestationObject)
        },
        ceremony
      );
    } catch (error) {
      if (error instanceof WebAuthnError) return { error: TwoFactorError.INVALID_PASSKEY };
      throw error;
    }
    const credentialId = base64url(registered.id);
    if (credential.id !== credentialId) return { error: TwoFactorError.INVALID_PASSKEY };
    const credentialIdHash = createHash("sha256").update(registered.id).digest("hex");
    return await this.lockUser(user.id, async () => {
      if ((await this.passkeyRepository.countBy({ userId: user.id })) >= MAX_PASSKEYS)
        return { error: TwoFactorError.TOO_MANY_PASSKEYS };
      if (await this.passkeyRepository.countBy({ credentialIdHash })) return { error: TwoFactorError.INVALID_PASSKEY };
      const passkey = new UserPasskeyEntity();
      Object.assign(passkey, {
        userId: user.id,
        credentialIdHash,
        credentialId,
        publicKey: base64url(registered.publicKey),
        algorithm: registered.algorithm,
        signCount: registered.signCount,
        rpId: ceremony.rpId,
        transports: (credential.transports || [])
          .filter(transport => /^[a-z-]{1,20}$/.test(transport))
          .slice(0, 5)
          .join(","),
        name,
        createdAt: new Date(),
        lastUsedAt: null
      });
      await this.passkeyRepository.save(passkey);
      const recoveryCodes = await this.saveSettings(user.id, () => undefined);
      return { recoveryCodes };
    });
  }

  async removePasskey(userId: number, passkeyId: number): Promise<Result<unknown>> {
    return await this.lockUser(userId, async () => {
      const passkey = await this.passkeyRepository.findOneBy({ id: passkeyId, userId });
      if (!passkey) return { error: TwoFactorError.NO_SUCH_PASSKEY };
      await this.passkeyRepository.delete({ id: passkey.id });
      await this.saveSettings(userId, () => undefined);
      return {};
    });
  }

  /**
   * Starts a second-factor check for a user who already proved their password (sign-in or re-authentication).
   * The returned token is single-use and expires after a few minutes.
   */
  async createChallenge(userId: number, origin: unknown): Promise<TwoFactorChallenge> {
    const [settings, passkeys] = await Promise.all([
      this.settingsRepository.findOneBy({ userId }),
      this.passkeyRepository.findBy({ userId })
    ]);
    const relyingParty = relyingPartyForOrigin(origin);
    const usable = relyingParty ? passkeys.filter(passkey => passkey.rpId === relyingParty.rpId) : [];
    const methods: TwoFactorMethod[] = [
      ...(settings?.totpSecret ? (["totp"] as const) : []),
      ...(usable.length ? (["passkey"] as const) : []),
      ...(settings?.recoveryCodes?.length ? (["recoveryCode"] as const) : [])
    ];
    const token = base64url(randomBytes(32));
    const ceremony: CeremonyExpectation = relyingParty && { challenge: base64url(randomBytes(32)), ...relyingParty };
    const key = REDIS_KEY_CHALLENGE.format(token);
    await this.redis
      .multi()
      .hset(key, { userId: String(userId), attempts: "0", ceremony: JSON.stringify(ceremony) })
      .expire(key, CEREMONY_TIMEOUT_SECONDS)
      .exec();
    return {
      token,
      methods,
      ...(usable.length
        ? {
            passkey: {
              challenge: ceremony.challenge,
              rpId: ceremony.rpId,
              allowCredentials: usable.map(TwoFactorService.passkeyDescriptor),
              userVerification: "preferred",
              timeout: CEREMONY_TIMEOUT_SECONDS * 1000
            }
          }
        : {})
    };
  }

  /**
   * Checks the second factor for a challenge. Returns the user it belongs to; a challenge is consumed by its
   * first success and by too many failures.
   */
  async verifyChallenge(token: string, origin: unknown, proof: TwoFactorProof): Promise<Result<{ userId: number }>> {
    if (typeof token !== "string" || token.length > 100) return { error: TwoFactorError.CHALLENGE_EXPIRED };
    const key = REDIS_KEY_CHALLENGE.format(token);
    const challenge = await this.redis.hgetall(key);
    if (!challenge?.userId) return { error: TwoFactorError.CHALLENGE_EXPIRED };
    const userId = Number(challenge.userId);
    if ((await this.redis.hincrby(key, "attempts", 1)) > MAX_CHALLENGE_ATTEMPTS) {
      await this.redis.del(key);
      return { error: TwoFactorError.TOO_MANY_ATTEMPTS };
    }
    const ceremony: CeremonyExpectation = JSON.parse(challenge.ceremony || "null");
    // The browser reports the origin; a challenge is only valid where it was issued.
    if (proof.passkey && (!ceremony || relyingPartyForOrigin(origin)?.origin !== ceremony.origin))
      return { error: TwoFactorError.INVALID_PASSKEY };
    const result = await this.verifyProof(userId, proof, ceremony);
    if (result.error) return result;
    if ((await this.redis.del(key)) !== 1) return { error: TwoFactorError.CHALLENGE_EXPIRED };
    return { userId };
  }

  /** Too many failed second factors (or re-authentication passwords) for this user recently. */
  async failureLimitReached(userId: number): Promise<boolean> {
    return Number(await this.redis.get(REDIS_KEY_FAILURES.format(userId))) >= MAX_USER_FAILURES;
  }

  async recordFailure(userId: number): Promise<void> {
    const failuresKey = REDIS_KEY_FAILURES.format(userId);
    if ((await this.redis.incr(failuresKey)) === 1) await this.redis.expire(failuresKey, USER_FAILURE_WINDOW_SECONDS);
  }

  private async verifyProof(
    userId: number,
    proof: TwoFactorProof,
    ceremony: CeremonyExpectation
  ): Promise<Result<unknown>> {
    if (await this.failureLimitReached(userId)) return { error: TwoFactorError.TOO_MANY_ATTEMPTS };
    let verified = false;
    if (proof.totpCode) verified = await this.verifyTotpCode(userId, proof.totpCode);
    else if (proof.recoveryCode) verified = await this.useRecoveryCode(userId, proof.recoveryCode);
    else if (proof.passkey && ceremony) verified = await this.verifyPasskey(userId, proof.passkey, ceremony);
    if (verified) return {};
    await this.recordFailure(userId);
    return { error: proof.passkey ? TwoFactorError.INVALID_PASSKEY : TwoFactorError.INVALID_CODE };
  }

  /**
   * A code is accepted once: replaying it, even within its validity window, fails. Scoped to the secret, so a new
   * authenticator set up right after removing the old one accepts its first code.
   */
  private async consumeTotpStep(userId: number, secret: Buffer, step: number): Promise<boolean> {
    const secretId = createHash("sha256").update(secret).digest("hex").slice(0, 16);
    return (
      (await this.redis.set(REDIS_KEY_TOTP_USED_STEP.format(userId, secretId, step), "1", "EX", 120, "NX")) === "OK"
    );
  }

  private async verifyTotpCode(userId: number, code: string): Promise<boolean> {
    const settings = await this.settingsRepository.findOneBy({ userId });
    if (!settings?.totpSecret) return false;
    const secret = await this.decryptSecret(userId, settings.totpSecret);
    const step = verifyTotp(secret, code);
    return step != null && (await this.consumeTotpStep(userId, secret, step));
  }

  private async useRecoveryCode(userId: number, code: string): Promise<boolean> {
    const hash = hashRecoveryCode(code);
    if (!hash) return false;
    return await this.lockUser(userId, async () => {
      const settings = await this.settingsRepository.findOneBy({ userId });
      const index = settings?.recoveryCodes?.indexOf(hash) ?? -1;
      if (index < 0) return false;
      settings.recoveryCodes = settings.recoveryCodes.filter((_, i) => i !== index);
      settings.updatedAt = new Date();
      await this.settingsRepository.save(settings);
      return true;
    });
  }

  private async verifyPasskey(
    userId: number,
    assertion: PasskeyAssertion,
    ceremony: CeremonyExpectation
  ): Promise<boolean> {
    try {
      const credentialIdHash = createHash("sha256").update(fromBase64url(assertion.id, 1023)).digest("hex");
      return await this.lockUser(userId, async () => {
        const passkey = await this.passkeyRepository.findOneBy({ userId, credentialIdHash });
        if (!passkey || passkey.rpId !== ceremony.rpId) return false;
        const { signCount } = verifyAssertion(
          {
            clientDataJSON: fromBase64url(assertion.clientDataJSON),
            authenticatorData: fromBase64url(assertion.authenticatorData),
            signature: fromBase64url(assertion.signature)
          },
          ceremony,
          { publicKey: fromBase64url(passkey.publicKey), signCount: passkey.signCount }
        );
        await this.passkeyRepository.update({ id: passkey.id }, { signCount, lastUsedAt: new Date() });
        return true;
      });
    } catch (error) {
      if (error instanceof WebAuthnError) return false;
      throw error;
    }
  }
}
