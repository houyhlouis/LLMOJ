import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { Brackets, DataSource, EntityManager, SelectQueryBuilder } from "typeorm";

import { ContestEntity } from "./contest.entity";
import { ContestProblemEntity } from "./contest-problem.entity";
import { requireContestSubmissionLanguage } from "./contest-languages";
import { ContestVirtualParticipationEntity } from "./contest-virtual-participation.entity";
import { activeVirtualRun, contestViewerTime, VirtualRun } from "./contest-virtual";
import {
  contestEnded,
  contestHackWindow,
  contestProblemsOpen,
  contestScoreboardOpen,
  contestSubmissionsOpen
} from "./contest-policy";
import { isContestManager } from "./contest-manager";

import { UserEntity } from "../user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";
import { teamResourceAccess, teamResourceVisibilitySql } from "../team/team-access";
import { SubmissionEntity } from "../submission/submission.entity";
import type { SubmissionContent } from "../submission/submission-content.interface";

const virtualStartErrors = {
  NOT_ENDED: "The official contest has not ended",
  PARTICIPATED: "You submitted in the official contest",
  ALREADY_USED: "You have already started a virtual run in this contest",
  MANAGER: "Contest managers cannot start a virtual run",
  NO_PERMISSION: "Contest participation is not permitted"
};

function denyVirtualStart(reason: keyof typeof virtualStartErrors): never {
  throw new ForbiddenException({ error: `VIRTUAL_${reason}`, message: virtualStartErrors[reason] });
}

/**
 * Who may do what with a contest: manage it, open it, see its scoreboard, take part, read its problems' public
 * headers, rejudge or hack in it. All privilege checks on contests are made here, on top of the contest rules'
 * secrecy in contest-policy.ts.
 */
@Injectable()
export class ContestAccessService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly privileges: UserPrivilegeService
  ) {}

  /** See `isContestManager` */
  async manager(user: UserEntity, contest: ContestEntity, transaction?: EntityManager) {
    return await isContestManager(this.db, this.privileges, user, contest, transaction);
  }

  /**
   * The contest, if the user may open it, and whether they manage it. With `problemAccess`, only managers may open a
   * contest that hasn't started.
   */
  async get(user: UserEntity, id: number, problemAccess = false, transaction?: EntityManager, at?: number) {
    if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException();
    const contest = transaction
      ? await transaction.findOne(ContestEntity, { where: { id }, lock: { mode: "pessimistic_read" } })
      : await this.db.getRepository(ContestEntity).findOneBy({ id });
    if (!contest) throw new NotFoundException();
    const access = await this.viewAccess(user, contest, transaction);
    if (!access) throw new ForbiddenException();
    // Read a run that started during upload sealing, even when evaluating the earlier upload time.
    const participation =
      user && contestEnded(contest)
        ? await (transaction ?? this.db)
            .getRepository(ContestVirtualParticipationEntity)
            .findOneBy({ contestId: id, userId: user.id })
        : null;
    const wallNow = at ?? Date.now();
    const virtualRun = activeVirtualRun(participation, access.manager, wallNow);
    const now = contestViewerTime(contest, virtualRun, wallNow);
    if (problemAccess && !contestProblemsOpen(contest, access.manager, now))
      throw new ForbiddenException({ error: "CONTEST_NOT_STARTED", message: "Contest has not started" });
    return { contest, manager: access.manager, participation, virtualRun, now };
  }

  /** Whether the user may open the contest now (as `get`, without throwing): for pages that mention contests. */
  async canView(user: UserEntity, contest: ContestEntity) {
    return !!contest && !!(await this.viewAccess(user, contest));
  }

  private async viewAccess(
    user: UserEntity,
    contest: ContestEntity,
    transaction?: EntityManager
  ): Promise<{ manager: boolean } | null> {
    if (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewContest, transaction))) return null;
    const manager = await this.manager(user, contest, transaction);
    const team = await teamResourceAccess(transaction ?? this.db, user, "contest", contest.id);
    if (team === false) return null;
    if (
      team === null &&
      !manager &&
      !contest.isPublic &&
      !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewHiddenContest, transaction))
    )
      return null;
    return { manager };
  }

  /** Requires a signed-in user with the privilege. */
  async requirePrivilege(user: UserEntity, privilege: UserPrivilegeType, transaction?: EntityManager) {
    if (!user) throw new ForbiddenException({ error: "LOGIN_REQUIRED", message: "Login required" });
    if (!(await this.privileges.userHasPrivilege(user, privilege, transaction))) throw new ForbiddenException();
  }

  async virtualStartReason(
    user: UserEntity,
    contest: ContestEntity,
    manager: boolean,
    participation: VirtualRun,
    transaction?: EntityManager
  ): Promise<keyof typeof virtualStartErrors | null> {
    if (participation) return "ALREADY_USED";
    if (manager) return "MANAGER";
    if (!user || !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ParticipateContest, transaction)))
      return "NO_PERMISSION";
    if (!contestEnded(contest)) return "NOT_ENDED";
    const submitted = await (transaction ?? this.db)
      .getRepository(SubmissionEntity)
      .createQueryBuilder("s")
      .where(
        "s.contestId = :contestId AND s.submitterId = :userId AND s.submitTime >= :start AND s.submitTime < :end",
        {
          contestId: contest.id,
          userId: user.id,
          start: contest.startTime,
          end: contest.endTime
        }
      )
      .getExists();
    return submitted ? "PARTICIPATED" : null;
  }

  async requireVirtualStart(user: UserEntity, id: number, transaction: EntityManager) {
    if (!user) {
      await this.get(user, id, false, transaction);
      denyVirtualStart("NO_PERMISSION");
    }
    // An official submission holds a shared lock on this user until it commits. The exclusive start
    // lock sees that submission even at the official cutoff, and serializes two starts by this user.
    const actor = await transaction.findOne(UserEntity, {
      where: { id: user.id },
      lock: { mode: "pessimistic_write" }
    });
    if (!actor) denyVirtualStart("NO_PERMISSION");
    const { contest, manager, participation } = await this.get(actor, id, false, transaction);
    const reason = await this.virtualStartReason(actor, contest, manager, participation, transaction);
    if (reason) denyVirtualStart(reason);
    return contest;
  }

  /** The insert transaction locks user, contest and slot in order, then stores this decision with the submission. */
  async admitSubmission(
    user: UserEntity,
    requestedSlot: Pick<ContestProblemEntity, "id" | "contestId" | "problemId">,
    content: SubmissionContent,
    transaction: EntityManager,
    uploadStartedAt?: number
  ) {
    const actor = await transaction.findOne(UserEntity, { where: { id: user.id }, lock: { mode: "pessimistic_read" } });
    if (!actor) throw new ForbiddenException();
    const { contest, manager, participation } = await this.get(
      actor,
      requestedSlot.contestId,
      true,
      transaction,
      uploadStartedAt
    );
    await this.requirePrivilege(actor, UserPrivilegeType.ParticipateContest, transaction);
    await this.requirePrivilege(actor, UserPrivilegeType.SubmitProblem, transaction);
    const slot = await transaction.findOne(ContestProblemEntity, {
      where: { id: requestedSlot.id, contestId: contest.id },
      lock: { mode: "pessimistic_read" }
    });
    if (!slot || slot.problemId !== requestedSlot.problemId) throw new NotFoundException();
    requireContestSubmissionLanguage(contest.languages, content);
    const wallNow = uploadStartedAt ?? Date.now();
    // A virtual start can commit while an official answer is being sealed. That start already won the user lock.
    if (uploadStartedAt !== undefined && participation && contestSubmissionsOpen(contest, false, wallNow))
      throw new ForbiddenException("Contest has ended");
    const now = contestViewerTime(contest, activeVirtualRun(participation, manager, wallNow), wallNow);
    if (!contestSubmissionsOpen(contest, manager, now)) throw new ForbiddenException("Contest has ended");
    return {
      submitTime: new Date(Math.floor(wallNow / 1000) * 1000),
      contestId: contest.id,
      contestProblemId: slot.id,
      contestInputFilename: slot.inputFilename,
      contestOutputFilename: slot.outputFilename,
      contestSubtaskAllOrNothing: slot.subtaskAllOrNothing
    };
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
    now = Date.now(),
    virtualRun?: VirtualRun
  ): Promise<"allowed" | "denied" | "hidden"> {
    if (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewContestScoreboard))) return "denied";
    if (
      contestScoreboardOpen(contest, manager, now) ||
      (!virtualRun && (await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewHiddenContestScoreboard)))
    )
      return "allowed";
    return "hidden";
  }

  /** Whether the user may submit in the contest now. */
  async canSubmit(user: UserEntity, contest: ContestEntity, manager: boolean, now = Date.now()) {
    return (
      !!user &&
      contestSubmissionsOpen(contest, manager, now) &&
      (await this.privileges.userHasPrivilege(user, UserPrivilegeType.ParticipateContest)) &&
      (await this.privileges.userHasPrivilege(user, UserPrivilegeType.SubmitProblem))
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
    if (access.virtualRun) return { allowed: false, reason: "Hacks are unavailable during virtual participation" };
    if (!user || !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ParticipateContest)))
      return { allowed: false, reason: "Contest participation is not permitted" };
    return contestHackWindow(contest, access.manager);
  }
}
