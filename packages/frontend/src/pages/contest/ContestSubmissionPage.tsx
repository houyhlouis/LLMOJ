import React, { useEffect, useState } from "react";
import { Button, Header, Message, Table, Segment, Popup } from "semantic-ui-react";
import api from "@/api";
import { appState } from "@/appState";
import { defineRoute } from "@/AppRouter";
import ContestFrame from "./ContestFrame";
import { callContest, tr, formatDate, contestStatusText, contestLanguageName } from "./api";
import { useLocalizer } from "@/utils/hooks";
import HackAction from "@/pages/hack/HackAction";
import SubmissionReferenceButton from "@/pages/hack/SubmissionReferenceButton";
import hackStyle from "@/pages/hack/HackPages.module.less";

function ContestSubmissionPage({ detail, initial, embedded }: { detail: any; initial: any; embedded?: boolean }) {
  const localizeLanguage = useLocalizer("code_language"),
    localizeSubmission = useLocalizer("submission");
  const [data, setData] = useState(initial),
    [error, setError] = useState(""),
    [operationPending, setOperationPending] = useState(false),
    [fakePopupOpen, setFakePopupOpen] = useState(false),
    [restorePopupOpen, setRestorePopupOpen] = useState(false);
  const id = detail.contest.id,
    submissionId = initial.submission.id;
  useEffect(() => {
    let live = true,
      refreshing = false;
    const interval = setInterval(async () => {
      if (!live || refreshing) return;
      refreshing = true;
      try {
        const result = await callContest("submission", { id, submissionId });
        if (live) setData(result);
      } catch (e) {
        if (live) setError(e.message);
      } finally {
        refreshing = false;
      }
    }, 3000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [id, submissionId]);
  async function rejudge() {
    if (operationPending) return;
    setOperationPending(true);
    try {
      await callContest("rejudge", { id, submissionId });
      setData(await callContest("submission", { id, submissionId }));
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setRestorePopupOpen(false);
      setOperationPending(false);
    }
  }
  async function fake() {
    if (operationPending) return;
    setOperationPending(true);
    try {
      const { requestError, response } = await api.submission.fakeSubmission({ submissionId });
      if (requestError) setError(requestError(localizeSubmission));
      else if (response.error) setError(localizeSubmission(`.error.${response.error}`));
      else {
        setData(await callContest("submission", { id, submissionId }));
        setError("");
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setFakePopupOpen(false);
      setOperationPending(false);
    }
  }
  const content = (
    <>
      {!embedded && <Header as="h2">#{submissionId}</Header>}
      <div className={hackStyle.submissionActions}>
        <HackAction submissionId={submissionId} />
        <SubmissionReferenceButton submissionId={submissionId} status={data.submission.status} />
      </div>
      {error && <Message negative>{error}</Message>}
      {data.submission.status === "Fake" && (
        <Message negative icon="ban" content={localizeSubmission(".fake_notice")} />
      )}
      {data.submission.status === "Hacked" && (
        <Message
          negative
          icon="bug"
          content={tr(
            "有效 Hack 已使此提交失效，实际得分为 0。",
            "A valid hack has invalidated this submission; its effective score is 0."
          )}
        />
      )}
      <p>
        {formatDate(data.submission.submitTime)} · {contestLanguageName(data.submission.codeLanguage, localizeLanguage)}{" "}
        · {contestStatusText(data.submission.status)}
        {data.submission.score == null ? "" : ` / ${data.submission.score}`}
      </p>
      {detail.contest.rule === "noi" && !detail.ended && !detail.manager && (
        <Message info>
          {tr(
            "NOI 比赛期间仅提供编译反馈，得分和测试结果将在结束后公开。",
            "During NOI contests only compilation feedback is shown. Scores and test results become available after the contest ends."
          )}
        </Message>
      )}
      {data.content?.code && (
        <>
          <Header as="h3">{tr("源代码", "Source code")}</Header>
          <Segment>
            <pre style={{ overflowX: "auto" }}>{data.content.code}</pre>
          </Segment>
        </>
      )}
      {data.compile && (
        <>
          <Header as="h3">{tr("编译结果", "Compilation result")}</Header>
          <pre style={{ whiteSpace: "pre-wrap" }}>
            {typeof data.compile === "string" ? data.compile : JSON.stringify(data.compile, null, 2)}
          </pre>
        </>
      )}
      {data.subtasks?.map((s: any, i: number) => (
        <React.Fragment key={i}>
          <Header as="h3">
            {localizeSubmission(".subtask.title")} {i + 1}: {s.score ?? "—"}
          </Header>
          <Table basic="very">
            <Table.Body>
              {s.testcases?.map((t: any, j: number) => (
                <Table.Row key={j}>
                  <Table.Cell>#{j + 1}</Table.Cell>
                  <Table.Cell>{contestStatusText(t.status)}</Table.Cell>
                  <Table.Cell>{t.score ?? "—"}</Table.Cell>
                  <Table.Cell>{t.timeUsed == null ? "" : `${t.timeUsed} ms`}</Table.Cell>
                  <Table.Cell>{t.memoryUsed == null ? "" : `${t.memoryUsed} KiB`}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </React.Fragment>
      ))}
      {data.permissionRejudge &&
        (["Fake", "Hacked"].includes(data.submission.status) ? (
          <Popup
            on="click"
            open={restorePopupOpen}
            onOpen={() => setRestorePopupOpen(true)}
            onClose={() => setRestorePopupOpen(false)}
            trigger={<Button loading={operationPending}>{localizeSubmission(".rejudge")}</Button>}
            content={
              <Button
                negative
                loading={operationPending}
                onClick={rejudge}
                content={localizeSubmission(".confirm_restore_rejudge")}
              />
            }
          />
        ) : (
          <Button loading={operationPending} onClick={rejudge}>
            {tr("重新评测", "Rejudge")}
          </Button>
        ))}
      {data.permissionFake && data.submission.status !== "Fake" && (
        <Popup
          on="click"
          open={fakePopupOpen}
          onOpen={() => setFakePopupOpen(true)}
          onClose={() => setFakePopupOpen(false)}
          trigger={<Button negative icon="ban" loading={operationPending} content={localizeSubmission(".fake")} />}
          content={
            <Button negative loading={operationPending} onClick={fake} content={localizeSubmission(".confirm_fake")} />
          }
        />
      )}
    </>
  );
  return embedded ? (
    content
  ) : (
    <ContestFrame detail={detail} tab="submissions">
      {content}
    </ContestFrame>
  );
}

export async function loadContestSubmissionPage(id: number, submissionId: number, embedded = false) {
  const [detail, initial] = await Promise.all([
    callContest("detail", { id }),
    callContest("submission", { id, submissionId })
  ]);
  return <ContestSubmissionPage key={submissionId} detail={detail} initial={initial} embedded={embedded} />;
}

export default defineRoute(async req =>
  loadContestSubmissionPage(Number(req.params.contestId), Number(req.params.submissionId))
);
