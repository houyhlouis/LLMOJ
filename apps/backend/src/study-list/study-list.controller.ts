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

import { StudyListEntity } from "./study-list.entity";
import { StudyListService } from "./study-list.service";

import { CurrentUser } from "../common/user.decorator";
import { ConfigService } from "../config/config.service";
import { UserEntity } from "../user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";

/** A page of the user's lists, as the problem set pages its problems (and within the same limit) */
class QueryStudyListsRequestDto {
  @IsOptional() @IsString() @Length(0, 160) keyword?: string;

  @IsOptional() @IsBoolean() archived?: boolean;

  @IsInt() @Min(0) skipCount: number;

  @IsInt() @Min(1) takeCount: number;
}
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
  constructor(
    private readonly studyLists: StudyListService,
    private readonly privileges: UserPrivilegeService,
    private readonly configService: ConfigService
  ) {}

  private static summary(list: StudyListEntity) {
    return {
      id: list.id,
      title: list.title,
      count: list.items.length,
      starred: list.starred,
      archived: list.archived,
      updatedAt: list.updatedAt
    };
  }

  private async authorized(user: UserEntity) {
    if (!user || !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ManageStudyLists)))
      throw new ForbiddenException();
  }

  @Get("list")
  async list(@CurrentUser() user: UserEntity) {
    await this.authorized(user);
    const lists = await this.studyLists.listOwned(user);
    return { lists: lists.map(StudyListController.summary) };
  }

  /** One page of the user's lists, in ID order, with as many lists on a page as the problem set has problems */
  @Post("query")
  async query(@CurrentUser() user: UserEntity, @Body() body: QueryStudyListsRequestDto) {
    await this.authorized(user);
    if (body.takeCount > this.configService.config.queryLimit.problemSet) throw new BadRequestException();
    const { lists, count, total } = await this.studyLists.queryOwned(user, body);
    return { lists: lists.map(StudyListController.summary), count, total };
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
