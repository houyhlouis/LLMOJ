import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, EntityManager } from "typeorm";

import { SettingsEntity } from "./settings.entity";

import { UserEntity } from "../user/user.entity";
import { AuditLogEntity } from "../audit/audit-log.entity";

/**
 * Site-wide limits on calls to AI providers. Every limit applies to the account whose AI configuration (and so
 * whose provider key) a call uses. 0 means no limit, except for the number of simultaneous requests.
 */
export interface AiPolicy {
  /** No provider request starts; queued jobs wait and running jobs return to the queue. */
  paused: boolean;
  /** Provider-reported input and output tokens per account in any 24 hours, with unconfirmed calls held. */
  userDailyTokens: number;
  /** Billable model and search requests per account in any 24 hours. */
  userDailyRequests: number;
  /** Billable requests one job may make in total. */
  jobRequests: number;
  /** Provider requests running at the same time in one backend process. */
  concurrentRequests: number;
}

export const DEFAULT_AI_POLICY: Readonly<AiPolicy> = Object.freeze({
  paused: false,
  userDailyTokens: 0,
  userDailyRequests: 0,
  jobRequests: 500,
  concurrentRequests: 16
});

export const AI_POLICY_LIMITS: Readonly<Record<Exclude<keyof AiPolicy, "paused">, readonly [number, number]>> =
  Object.freeze({
    userDailyTokens: [0, 1e12],
    userDailyRequests: [0, 1e7],
    jobRequests: [0, 100000],
    concurrentRequests: [1, 256]
  });

const POLICY_KEY = "ai-policy";

/** Returns the policy, or null when a value is missing or out of range. */
export function parseAiPolicy(value: unknown): AiPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.paused !== "boolean") return null;
  const result: AiPolicy = { ...DEFAULT_AI_POLICY, paused: input.paused };
  for (const [key, [min, max]] of Object.entries(AI_POLICY_LIMITS)) {
    const number = input[key];
    if (!Number.isSafeInteger(number) || (number as number) < min || (number as number) > max) return null;
    (result as unknown as Record<string, number>)[key] = number as number;
  }
  return result;
}

@Injectable()
export class AiPolicyService {
  constructor(@InjectDataSource() private readonly connection: DataSource) {}

  private async row(manager: EntityManager, lock?: "pessimistic_write") {
    return await manager.findOne(SettingsEntity, {
      where: { key: POLICY_KEY },
      ...(lock ? { lock: { mode: lock } } : {})
    });
  }

  /** A damaged stored policy pauses AI rather than silently lifting its limits. */
  private policy(row: SettingsEntity | null): AiPolicy {
    if (!row) return { ...DEFAULT_AI_POLICY };
    return parseAiPolicy(row.value) || { ...DEFAULT_AI_POLICY, paused: true };
  }

  async get(manager: EntityManager = this.connection.manager): Promise<AiPolicy> {
    return this.policy(await this.row(manager));
  }

  private async requireAdministrator(actor: UserEntity, manager: EntityManager) {
    if (!actor) throw new ForbiddenException();
    const current = await manager.findOne(UserEntity, { where: { id: actor.id }, lock: { mode: "pessimistic_read" } });
    if (!current?.isAdmin) throw new ForbiddenException();
    return current;
  }

  async getForAdministrator(actor: UserEntity): Promise<AiPolicy> {
    return await this.connection.transaction("READ COMMITTED", async manager => {
      await this.requireAdministrator(actor, manager);
      return await this.get(manager);
    });
  }

  async update(actor: UserEntity, value: AiPolicy, ip: string): Promise<AiPolicy> {
    const next = parseAiPolicy(value);
    if (!next) throw new BadRequestException("Invalid AI policy");
    return await this.connection.transaction("READ COMMITTED", async manager => {
      const administrator = await this.requireAdministrator(actor, manager);
      await manager
        .createQueryBuilder()
        .insert()
        .into(SettingsEntity)
        .values({ key: POLICY_KEY, value: { ...DEFAULT_AI_POLICY } })
        .orIgnore()
        .execute();
      const row = await this.row(manager, "pessimistic_write");
      const previous = this.policy(row);
      row.value = next;
      await manager.save(row);
      await manager.save(AuditLogEntity, {
        userId: administrator.id,
        ip: ip || "127.0.0.1",
        time: new Date(),
        action: "site.ai_policy.update",
        details: { old: previous, new: next }
      });
      return next;
    });
  }
}
