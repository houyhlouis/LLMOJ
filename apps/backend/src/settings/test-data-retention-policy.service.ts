import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, EntityManager } from "typeorm";

import { SettingsEntity } from "./settings.entity";

import { UserEntity } from "../user/user.entity";
import { AuditLogEntity } from "../audit/audit-log.entity";

/**
 * How long test data removed from its problem stays, so that results judged with it can be judged again with the same
 * data. Data that waiting submissions, hacks or self-evaluations need, and data versions a problem manager chose to
 * keep, always stay. See `TestDataRetentionService`.
 */
export interface TestDataRetentionPolicy {
  /** Days after a contest ends that the test data its submissions were judged with stays. */
  contestDays: number;
  /**
   * Days that removed test data stays for the results judged with it: counted from its removal, or, for an earlier
   * result a rejudge kept, from that rejudge.
   */
  resultDays: number;
}

export const DEFAULT_TEST_DATA_RETENTION_POLICY: Readonly<TestDataRetentionPolicy> = Object.freeze({
  contestDays: 30,
  resultDays: 7
});

export const TEST_DATA_RETENTION_LIMITS: Readonly<Record<keyof TestDataRetentionPolicy, readonly [number, number]>> =
  Object.freeze({
    contestDays: [0, 3650],
    resultDays: [0, 3650]
  });

const POLICY_KEY = "test-data-retention";

/** Returns the policy, or null when a value is missing or out of range. */
export function parseTestDataRetentionPolicy(value: unknown): TestDataRetentionPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const result = { ...DEFAULT_TEST_DATA_RETENTION_POLICY };
  for (const [key, [min, max]] of Object.entries(TEST_DATA_RETENTION_LIMITS)) {
    const number = input[key];
    if (!Number.isSafeInteger(number) || (number as number) < min || (number as number) > max) return null;
    (result as Record<string, number>)[key] = number as number;
  }
  return result;
}

@Injectable()
export class TestDataRetentionPolicyService {
  constructor(@InjectDataSource() private readonly connection: DataSource) {}

  private async row(manager: EntityManager, lock?: "pessimistic_write") {
    return await manager.findOne(SettingsEntity, {
      where: { key: POLICY_KEY },
      ...(lock ? { lock: { mode: lock } } : {})
    });
  }

  // A damaged stored policy falls back to the defaults, which keep data rather than delete it early.
  private policy(row: SettingsEntity | null): TestDataRetentionPolicy {
    return (row && parseTestDataRetentionPolicy(row.value)) || { ...DEFAULT_TEST_DATA_RETENTION_POLICY };
  }

  async get(manager: EntityManager = this.connection.manager): Promise<TestDataRetentionPolicy> {
    return this.policy(await this.row(manager));
  }

  private async requireAdministrator(actor: UserEntity, manager: EntityManager): Promise<UserEntity> {
    if (!actor) throw new ForbiddenException();
    const current = await manager.findOne(UserEntity, { where: { id: actor.id }, lock: { mode: "pessimistic_read" } });
    if (!current?.isAdmin) throw new ForbiddenException();
    return current;
  }

  async getForAdministrator(actor: UserEntity): Promise<TestDataRetentionPolicy> {
    return await this.connection.transaction("READ COMMITTED", async manager => {
      await this.requireAdministrator(actor, manager);
      return await this.get(manager);
    });
  }

  async update(actor: UserEntity, value: TestDataRetentionPolicy, ip: string): Promise<TestDataRetentionPolicy> {
    const next = parseTestDataRetentionPolicy(value);
    if (!next) throw new BadRequestException("Invalid test data retention policy");
    return await this.connection.transaction("READ COMMITTED", async manager => {
      const administrator = await this.requireAdministrator(actor, manager);
      await manager
        .createQueryBuilder()
        .insert()
        .into(SettingsEntity)
        .values({ key: POLICY_KEY, value: { ...DEFAULT_TEST_DATA_RETENTION_POLICY } })
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
        action: "site.test_data_retention.update",
        details: { old: previous, new: next }
      });
      return next;
    });
  }
}
