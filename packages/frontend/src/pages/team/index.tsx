import React from "react";
import { mount } from "navi";
import { observer } from "mobx-react";
import { Button, Header, Message, Segment } from "semantic-ui-react";
import { defineRoute, RouteError } from "@/AppRouter";
import { appState } from "@/appState";
import { useLoginOrRegisterNavigation, useNavigationChecked } from "@/utils/hooks";
import TeamList from "./TeamList";
import TeamPage from "./TeamPage";
import { teamApi, tr } from "./api";

const Invitation = observer(({ token, contest }: { token: string; contest?: boolean }) => {
  const nav = useNavigationChecked(),
    login = useLoginOrRegisterNavigation();
  const [busy, setBusy] = React.useState(false),
    [error, setError] = React.useState("");
  React.useEffect(() => {
    appState.enterNewPage(tr("邀请", "Invitation"), "teams");
  }, [appState.locale]);
  async function accept() {
    setBusy(true);
    setError("");
    try {
      const r = await teamApi(contest ? "acceptContestInvitation" : "acceptInvitation", { token });
      await nav.navigate(contest ? "/contest/" + r.contestId : "/teams/" + r.teamId);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Segment>
      <Header as="h1">{contest ? tr("比赛邀请", "Contest invitation") : tr("团队邀请", "Team invitation")}</Header>
      <p>
        {contest
          ? tr("接受邀请后，你将获得这场比赛的参赛权限。", "Accept to gain access to this contest.")
          : tr("接受邀请后，你将成为该团队的成员。", "Accept to become a member of this team.")}
      </p>
      {error && <Message negative content={error} />}
      {appState.currentUser ? (
        <Button primary loading={busy} disabled={busy} onClick={accept}>
          {tr("接受邀请", "Accept invitation")}
        </Button>
      ) : (
        <Button primary onClick={() => login("login")}>
          {tr("登录后接受邀请", "Sign in to accept")}
        </Button>
      )}
    </Segment>
  );
});
const token = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new RouteError(tr("无效邀请。", "Invalid invitation."));
  return value;
};
const tabs = ["overview", "members", "problems", "contests", "assignments", "discussions", "files", "settings"];
export default {
  teams: mount({
    "/": defineRoute(async () => <TeamList />),
    "/:id": defineRoute(async request => {
      const id = Number(request.params.id);
      if (!Number.isSafeInteger(id) || id < 1) throw new RouteError(tr("无效团队。", "Invalid team."));
      return (
        <TeamPage key={id} teamId={id} initialTab={tabs.includes(request.query.tab) ? request.query.tab : "overview"} />
      );
    })
  }),
  teamInvite: defineRoute(async request => <Invitation token={token(request.params.token)} />),
  contestInvite: defineRoute(async request => <Invitation token={token(request.params.token)} contest />)
};
