import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";

import { UserPrivilegeService, UserPrivilegeType as P } from "../user/user-privilege.service";

/** Capabilities constrain routes; domain services still enforce object ownership and visibility. */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(private readonly privileges: UserPrivilegeService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;
    const req = context.switchToHttp().getRequest();
    const user = req.session?.user;
    // Express routes are case-insensitive and accept a trailing slash. Match its registered
    // route, not attacker-controlled URL spelling, so equivalent URLs have identical checks.
    const path = String(req.route?.path ?? req.path)
      .replace(/^\/?api\//i, "")
      .replace(/^\/+|\/+$/g, "")
      .toLowerCase();
    if (/^(auth|proofofwork|captcha|judge)\//.test(path)) return true;
    if (!(await this.privileges.userHasPrivilege(user, P.ViewSite))) throw new ForbiddenException();
    const [area, action] = path.split("/");
    const map: Record<string, P> = {
      "problem/createproblem": P.CreateProblem,
      "discussion/creatediscussion": P.CreateDiscussion,
      "discussion/creatediscussionreply": P.ReplyDiscussion,
      "discussion/togglereaction": P.ReactDiscussion,
      "submission/submit": P.SubmitProblem,
      "submission/preparefileupload": P.SubmitProblem,
      "submission/querysubmission": P.ViewSubmission,
      "submission/getsubmissiondetail": P.ViewSubmission,
      "submission/downloadsubmissionfile": P.ViewSubmission,
      "submission/querysubmissionstatistics": P.ViewSubmission,
      "user/getusermeta": P.ViewUsers,
      "user/getuserlist": P.ViewUsers,
      "user/getuserdetail": P.ViewUsers,
      "user/searchuser": P.ViewUsers,
      "contest/submit": P.SubmitProblem,
      "contest/prepareupload": P.SubmitProblem,
      "contest/submissions": P.ViewSubmission,
      "contest/submission": P.ViewSubmission
    };
    if (area === "problem" && !(await this.privileges.userHasPrivilege(user, P.ViewProblem)))
      throw new ForbiddenException();
    if (area === "discussion" && !(await this.privileges.userHasPrivilege(user, P.ViewDiscussion)))
      throw new ForbiddenException();
    let permission = map[path];
    if (area === "studylist") permission = P.ManageStudyLists;
    if (area === "summary" || area === "summaries") permission = P.ManageSummaries;
    if (
      area === "problem" &&
      ["addproblemfile", "renameproblemfile", "removeproblemfiles", "updateproblemjudgeinfo"].includes(action)
    )
      permission = P.EditProblemData;
    if (area === "problem" && action === "downloadproblemfiles")
      permission = req.body?.type === "TestData" ? P.ReadProblemData : P.DownloadProblemAttachments;
    if (permission === P.ReadProblemData) {
      if (!(await this.privileges.permissionDecision(user, permission, true))) throw new ForbiddenException();
    } else if (permission && !(await this.privileges.userHasPrivilege(user, permission)))
      throw new ForbiddenException();
    return true;
  }
}
