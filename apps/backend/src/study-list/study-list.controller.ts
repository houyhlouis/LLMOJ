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
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource } from "typeorm";
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

import { CurrentUser } from "../common/user.decorator";
import { UserEntity } from "../user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";
import { ProblemService, ProblemPermissionType } from "../problem/problem.service";
import { Locale } from "../common/locale.type";
import { SubmissionEntity } from "../submission/submission.entity";

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
    @InjectDataSource() private readonly db: DataSource,
    private readonly problems: ProblemService,
    private readonly privileges: UserPrivilegeService
  ) {}

  private async authorized(user: UserEntity) {
    if (!user || !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ManageStudyLists)))
      throw new ForbiddenException();
  }

  @Get("list")
  async list(@CurrentUser() user: UserEntity) {
    await this.authorized(user);
    const lists = await this.db
      .getRepository(StudyListEntity)
      .find({ where: { ownerId: user.id }, order: { starred: "DESC", updatedAt: "DESC" } });
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
    const list = await this.db.getRepository(StudyListEntity).findOneBy({ id: body.id, ownerId: user.id });
    if (!list) throw new NotFoundException();
    const canViewSubmissions = await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewSubmission);
    // Match the problem set: the user's latest accepted non-contest submission.
    const solved =
      canViewSubmissions && list.items.length > 0
        ? await this.db
            .getRepository(SubmissionEntity)
            .createQueryBuilder("s")
            .select("s.problemId", "problemId")
            .addSelect("MAX(s.id)", "submissionId")
            .where("s.submitterId = :id AND s.status = :status AND s.contestId IS NULL", {
              id: user.id,
              status: "Accepted"
            })
            .andWhere("s.problemId IN (:...problemIds)", { problemIds: list.items.map(item => item.problemId) })
            .groupBy("s.problemId")
            .getRawMany()
        : [];
    const acceptedSubmissions = new Map(solved.map(x => [Number(x.problemId), Number(x.submissionId)]));
    const details = [];
    for (const item of list.items) {
      // eslint-disable-next-line no-await-in-loop -- Resolve access and parent checks before processing the next list.
      const problem = await this.problems.findProblemById(item.problemId);
      // eslint-disable-next-line no-await-in-loop -- Resolve access and parent checks before processing the next list.
      if (!problem || !(await this.problems.userHasPermission(user, problem, ProblemPermissionType.View))) {
        details.push({ ...item, unavailable: true });
        continue;
      }
      const titles = {};
      for (const locale of [Locale.zh_CN, Locale.en_US]) {
        // eslint-disable-next-line no-await-in-loop -- Resolve each localized title before advancing.
        titles[locale] = await this.problems.getProblemLocalizedTitle(
          problem,
          problem.locales.includes(locale) ? locale : problem.locales[0]
        );
      }
      const submissionId = acceptedSubmissions.get(problem.id);
      details.push({
        ...item,
        // eslint-disable-next-line no-await-in-loop -- Resolve access and parent checks before processing the next list.
        meta: await this.problems.getProblemMeta(problem),
        titles,
        accepted: submissionId != null,
        submission: submissionId != null ? { id: submissionId, status: "Accepted" } : null
      });
    }
    return { list, details };
  }

  @Post("save")
  async save(@CurrentUser() user: UserEntity, @Body() body: SaveDto) {
    await this.authorized(user);
    if (!body.title.trim() || new Set(body.items.map(x => x.problemId)).size !== body.items.length)
      throw new BadRequestException("Empty title or duplicate problem");
    const repo = this.db.getRepository(StudyListEntity);
    let list = body.id ? await repo.findOneBy({ id: body.id, ownerId: user.id }) : repo.create({ ownerId: user.id });
    if (!list) throw new NotFoundException();
    if (body.id && body.version !== list.version) throw new ConflictException("List changed; reload before saving");
    const existingIds = new Set((list.items ?? []).map(item => item.problemId));
    for (const item of body.items) {
      // Existing notes are the user's own data even if a problem was deleted or made private.
      // Only newly added references need fresh problem-view authorization.
      if (existingIds.has(item.problemId)) continue;
      // eslint-disable-next-line no-await-in-loop -- Resolve access and parent checks before processing the next list.
      const problem = await this.problems.findProblemById(item.problemId);
      // eslint-disable-next-line no-await-in-loop -- Resolve access and parent checks before processing the next list.
      if (!problem || !(await this.problems.userHasPermission(user, problem, ProblemPermissionType.View)))
        throw new BadRequestException("Problem is unavailable");
    }
    if (body.id) {
      const result = await repo.update(
        { id: list.id, ownerId: user.id, version: body.version },
        {
          title: body.title.trim(),
          description: body.description,
          items: body.items,
          starred: body.starred,
          archived: body.archived
        }
      );
      if (!result.affected) throw new ConflictException();
    } else {
      Object.assign(list, {
        title: body.title.trim(),
        description: body.description,
        items: body.items,
        starred: body.starred,
        archived: body.archived
      });
      list = await repo.save(list);
    }
    return await this.get(user, { id: list.id });
  }

  @Post("delete")
  async remove(@CurrentUser() user: UserEntity, @Body() body: StudyListIdDto) {
    await this.authorized(user);
    const result = await this.db.getRepository(StudyListEntity).delete({ id: body.id, ownerId: user.id });
    if (!result.affected) throw new NotFoundException();
    return { deleted: true };
  }
}
