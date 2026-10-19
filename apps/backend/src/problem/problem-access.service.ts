import { Injectable, Inject, forwardRef, ForbiddenException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, EntityManager } from "typeorm";

import { ProblemEntity } from "./problem.entity";

import { UserEntity } from "../user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";
import { PermissionService, PermissionObjectType } from "../permission/permission.service";
import { ConfigService } from "../config/config.service";
import { teamResourceAccess } from "../team/team-access";

export enum ProblemPermissionType {
  View = "View",
  Modify = "Modify",
  ManagePermission = "ManagePermission",
  ManagePublicness = "ManagePublicness",
  Delete = "Delete"
}

export enum ProblemPermissionLevel {
  Read = 1,
  Write = 2
}

/**
 * Who may do what with a problem: view, modify or delete it, manage its permissions or publicness, and create
 * problems. The one place for these rules; team problems follow their team's permissions.
 */
@Injectable()
export class ProblemAccessService {
  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    @Inject(forwardRef(() => UserPrivilegeService))
    private readonly userPrivilegeService: UserPrivilegeService,
    private readonly permissionService: PermissionService,
    private readonly configService: ConfigService
  ) {}

  async userHasPermission(
    user: UserEntity,
    problem: ProblemEntity,
    type: ProblemPermissionType,
    hasPrivilege?: boolean,
    manager?: EntityManager
  ): Promise<boolean> {
    if (!problem) return false;
    if (!(await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ViewProblem, manager))) return false;
    const teamAccess = await teamResourceAccess(
      manager ?? this.connection,
      user,
      "problem",
      problem.id,
      type === ProblemPermissionType.View ? "read" : "problems"
    );
    if (teamAccess !== null) {
      if (![ProblemPermissionType.View, ProblemPermissionType.Modify].includes(type)) return false;
      return (
        teamAccess &&
        (type === ProblemPermissionType.View ||
          (await this.userPrivilegeService.permissionDecision(
            user,
            user?.id === problem.ownerId ? UserPrivilegeType.EditOwnProblem : UserPrivilegeType.EditAnyProblem,
            true,
            manager
          )))
      );
    }
    if (
      type !== ProblemPermissionType.View &&
      !(await this.userHasPermission(user, problem, ProblemPermissionType.View, hasPrivilege, manager))
    )
      return false;
    const own = user?.id === problem.ownerId;
    const legacy = await this.userHasPermissionOriginal(user, problem, type, hasPrivilege, manager);
    const permission = {
      [ProblemPermissionType.View]:
        !problem.isPublic && !own ? UserPrivilegeType.ViewHiddenProblem : UserPrivilegeType.ViewProblem,
      [ProblemPermissionType.Modify]: own ? UserPrivilegeType.EditOwnProblem : UserPrivilegeType.EditAnyProblem,
      [ProblemPermissionType.Delete]: own ? UserPrivilegeType.DeleteOwnProblem : UserPrivilegeType.DeleteAnyProblem,
      [ProblemPermissionType.ManagePermission]: UserPrivilegeType.ManageProblemPermissions,
      [ProblemPermissionType.ManagePublicness]: UserPrivilegeType.ManageProblemVisibility
    }[type];
    return permission ? await this.userPrivilegeService.permissionDecision(user, permission, legacy, manager) : legacy;
  }

  private async userHasPermissionOriginal(
    user: UserEntity,
    problem: ProblemEntity,
    type: ProblemPermissionType,
    hasPrivilege?: boolean,
    manager?: EntityManager
  ): Promise<boolean> {
    switch (type) {
      // Everyone can view a public problem
      // Owner, admins and those who has read permission can view a non-public problem
      case ProblemPermissionType.View:
        if (problem.isPublic) return true;
        if (user && user.id === problem.ownerId) return true;
        if (
          hasPrivilege ??
          (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem, manager))
        )
          return true;
        else
          return await this.permissionService.userOrItsGroupsHavePermission(
            user,
            problem.id,
            PermissionObjectType.Problem,
            ProblemPermissionLevel.Read,
            manager
          );

      // Owner, admins and those who has write permission can modify a problem
      case ProblemPermissionType.Modify:
        if (
          user &&
          user.id === problem.ownerId &&
          (!problem.isPublic || this.configService.config.preference.security.allowNonPrivilegedUserEditPublicProblem)
        )
          return true;
        if (
          hasPrivilege ??
          (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem, manager))
        )
          return true;
        else
          return (
            (await this.permissionService.userOrItsGroupsHavePermission(
              user,
              problem.id,
              PermissionObjectType.Problem,
              ProblemPermissionLevel.Write,
              manager
            )) &&
            (!problem.isPublic || this.configService.config.preference.security.allowNonPrivilegedUserEditPublicProblem)
          );

      // Admins can manage a problem's permission
      // Controlled by the application preference, the owner may have the permission
      case ProblemPermissionType.ManagePermission:
        if (
          user &&
          user.id === problem.ownerId &&
          this.configService.config.preference.security.allowOwnerManageProblemPermission &&
          (!problem.isPublic || this.configService.config.preference.security.allowNonPrivilegedUserEditPublicProblem)
        )
          return true;
        else if (
          hasPrivilege ??
          (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem, manager))
        )
          return true;
        else return false;

      // Admins can manage a problem's publicness (set display id / make public or non-public)
      case ProblemPermissionType.ManagePublicness:
        if (
          hasPrivilege ??
          (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem, manager))
        )
          return true;
        else return false;

      // Admins can delete a problem
      // Controlled by the application preference, the owner may have the permission
      case ProblemPermissionType.Delete:
        if (
          user &&
          user.id === problem.ownerId &&
          this.configService.config.preference.security.allowOwnerDeleteProblem &&
          (!problem.isPublic || this.configService.config.preference.security.allowNonPrivilegedUserEditPublicProblem)
        )
          return true;
        else if (
          hasPrivilege ??
          (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem, manager))
        )
          return true;
        else return false;

      default:
        return false;
    }
  }

  async getUserPermissions(user: UserEntity, problem: ProblemEntity): Promise<ProblemPermissionType[]> {
    const result: ProblemPermissionType[] = [];
    for (const permission of Object.values(ProblemPermissionType)) {
      // eslint-disable-next-line no-await-in-loop -- Keep file handles, imports, and transaction operations ordered.
      if (await this.userHasPermission(user, problem, permission)) result.push(permission);
    }
    return result;
  }

  async userHasCreateProblemPermission(user: UserEntity, manager?: EntityManager): Promise<boolean> {
    if (!user) return false;
    const fallback =
      this.configService.config.preference.security.allowEveryoneCreateProblem ||
      (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem, manager));
    return await this.userPrivilegeService.permissionDecision(user, UserPrivilegeType.CreateProblem, fallback, manager);
  }

  /** Requires the acting user, if given, to be able to modify the problem now (inside the caller's transaction). */
  async authorizeProblemMutation(
    manager: EntityManager,
    problem: ProblemEntity,
    actingUser?: UserEntity
  ): Promise<void> {
    // Legacy internal callers retain their existing authorization contract; HTTP callers always supply the actor.
    if (!actingUser) return;
    if (
      !(await this.userPrivilegeService.userHasPrivilege(actingUser, UserPrivilegeType.ViewSite, manager)) ||
      !(await this.userHasPermission(actingUser, problem, ProblemPermissionType.Modify, undefined, manager))
    )
      throw new ForbiddenException();
  }
}
