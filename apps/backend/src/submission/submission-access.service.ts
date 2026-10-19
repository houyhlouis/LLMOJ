import { Injectable, Inject, forwardRef } from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";

import { Repository, DataSource, IsNull } from "typeorm";

import { SubmissionStatus } from "@libreoj/judge-protocol";

import { SubmissionEntity } from "./submission.entity";

import { ProblemService } from "../problem/problem.service";
import { ProblemAccessService, ProblemPermissionType } from "../problem/problem-access.service";
import { UserEntity } from "../user/user.entity";
import { ProblemEntity } from "../problem/problem.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";
import { ContestEntity } from "../contest/contest.entity";
import { isContestManager } from "../contest/contest-manager";
import { contestEnded } from "../contest/contest-policy";
import { teamResourceAccess } from "../team/team-access";

export enum SubmissionPermissionType {
  View = "View",
  Cancel = "Cancel",
  Rejudge = "Rejudge",
  ManagePublicness = "ManagePublicness",
  Delete = "Delete",
  Fake = "Fake"
}

/**
 * Who may do what with a submission: the one place for these rules, used by the submission, contest, hack and
 * self-eval endpoints and by live progress subscriptions.
 */
@Injectable()
export class SubmissionAccessService {
  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    @InjectRepository(SubmissionEntity)
    private readonly submissionRepository: Repository<SubmissionEntity>,
    private readonly problemService: ProblemService,
    private readonly problemAccess: ProblemAccessService,
    @Inject(forwardRef(() => UserPrivilegeService))
    private readonly userPrivilegeService: UserPrivilegeService
  ) {}

  async userHasPermission(
    user: UserEntity,
    submission: SubmissionEntity,
    type: SubmissionPermissionType,
    problem?: ProblemEntity,
    hasPrivilege?: boolean
  ): Promise<boolean> {
    if (!(await this.userHasTeamResourceAccess(user, submission))) return false;
    // Recheck disqualification authority before allowing a fake to be restored.
    if (
      type === SubmissionPermissionType.Rejudge &&
      submission.status === SubmissionStatus.Fake &&
      !(await this.userHasPermission(user, submission, SubmissionPermissionType.Fake, problem, hasPrivilege))
    )
      return false;

    if (submission.contestId) {
      const contest = await this.connection.getRepository(ContestEntity).findOneBy({ id: submission.contestId });
      if (!contest || !user || !(await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ViewContest)))
        return false;
      const manager = await isContestManager(this.connection, this.userPrivilegeService, user, contest);
      // Contest endpoints expose only the feedback permitted by the contest rule.
      if (manager) {
        if (type === SubmissionPermissionType.Rejudge)
          return (
            (submission.status !== SubmissionStatus.Hacked ||
              (await this.userPrivilegeService.permissionDecision(user, UserPrivilegeType.ManageHack, true))) &&
            (await this.userPrivilegeService.permissionDecision(user, UserPrivilegeType.RejudgeSubmission, true))
          );
        if (type === SubmissionPermissionType.Fake)
          return await this.userPrivilegeService.permissionDecision(
            user,
            UserPrivilegeType.FakeSubmission,
            await this.userPrivilegeService.permissionDecision(user, UserPrivilegeType.DeleteSubmission, true)
          );
        if (type === SubmissionPermissionType.Delete)
          return await this.userPrivilegeService.permissionDecision(user, UserPrivilegeType.DeleteSubmission, true);
        return true;
      }
      if (
        type === SubmissionPermissionType.ManagePublicness ||
        type === SubmissionPermissionType.Delete ||
        type === SubmissionPermissionType.Fake ||
        type === SubmissionPermissionType.Rejudge
      )
        return false;
      if (type === SubmissionPermissionType.Cancel) return user.id === submission.submitterId && !contestEnded(contest);
      return contestEnded(contest) && user.id === submission.submitterId;
    }
    switch (type) {
      // Everyone can read a public submission
      // Submitter and those who has the Modify permission of the submission's problem can View a non-public submission
      case SubmissionPermissionType.View:
        if (!(await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ViewSubmission))) return false;
        if (!user) return submission.isPublic;
        if (user.id === submission.submitterId) return true;
        if (
          await this.userPrivilegeService.permissionDecision(
            user,
            UserPrivilegeType.ReadAnySubmissionCode,
            submission.isPublic
          )
        )
          return true;
        if (
          submission.isPublic &&
          (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ReadCodeAfterAccepted)) &&
          (await this.getUserProblemAcceptedSubmissionCount(user.id, submission.problemId))
        )
          return true;
        return await this.problemAccess.userHasPermission(
          user,
          problem ?? (await this.problemService.findProblemById(submission.problemId)),
          ProblemPermissionType.Modify,
          hasPrivilege
        );

      // Submitter and those who has the Modify permission of the submission's problem can Cancel a submission
      case SubmissionPermissionType.Cancel:
        if (!user) return false;
        if (user.id === submission.submitterId) return true;
        return await this.problemAccess.userHasPermission(
          user,
          problem ?? (await this.problemService.findProblemById(submission.problemId)),
          ProblemPermissionType.Modify,
          hasPrivilege
        );

      // Those who has the Modify permission of the submission's problem can Rejudge a submission
      case SubmissionPermissionType.Rejudge:
        if (
          submission.status === SubmissionStatus.Hacked &&
          !(await this.userPrivilegeService.permissionDecision(
            user,
            UserPrivilegeType.ManageHack,
            await this.problemAccess.userHasPermission(
              user,
              problem ?? (await this.problemService.findProblemById(submission.problemId)),
              ProblemPermissionType.Modify,
              hasPrivilege
            )
          ))
        )
          return false;
        return await this.userPrivilegeService.permissionDecision(
          user,
          UserPrivilegeType.RejudgeSubmission,
          await this.problemAccess.userHasPermission(
            user,
            problem ?? (await this.problemService.findProblemById(submission.problemId)),
            ProblemPermissionType.Modify,
            hasPrivilege
          )
        );

      // Admins can manage a submission's publicness or delete a submission
      case SubmissionPermissionType.Delete:
        return await this.userPrivilegeService.permissionDecision(
          user,
          UserPrivilegeType.DeleteSubmission,
          !!user &&
            (user.isAdmin ||
              (hasPrivilege ??
                (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem))))
        );
      case SubmissionPermissionType.Fake:
        return await this.userPrivilegeService.permissionDecision(
          user,
          UserPrivilegeType.FakeSubmission,
          await this.userHasPermission(user, submission, SubmissionPermissionType.Delete, problem, hasPrivilege)
        );
      case SubmissionPermissionType.ManagePublicness:
        return (
          !!user &&
          (user.isAdmin ||
            (hasPrivilege ?? (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem))))
        );

      default:
        return false;
    }
  }

  async userHasTeamResourceAccess(user: UserEntity, submission: SubmissionEntity): Promise<boolean> {
    const resourceKind = submission.contestId ? "contest" : "problem";
    const resourceId = submission.contestId || submission.problemId;
    return (await teamResourceAccess(this.connection, user, resourceKind, resourceId)) !== false;
  }

  /** Accepted submissions of the user to the problem outside contests (to read others' code after accepting it). */
  async getUserProblemAcceptedSubmissionCount(userId: number, problemId: number): Promise<number> {
    return await this.submissionRepository.countBy({
      submitterId: userId,
      problemId,
      status: SubmissionStatus.Accepted,
      contestId: IsNull()
    });
  }
}
