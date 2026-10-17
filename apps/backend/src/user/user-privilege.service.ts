import { Injectable, Inject, forwardRef } from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";

import { Repository, DataSource, EntityManager } from "typeorm";

import { UserEntity } from "./user.entity";
import { UserPrivilegeEntity, UserPrivilegeType } from "./user-privilege.entity";
import { UserService } from "./user.service";

import { SetUserPrivilegesResponseError } from "./dto";

import { defaultUserPermissions, guestPermissions } from "../access/permission-catalog";
import { UserPermissionRuleEntity } from "../access/user-permission-rule.entity";
import { requestContext } from "../common/request-context";

export { UserPrivilegeType } from "./user-privilege.entity";

/** A user's explicit allow/deny rules and granted privileges. */
interface CapabilityRecords {
  rules: Map<string, boolean>;
  privileges: Set<string>;
}

const REQUEST_CAPABILITIES = Symbol("request capabilities");

interface RequestWithCapabilities {
  [REQUEST_CAPABILITIES]?: Map<number, Promise<CapabilityRecords>>;
  res?: { writableEnded?: boolean };
}

/**
 * The request whose checks may share one read of the rules. Work a request starts in the background (an AI job, for
 * example) inherits its context, and must see permission changes: once the response is sent, nothing is shared.
 */
function answeringRequest(): RequestWithCapabilities {
  const request = requestContext.getStore() as RequestWithCapabilities;
  return request && !request.res?.writableEnded ? request : null;
}

@Injectable()
export class UserPrivilegeService {
  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    @InjectRepository(UserPrivilegeEntity)
    private readonly userPrivilegeRepository: Repository<UserPrivilegeEntity>,
    @Inject(forwardRef(() => UserService))
    private readonly userService: UserService
  ) {}

  async permissionDecision(
    user: UserEntity,
    privilegeType: UserPrivilegeType,
    fallback: boolean,
    manager?: EntityManager
  ): Promise<boolean> {
    if (!user) {
      // Public test data followed the problem View ACL upstream. Preserve that contextual
      // fallback without granting guests access when the original object ACL denies it.
      return fallback && (guestPermissions.has(privilegeType) || privilegeType === UserPrivilegeType.ReadProblemData);
    }
    // Management of detailed permissions is always restricted to site administrators.
    if (privilegeType === UserPrivilegeType.ManagePermissions) return user.isAdmin;
    if (user.isAdmin) return true;
    const request = answeringRequest();
    if (!manager && request) {
      const { rules, privileges } = await this.requestCapabilities(request, user.id);
      if (rules.has(privilegeType)) return rules.get(privilegeType);
      return privileges.has(privilegeType) || fallback;
    }
    // Locking reads use the transaction's current database state, even when an
    // earlier snapshot exists, and keep an accepted grant stable through commit.
    const ruleMatch = { userId: user.id, permission: privilegeType };
    const rule = manager
      ? await manager.findOne(UserPermissionRuleEntity, { where: ruleMatch, lock: { mode: "pessimistic_read" } })
      : await this.connection.getRepository(UserPermissionRuleEntity).findOneBy(ruleMatch);
    if (rule) return rule.allowed;
    const privilegeMatch = { userId: user.id, privilegeType };
    if (
      manager
        ? await manager.findOne(UserPrivilegeEntity, { where: privilegeMatch, lock: { mode: "pessimistic_read" } })
        : await this.userPrivilegeRepository.countBy(privilegeMatch)
    )
      return true;
    return fallback;
  }

  /**
   * An HTTP request reads each user's rules and privileges once, and all of its checks share them: a page can check
   * dozens of capabilities. Requests that change them call `forgetRequestCapabilities`. Transactions (`manager`) and
   * work outside a request always read the current rows.
   */
  private requestCapabilities(request: RequestWithCapabilities, userId: number): Promise<CapabilityRecords> {
    if (!request[REQUEST_CAPABILITIES]) request[REQUEST_CAPABILITIES] = new Map();
    const cache = request[REQUEST_CAPABILITIES];
    let records = cache.get(userId);
    if (!records) {
      records = (async () => {
        const [rules, privileges] = await Promise.all([
          this.connection.getRepository(UserPermissionRuleEntity).findBy({ userId }),
          this.userPrivilegeRepository.findBy({ userId })
        ]);
        return {
          rules: new Map(rules.map(rule => [rule.permission, rule.allowed])),
          privileges: new Set<string>(privileges.map(privilege => privilege.privilegeType))
        };
      })();
      cache.set(userId, records);
      // A failed read isn't kept: a later check reads again.
      records.catch(() => cache.get(userId) === records && cache.delete(userId));
    }
    return records;
  }

  /** After changing a user's rules or privileges, the rest of the request sees the change. */
  forgetRequestCapabilities(userId: number): void {
    (requestContext.getStore() as RequestWithCapabilities)?.[REQUEST_CAPABILITIES]?.delete(userId);
  }

  async userHasPrivilege(
    user: UserEntity,
    privilegeType: UserPrivilegeType,
    manager?: EntityManager
  ): Promise<boolean> {
    return await this.permissionDecision(
      user,
      privilegeType,
      user ? defaultUserPermissions.has(privilegeType) : guestPermissions.has(privilegeType),
      manager
    );
  }

  async getUserPrivileges(userId: number): Promise<UserPrivilegeType[]> {
    const user = await this.userService.findUserById(userId);
    const result: UserPrivilegeType[] = [];
    for (const privilege of Object.values(UserPrivilegeType)) {
      // eslint-disable-next-line no-await-in-loop -- Privilege propagation depends on the preceding decision.
      if (await this.userHasPrivilege(user, privilege)) result.push(privilege);
    }
    return result;
  }

  async setUserPrivileges(
    userId: number,
    newPrivilegeTypes: UserPrivilegeType[]
  ): Promise<SetUserPrivilegesResponseError> {
    if (!(await this.userService.userExists(userId))) return SetUserPrivilegesResponseError.NO_SUCH_USER;

    const error = await this.connection.transaction("READ COMMITTED", async transactionalEntityManager => {
      // Share the per-user serialization point used by detailed permission edits
      // and registration review transactions before changing either grant table.
      if (
        !(await transactionalEntityManager.findOne(UserEntity, {
          where: { id: userId },
          lock: { mode: "pessimistic_write" }
        }))
      )
        return SetUserPrivilegesResponseError.NO_SUCH_USER;
      await transactionalEntityManager.delete(UserPrivilegeEntity, {
        userId
      });

      // Clearing a checkbox must also clear a previous explicit allow from the detailed editor.
      await transactionalEntityManager.delete(UserPermissionRuleEntity, { userId, allowed: true });

      // The original Privileges checkboxes can also disable default-enabled new capabilities.
      for (const permission of new Set([...defaultUserPermissions, UserPrivilegeType.FakeSubmission])) {
        // eslint-disable-next-line no-await-in-loop -- Privilege propagation depends on the preceding decision.
        await transactionalEntityManager.save(UserPermissionRuleEntity, {
          userId,
          permission,
          allowed: newPrivilegeTypes.includes(permission as UserPrivilegeType)
        });
      }
      for (const permission of newPrivilegeTypes) {
        // eslint-disable-next-line no-await-in-loop -- Privilege propagation depends on the preceding decision.
        await transactionalEntityManager.delete(UserPermissionRuleEntity, { userId, permission });
      }

      for (const newPrivilegeType of newPrivilegeTypes) {
        const userPrivilege = new UserPrivilegeEntity();
        userPrivilege.privilegeType = newPrivilegeType;
        userPrivilege.userId = userId;
        await transactionalEntityManager.save(userPrivilege); // eslint-disable-line no-await-in-loop
      }
      return null;
    });
    this.forgetRequestCapabilities(userId);
    return error;
  }
}
