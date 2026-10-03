import React, { useState, useEffect } from "react";
import { Header, Checkbox, Button } from "semantic-ui-react";
import { observer } from "mobx-react";

import style from "./UserEdit.module.less";

import api from "@/api";
import { permissionCatalog } from "@/pages/access/permissionCatalog";
import { appState } from "@/appState";
import toast from "@/utils/toast";
import { useAsyncCallbackPending, useConfirmNavigation, useLocalizer } from "@/utils/hooks";
import { RouteError } from "@/AppRouter";
import { makeToBeLocalizedText } from "@/locales";

export async function fetchData(username: string) {
  const { requestError, response } = await api.user.getUserMeta({ username, getPrivileges: true });
  if (requestError) throw new RouteError(requestError, { showRefresh: true, showBack: true });
  else if (response.error) throw new RouteError(makeToBeLocalizedText(`user_edit.errors.${response.error}`));

  return response;
}

enum Privilege {
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
  SkipRecaptcha = "SkipRecaptcha"
}

interface PrevilegeViewProps {
  meta?: ApiTypes.UserMetaDto;
  privileges?: ApiTypes.GetUserMetaResponseDto["privileges"];
}

const PrevilegeView: React.FC<PrevilegeViewProps> = props => {
  const _ = useLocalizer("user_edit.privilege");

  useEffect(() => {
    appState.enterNewPage(`${_(`.title`)} - ${props.meta.username}`, null, false);
  }, [appState.locale, props.meta]);

  const [, setModified] = useConfirmNavigation();

  const [pending, onSubmit] = useAsyncCallbackPending(async () => {
    const { requestError, response } = await api.user.setUserPrivileges({
      userId: props.meta.id,
      privileges: [...privileges]
    });
    if (requestError) toast.error(requestError(_));
    else if (response.error) toast.error(_(`user_edit.errors.${response.error}`));
    else {
      setModified(false);
      toast.success(_(".success"));
    }
  });

  const [privileges, setPrivileges] = useState(new Set(props.privileges as Privilege[]));
  function togglePrivilege(privilege: Privilege, has: boolean) {
    const newPrivileges = new Set(privileges);
    if (has) newPrivileges.add(privilege);
    else newPrivileges.delete(privilege);
    setPrivileges(newPrivileges);
    setModified(true);
  }

  const isAdmin = appState.currentUser.isAdmin;

  return (
    <>
      <Header className={style.sectionHeader} size="large" content={_(".header")} />
      {Object.values(Privilege).map(privilege => (
        <div key={privilege} className={style.privilegeRow}>
          <Checkbox
            toggle
            readOnly={!isAdmin}
            label={
              permissionCatalog.find(x => x.key === privilege)?.[appState.locale === "zh_CN" ? "zh" : "en"] ||
              _(`.privileges.${privilege}.name`)
            }
            checked={privileges.has(privilege)}
            onChange={(e, { checked }) => togglePrivilege(privilege, checked)}
          />
          <div className={style.notes}>
            {permissionCatalog.some(x => x.key === privilege) ? "" : _(`.privileges.${privilege}.notes`)}
          </div>
        </div>
      ))}
      <div className={style.notes + " " + style.notesAdminOnly}>{_(".admin_only")}</div>
      <Button
        className={style.submit}
        loading={pending}
        disabled={!isAdmin}
        primary
        content={_(".submit")}
        onClick={onSubmit}
      />
    </>
  );
};

export const View = observer(PrevilegeView);
