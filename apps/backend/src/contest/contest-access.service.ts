import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { Brackets, DataSource, SelectQueryBuilder } from "typeorm";

import { ContestEntity } from "./contest.entity";
import {
  contestHackWindow,
  contestProblemsOpen,
  contestScoreboardOpen,
  contestSubmissionsOpen
} from "./contest-policy";
import { isContestManager } from "./contest-manager";

import { UserEntity } from "../user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";
import { teamResourceAccess, teamResourceVisibilitySql } from "../team/team-access";

/**
 * Who may do what with a contest: manage it, open it, see its scoreboard, take part, read its problems' public
 * headers, rejudge or hack in it. All privilege checks on contests are made here, on top of the contest rules'
 * secrecy in contest-policy.ts.
 */
@Injectable()
export class ContestAccessService {
  constructor(@InjectDataSource() private readonly db: DataSource, private readonly privileges: UserPrivilegeService) {}

  /** See `isContestManager` */
  async manager(user: UserEntity, contest: ContestEntity) {
    return await isContestManager(this.db, this.privileges, user, contest);
  }

  /**
   * The contest, if the user may open it, and whether they manage it. With `problemAccess`, only managers may open a
   * contest that hasn't started.
   */
  async get(user: UserEntity, id: number, problemAccess = false) {
    if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException();
    const contest = await this.db.getRepository(ContestEntity).findOneBy({ id });
    if (!contest) throw new NotFoundException();
    if (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewContest))) throw new ForbiddenException();
    const manager = await this.manager(user, contest);
    const team = await teamResourceAccess(this.db, user, "contest", contest.id);
    if (team === false) throw new ForbiddenException();
    if (
      team === null &&
      !manager &&
      (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewContest)) ||
        (!contest.isPublic && !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewHiddenContest))))
    )
      throw new ForbiddenException();
    if (problemAccess && !contestProblemsOpen(contest, manager))
      throw new ForbiddenException({ error: "CONTEST_NOT_STARTED", message: "Contest has not started" });
    return { contest, manager };
  }

  /** Requires a signed-in user with the privilege. */
  async requirePrivilege(user: UserEntity, privilege: UserPrivilegeType) {
    if (!user) throw new ForbiddenException({ error: "LOGIN_REQUIRED", message: "Login required" });
    if (!(await this.privileges.userHasPrivilege(user, privilege))) throw new ForbiddenException();
  }

  /** A query of the contests the user may see in the contest list. */
  async listingQuery(user: UserEntity): Promise<SelectQueryBuilder<ContestEntity>> {
    if (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewContest))) throw new ForbiddenException();
    const repository = this.db.getRepository(ContestEntity);
    const query = repository.createQueryBuilder("c");
    const manage = !!user && (await this.privileges.userHasPrivilege(user, UserPrivilegeType.ManageContest));
    if (!manage) {
      if (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewContest)))
        throw new ForbiddenException();
      let extra: "all" | "owner" | null = null;
      if (user && (await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewHiddenContest))) extra = "all";
      // Ownership or appointment grants private access only while editing is permitted.
      else if (user && (await this.privileges.userHasPrivilege(user, UserPrivilegeType.EditContest))) extra = "owner";
      query.where(
        new Brackets(legacy => {
          legacy.where("c.isPublic = true");
          if (extra === "all") legacy.orWhere("1 = 1");
          else if (extra === "owner")
            legacy.orWhere("c.ownerId = :userId OR JSON_CONTAINS(c.adminIds, :jsonId)", {
              userId: user.id,
              jsonId: String(user.id)
            });
        })
      );
    }
    query.andWhere(teamResourceVisibilitySql("contest", "c.id", user));
    return query;
  }

  async canCreate(user: UserEntity) {
    return !!user && (await this.privileges.userHasPrivilege(user, UserPrivilegeType.CreateContest));
  }

  /** Whether the contest page may show the user their own results. */
  async canSeeOwnResults(user: UserEntity) {
    return !!user && (await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewSubmission));
  }

  /** Whether the user may see the contest's scoreboard now: "denied" without the privilege to see scoreboards at all. */
  async scoreboard(
    user: UserEntity,
    contest: ContestEntity,
    manager: boolean,
    now = Date.now()
  ): Promise<"allowed" | "denied" | "hidden"> {
    if (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewContestScoreboard))) return "denied";
    if (
      contestScoreboardOpen(contest, manager, now) ||
      (await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewHiddenContestScoreboard))
    )
      return "allowed";
    return "hidden";
  }

  /** Whether the user may submit in the contest now. */
  async canSubmit(user: UserEntity, contest: ContestEntity, manager: boolean, now = Date.now()) {
    return (
      !!user &&
      contestSubmissionsOpen(contest, manager, now) &&
      (await this.privileges.userHasPrivilege(user, UserPrivilegeType.ParticipateContest))
    );
  }

  async canDownloadAttachments(user: UserEntity) {
    return await this.privileges.userHasPrivilege(user, UserPrivilegeType.DownloadProblemAttachments);
  }

  /** Whether the user may download the public headers of the contest's communication problems. */
  async canReadPublicHeaders(user: UserEntity, manager: boolean): Promise<boolean> {
    return (
      !!user &&
      (await this.privileges.userHasPrivilege(user, UserPrivilegeType.DownloadProblemAttachments)) &&
      (manager || (await this.privileges.userHasPrivilege(user, UserPrivilegeType.ParticipateContest)))
    );
  }

  /** Whether a manager of the contest may rejudge its submissions. */
  async canRejudge(user: UserEntity) {
    return await this.privileges.permissionDecision(user, UserPrivilegeType.RejudgeSubmission, true);
  }

  async hackAccess(user: UserEntity, contest: ContestEntity): Promise<{ allowed: boolean; reason?: string }> {
    const access = await this.get(user, contest.id, true);
    contest = access.contest;
    if (!user || !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ParticipateContest)))
      return { allowed: false, reason: "Contest participation is not permitted" };
    return contestHackWindow(contest, access.manager);
  }
}
