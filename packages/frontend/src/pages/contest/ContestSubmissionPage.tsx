import React, { useEffect, useState } from "react";
import { Button, Header, Message, Table, Segment } from "semantic-ui-react";
import { defineRoute } from "@/AppRouter";
import ContestFrame from "./ContestFrame";
import { callContest, tr, formatDate, contestStatusText, contestLanguageName } from "./api";
import { useLocalizer } from "@/utils/hooks";

function ContestSubmissionPage({ detail, initial }: { detail: any; initial: any }) {
  const localizeLanguage = useLocalizer("code_language"),
    localizeSubmission = useLocalizer("submission");
  const [data, setData] = useState(initial),
    [error, setError] = useState("");
  const id = detail.contest.id,
    submissionId = initial.submission.id;
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        setData(await callContest("submission", { id, submissionId }));
      } catch (e) {
        setError(e.message);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [id, submissionId]);
  return (
    <ContestFrame detail={detail} tab="submissions">
      <Header as="h2">#{submissionId}</Header>
      {error && <Message negative>{error}</Message>}
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
      {detail.manager && (
        <Button
          onClick={async () => {
            try {
              await callContest("rejudge", { id, submissionId });
            } catch (e) {
              setError(e.message);
            }
          }}
        >
          {tr("重新评测", "Rejudge")}
        </Button>
      )}
    </ContestFrame>
  );
}
export default defineRoute(async req => {
  const id = Number(req.params.contestId),
    submissionId = Number(req.params.submissionId);
  const [detail, initial] = await Promise.all([
    callContest("detail", { id }),
    callContest("submission", { id, submissionId })
  ]);
  return <ContestSubmissionPage key={submissionId} detail={detail} initial={initial} />;
});
