import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, EntityManager } from "typeorm";

import { SettingsEntity } from "./settings.entity";

import { ConfigService } from "../config/config.service";
import { UserEntity } from "../user/user.entity";
import { AuditLogEntity } from "../audit/audit-log.entity";

export const REGISTRATION_MODES = ["open", "approval", "closed"] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

export interface RegistrationPolicySnapshot {
  registrationMode: RegistrationMode;
  configuredRegistrationMode: RegistrationMode;
  usesOverride: boolean;
}

const POLICY_KEY = "registration-policy";

@Injectable()
export class RegistrationSettingsService {
  constructor(
    @InjectDataSource() private readonly connection: DataSource,
    private readonly configService: ConfigService
  ) {}

  private async policyRow(
    manager: EntityManager,
    lock?: "pessimistic_read" | "pessimistic_write"
  ): Promise<SettingsEntity | null> {
    const options = { where: { key: POLICY_KEY }, ...(lock ? { lock: { mode: lock } } : {}) };
    const row = await manager.findOne(SettingsEntity, options);
    if (row || !lock) return row;
    // Keep a stable lock row even after restoring YAML. INSERT IGNORE must never
    // replace a concurrent administrator's override with the fallback marker.
    await manager
      .createQueryBuilder()
      .insert()
      .into(SettingsEntity)
      .values({ key: POLICY_KEY, value: { registrationMode: null } })
      .orIgnore()
      .execute();
    return await manager.findOne(SettingsEntity, options);
  }

  private snapshot(row: SettingsEntity | null): RegistrationPolicySnapshot {
    const configuredRegistrationMode = this.configService.config.preference.security.registrationMode || "open";
    const value = row?.value as { registrationMode?: unknown } | null;
    const mode = row ? value?.registrationMode : null;
    if (row && (mode === undefined || (mode !== null && !REGISTRATION_MODES.includes(mode as RegistrationMode))))
      throw new Error("Invalid stored registration policy; restore a valid mode before allowing registration.");
    return {
      registrationMode: (mode as RegistrationMode | null) ?? configuredRegistrationMode,
      configuredRegistrationMode,
      usesOverride: mode !== null
    };
  }

  async getSettings(): Promise<RegistrationPolicySnapshot> {
    return this.snapshot(await this.policyRow(this.connection.manager));
  }

  async getRegistrationMode(): Promise<RegistrationMode> {
    return (await this.getSettings()).registrationMode;
  }

  async lockRegistrationMode(manager: EntityManager): Promise<RegistrationMode> {
    return this.snapshot(await this.policyRow(manager, "pessimistic_read")).registrationMode;
  }

  private async requireAdministrator(actor: UserEntity, manager: EntityManager): Promise<UserEntity> {
    if (!actor) throw new ForbiddenException();
    const current = await manager.findOne(UserEntity, {
      where: { id: actor.id },
      lock: { mode: "pessimistic_read" }
    });
    if (!current?.isAdmin) throw new ForbiddenException();
    return current;
  }

  async getForAdministrator(actor: UserEntity): Promise<RegistrationPolicySnapshot> {
    return await this.connection.transaction("READ COMMITTED", async manager => {
      await this.requireAdministrator(actor, manager);
      return this.snapshot(await this.policyRow(manager));
    });
  }

  async updateRegistrationMode(
    actor: UserEntity,
    registrationMode: RegistrationMode | null,
    ip: string
  ): Promise<RegistrationPolicySnapshot> {
    if (registrationMode !== null && !REGISTRATION_MODES.includes(registrationMode))
      throw new BadRequestException("Invalid registration mode");
    return await this.connection.transaction("READ COMMITTED", async manager => {
      const administrator = await this.requireAdministrator(actor, manager);
      const row = await this.policyRow(manager, "pessimistic_write");
      const previous = this.snapshot(row);
      row.value = { registrationMode };
      await manager.save(row);
      const next = this.snapshot(row);
      await manager.save(AuditLogEntity, {
        userId: administrator.id,
        ip: ip || "127.0.0.1",
        time: new Date(),
        action: "site.registration_mode.update",
        details: {
          old: { ...previous, source: previous.usesOverride ? "database" : "configuration" },
          new: { ...next, source: next.usesOverride ? "database" : "configuration" }
        }
      });
      return next;
    });
  }
}
