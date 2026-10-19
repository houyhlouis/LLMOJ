import {
  Body,
  Controller,
  Get,
  Post,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  ConflictException
} from "@nestjs/common";

import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested
} from "class-validator";
import { Type } from "class-transformer";

import { StudyListService } from "./study-list.service";

import { CurrentUser } from "../common/user.decorator";
import { UserEntity } from "../user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";

class StudyListIdDto {
  @IsInt() @Min(1) id: number;
}
class ItemDto {
  @IsInt() @Min(1) problemId: number;

  @IsString() @Length(0, 120) section: string;

  @IsString() @Length(0, 10000) note: string;
}
class SaveDto {
  @IsOptional() @IsInt() @Min(1) id?: number;

  @IsOptional() @IsInt() @Min(1) version?: number;

  @IsString() @Length(1, 160) title: string;

  @IsString() @Length(0, 200000) description: string;

  @IsArray() @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => ItemDto) items: ItemDto[];

  @IsBoolean() starred: boolean;

  @IsBoolean() archived: boolean;
}
@Controller("studyList")
export class StudyListController {
  constructor(private readonly studyLists: StudyListService, private readonly privileges: UserPrivilegeService) {}

  private async authorized(user: UserEntity) {
    if (!user || !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ManageStudyLists)))
      throw new ForbiddenException();
  }

  @Get("list")
  async list(@CurrentUser() user: UserEntity) {
    await this.authorized(user);
    const lists = await this.studyLists.listOwned(user);
    return {
      lists: lists.map(x => ({
        id: x.id,
        title: x.title,
        count: x.items.length,
        starred: x.starred,
        archived: x.archived,
        updatedAt: x.updatedAt
      }))
    };
  }

  @Post("get")
  async get(@CurrentUser() user: UserEntity, @Body() body: StudyListIdDto) {
    await this.authorized(user);
    const list = await this.studyLists.findOwned(user, body.id);
    if (!list) throw new NotFoundException();
    return { list, details: await this.studyLists.describeItems(user, list) };
  }

  @Post("save")
  async save(@CurrentUser() user: UserEntity, @Body() body: SaveDto) {
    await this.authorized(user);
    const result = await this.studyLists.save(user, body.id, body.version, {
      title: body.title,
      description: body.description,
      items: body.items,
      starred: body.starred,
      archived: body.archived
    });
    if ("error" in result) {
      switch (result.error) {
        case "INVALID":
          throw new BadRequestException("Empty title or duplicate problem");
        case "NOT_FOUND":
          throw new NotFoundException();
        case "CHANGED":
          throw new ConflictException("List changed; reload before saving");
        case "PROBLEM_UNAVAILABLE":
        default:
          throw new BadRequestException("Problem is unavailable");
      }
    }
    return await this.get(user, { id: result.id });
  }

  @Post("delete")
  async remove(@CurrentUser() user: UserEntity, @Body() body: StudyListIdDto) {
    await this.authorized(user);
    if (!(await this.studyLists.remove(user, body.id))) throw new NotFoundException();
    return { deleted: true };
  }
}
