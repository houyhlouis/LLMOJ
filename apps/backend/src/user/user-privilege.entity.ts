import { Entity, PrimaryColumn, Index, ManyToOne, JoinColumn } from "typeorm";

import { UserEntity } from "./user.entity";

export enum UserPrivilegeType {
  // Management privileges
  EditHomepage = "EditHomepage",
  ManageUser = "ManageUser",
  ManageUserGroup = "ManageUserGroup",
  ManageProblem = "ManageProblem",
  ManageContest = "ManageContest",
  ManageDiscussion = "ManageDiscussion",

  ViewSite = "ViewSite",
  ViewUsers = "ViewUsers",
  EditOwnProfile = "EditOwnProfile",
  ViewPrivateUserInfo = "ViewPrivateUserInfo",
  CreateGroup = "CreateGroup",
  ViewProblem = "ViewProblem",
  ViewHiddenProblem = "ViewHiddenProblem",
  CreateProblem = "CreateProblem",
  EditOwnProblem = "EditOwnProblem",
  EditAnyProblem = "EditAnyProblem",
  DeleteOwnProblem = "DeleteOwnProblem",
  DeleteAnyProblem = "DeleteAnyProblem",
  ManageProblemPermissions = "ManageProblemPermissions",
  ManageProblemVisibility = "ManageProblemVisibility",
  ManageProblemTags = "ManageProblemTags",
  ReadProblemData = "ReadProblemData",
  EditProblemData = "EditProblemData",
  DownloadProblemAttachments = "DownloadProblemAttachments",
  SubmitProblem = "SubmitProblem",
  ViewSubmission = "ViewSubmission",
  ReadAnySubmissionCode = "ReadAnySubmissionCode",
  ReadCodeAfterAccepted = "ReadCodeAfterAccepted",
  RejudgeSubmission = "RejudgeSubmission",
  DeleteSubmission = "DeleteSubmission",
  ViewDiscussion = "ViewDiscussion",
  CreateDiscussion = "CreateDiscussion",
  EditOwnDiscussion = "EditOwnDiscussion",
  EditAnyDiscussion = "EditAnyDiscussion",
  DeleteOwnDiscussion = "DeleteOwnDiscussion",
  DeleteAnyDiscussion = "DeleteAnyDiscussion",
  ReplyDiscussion = "ReplyDiscussion",
  ReactDiscussion = "ReactDiscussion",
  EditOwnReply = "EditOwnReply",
  ManageDiscussionReplies = "ManageDiscussionReplies",
  ViewContest = "ViewContest",
  ViewHiddenContest = "ViewHiddenContest",
  CreateContest = "CreateContest",
  EditContest = "EditContest",
  ParticipateContest = "ParticipateContest",
  ViewContestScoreboard = "ViewContestScoreboard",
  ViewHiddenContestScoreboard = "ViewHiddenContestScoreboard",
  ExportContest = "ExportContest",
  ManageSummaries = "ManageSummaries",
  ManageStudyLists = "ManageStudyLists",
  ManageAiConfiguration = "ManageAiConfiguration",
  UseAi = "UseAi",
  GenerateTestdata = "GenerateTestdata",
  ImportProblem = "ImportProblem",
  ManagePermissions = "ManagePermissions",

  // Other privileges
  SkipRecaptcha = "SkipRecaptcha",

  // Append new privileges to preserve stored MariaDB enum ordering.
  ManageRegistrationReviews = "ManageRegistrationReviews"
}

@Entity("user_privilege")
export class UserPrivilegeEntity {
  @ManyToOne(() => UserEntity, {
    onDelete: "CASCADE"
  })
  @JoinColumn()
  user: Promise<UserEntity>;

  @PrimaryColumn()
  @Index()
  userId: number;

  @PrimaryColumn({
    type: "enum",
    enum: UserPrivilegeType
  })
  @Index()
  privilegeType: UserPrivilegeType;
}
