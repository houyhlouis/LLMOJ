import {
  Body,
  Controller,
  Get,
  Post,
  ForbiddenException,
  BadRequestException,
  NotFoundException
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource } from "typeorm";
import { IsInt, Min, IsObject } from "class-validator";

import { UserPermissionRuleEntity } from "./user-permission-rule.entity";

import { permissionCatalog } from "./permission-catalog";

import { CurrentUser } from "../common/user.decorator";
import { UserEntity } from "../user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";

class GetPermissionsDto {
  @IsInt() @Min(1) userId: number;
}
class SetPermissionsDto extends GetPermissionsDto {
  @IsObject() overrides: Record<string, boolean | null>;
}

@Controller("access")
export class AccessController {
  constructor(@InjectDataSource() private readonly db: DataSource, private readonly privileges: UserPrivilegeService) {}

  private requireAdmin(user: UserEntity) {
    if (!user?.isAdmin) throw new ForbiddenException();
  }

  @Get("catalog")
  catalog(@CurrentUser() user: UserEntity) {
    this.requireAdmin(user);
    const labels = {
      EditHomepage: "编辑首页",
      ManageUser: "管理用户",
      ManageUserGroup: "管理用户组",
      ManageProblem: "管理全部题目",
      ManageContest: "管理全部比赛",
      ManageDiscussion: "管理全部讨论",
      SkipRecaptcha: "跳过验证码与计算验证"
    };
    const original = Object.values(UserPrivilegeType).filter(key => !permissionCatalog.some(x => x.key === key));
    return {
      catalog: [
        ...permissionCatalog,
        ...original.map(key => ({ key, category: "management", zh: labels[key] || key, en: key, defaultValue: false }))
      ]
    };
  }

  @Get("mine")
  async mine(@CurrentUser() user: UserEntity) {
    return { permissions: user ? await this.privileges.getUserPrivileges(user.id) : [] };
  }

  @Post("get")
  async get(@CurrentUser() user: UserEntity, @Body() body: GetPermissionsDto) {
    this.requireAdmin(user);
    const target = await this.db.getRepository(UserEntity).findOneBy({ id: body.userId });
    if (!target) throw new NotFoundException();
    const rows = await this.db.getRepository(UserPermissionRuleEntity).findBy({ userId: target.id });
    return {
      user: { id: target.id, username: target.username, isAdmin: target.isAdmin },
      overrides: Object.fromEntries(rows.map(row => [row.permission, row.allowed])),
      effective: await this.privileges.getUserPrivileges(target.id)
    };
  }

  @Post("set")
  async set(@CurrentUser() user: UserEntity, @Body() body: SetPermissionsDto) {
    this.requireAdmin(user);
    const keys = new Set<string>(Object.values(UserPrivilegeType));
    if (
      Object.entries(body.overrides).some(
        ([key, value]) => !keys.has(key) || (value !== null && typeof value !== "boolean")
      )
    )
      throw new BadRequestException("Invalid permission rule");
    if (!(await this.db.getRepository(UserEntity).countBy({ id: body.userId }))) throw new NotFoundException();
    await this.db.transaction(async manager => {
      // Serialize permission changes with registration-review authorization,
      // including insertion of a deny where no explicit rule existed before.
      if (!(await manager.findOne(UserEntity, { where: { id: body.userId }, lock: { mode: "pessimistic_write" } })))
        throw new NotFoundException();
      for (const [permission, allowed] of Object.entries(body.overrides)) {
        // eslint-disable-next-line no-await-in-loop -- Permission decisions depend on the current user and are evaluated in order.
        if (allowed === null) await manager.delete(UserPermissionRuleEntity, { userId: body.userId, permission });
        // eslint-disable-next-line no-await-in-loop -- Permission decisions depend on the current user and are evaluated in order.
        else await manager.save(UserPermissionRuleEntity, { userId: body.userId, permission, allowed });
      }
    });
    return await this.get(user, body);
  }
}
