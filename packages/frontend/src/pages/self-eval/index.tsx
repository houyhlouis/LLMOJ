import React, { useEffect } from "react";
import { Header, Icon } from "semantic-ui-react";
import { observer } from "mobx-react";
import { defineRoute, RouteError } from "@/AppRouter";
import { appState } from "@/appState";
import SelfEvalPanel from "./SelfEvalPanel";
import { tr } from "@/pages/hack/api";
import { extensionApi } from "@/utils/extensionApi";
const SelfEvalPage = observer(function SelfEvalPage(props: { problemId: number; contestId: number }) {
  useEffect(() => {
    appState.enterNewPage(tr("自测", "Self-evaluation"), props.contestId ? "contests" : "problem_set");
  }, [appState.locale]);
  return (
    <>
      <Header as="h1" className="withIcon">
        <Icon name="lab" />
        {tr("自测", "Self-evaluation")} · P{props.problemId}
      </Header>
      <SelfEvalPanel {...props} />
    </>
  );
});
export default defineRoute(async request => {
  const problemId = Number(request.query.problemId),
    contestId = Number(request.query.contestId) || undefined;
  if (!Number.isSafeInteger(problemId) || problemId <= 0)
    throw new RouteError(tr("题目 ID 不合法。", "Invalid problem ID."));
  if (!Number.isSafeInteger(contestId) || contestId <= 0)
    throw new RouteError(
      tr("Self Eval 仅用于已开启此功能的 NOI / OI 比赛。", "Self Eval is available only in enabled NOI / OI contests.")
    );
  await extensionApi("selfEval/info", { problemId, contestId });
  return <SelfEvalPage key={JSON.stringify(request.query)} problemId={problemId} contestId={contestId} />;
});
