import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, EntityManager } from "typeorm";

import { SettingsEntity } from "./settings.entity";

import { UserEntity } from "../user/user.entity";
import { AuditLogEntity } from "../audit/audit-log.entity";

/**
 * How judge machines choose their next task, beyond the order of the queue's classes (live contests, practice,
 * rejudges, hacks and self-evaluation, AI).
 */
export interface JudgePolicy {
  /**
   * While a contest is running, each judge machine keeps this many of its task threads for submissions to running
   * contests. A judge machine needs more threads than this to keep any. 0 keeps none.
   */
  contestReservedThreads: number;
  /** Every fifth task goes to the job that has waited longest, once it has waited this long. 0 turns this off. */
  agingMinutes: number;
}

export const DEFAULT_JUDGE_POLICY: Readonly<JudgePolicy> = Object.freeze({
  contestReservedThreads: 0,
  agingMinutes: 30
});

export const JUDGE_POLICY_LIMITS: Readonly<Record<keyof JudgePolicy, readonly [number, number]>> = Object.freeze({
  contestReservedThreads: [0, 64],
  agingMinutes: [0, 10080]
});

const POLICY_KEY = "judge-policy";

// Judge threads read the policy for every task they ask for; other backend processes see a change this soon.
const CACHE_MILLISECONDS = 5000;

/** Returns the policy, or null when a value is missing or out of range. */
export function parseJudgePolicy(value: unknown): JudgePolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const result = { ...DEFAULT_JUDGE_POLICY };
  for (const [key, [min, max]] of Object.entries(JUDGE_POLICY_LIMITS)) {
    const number = input[key];
    if (!Number.isSafeInteger(number) || (number as number) < min || (number as number) > max) return null;
    (result as Record<string, number>)[key] = number as number;
  }
  return result;
}

@Injectable()
export class JudgePolicyService {
  private cached: { policy: JudgePolicy; until: number } = null;

  constructor(@InjectDataSource() private readonly connection: DataSource) {}

  private async row(manager: EntityManager, lock?: "pessimistic_write") {
    return await manager.findOne(SettingsEntity, {
      where: { key: POLICY_KEY },
      ...(lock ? { lock: { mode: lock } } : {})
    });
  }

  // A damaged stored policy falls back to the defaults: scheduling then works as without one.
  private policy(row: SettingsEntity | null): JudgePolicy {
    return (row && parseJudgePolicy(row.value)) || { ...DEFAULT_JUDGE_POLICY };
  }

  async get(manager: EntityManager = this.connection.manager): Promise<JudgePolicy> {
    return this.policy(await this.row(manager));
  }

  /** The policy as of at most a few seconds ago, for the judge queue. */
  async current(): Promise<JudgePolicy> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.policy;
    const policy = await this.get();
    this.cached = { policy, until: Date.now() + CACHE_MILLISECONDS };
    return policy;
  }

  private async requireAdministrator(actor: UserEntity, manager: EntityManager) {
    if (!actor) throw new ForbiddenException();
    const current = await manager.findOne(UserEntity, { where: { id: actor.id }, lock: { mode: "pessimistic_read" } });
    if (!current?.isAdmin) throw new ForbiddenException();
    return current;
  }

  async getForAdministrator(actor: UserEntity): Promise<JudgePolicy> {
    return await this.connection.transaction("READ COMMITTED", async manager => {
      await this.requireAdministrator(actor, manager);
      return await this.get(manager);
    });
  }

  async update(actor: UserEntity, value: JudgePolicy, ip: string): Promise<JudgePolicy> {
    const next = parseJudgePolicy(value);
    if (!next) throw new BadRequestException("Invalid judging policy");
    const saved = await this.connection.transaction("READ COMMITTED", async manager => {
      const administrator = await this.requireAdministrator(actor, manager);
      await manager
        .createQueryBuilder()
        .insert()
        .into(SettingsEntity)
        .values({ key: POLICY_KEY, value: { ...DEFAULT_JUDGE_POLICY } })
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
        action: "site.judge_policy.update",
        details: { old: previous, new: next }
      });
      return next;
    });
    this.cached = null;
    return saved;
  }
}
