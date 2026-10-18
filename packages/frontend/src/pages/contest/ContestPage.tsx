import React, { useEffect, useState } from "react";
import { Button, Form, Header, Label, Message, Pagination, Table } from "semantic-ui-react";
import { defineRoute } from "@/AppRouter";
import { Link, useLocalizer } from "@/utils/hooks";
import MarkdownContent from "@/markdown/MarkdownContent";
import ContestFrame from "./ContestFrame";
import {
  callContest,
  tr,
  formatDate,
  problemLetter,
  languageChoices,
  contestStatusText,
  contestLanguageName
} from "./api";
import style from "./ContestPages.module.less";
import { appState } from "@/appState";
import { ruleDescription } from "./contest-rules";
import { SubmissionPreviewLink, SubmissionPreviewProvider } from "@/pages/submission/SubmissionPreview";

function ContestPage({ initial, tab }: { initial: any; tab: string }) {
  const localizeLanguage = useLocalizer("code_language");
  const [detail, setDetail] = useState(initial),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [page, setPage] = useState(1);
  const [userId, setUserId] = useState(""),
    [problemId, setProblemId] = useState("");
  const id = detail.contest.id;
  // `withDetail` false: only the tab's data, when the contest's detail was just loaded
  async function refresh(withDetail = true) {
    try {
      if (withDetail) setDetail(await callContest("detail", { id }));
      if (tab !== "overview")
        setData(
          await callContest(tab, {
            id,
            page,
            data: { userId: Number(userId) || undefined, problemId: Number(problemId) || undefined }
          })
        );
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    let live = true;
    refresh(false);
    // Every open contest page refreshes; one in a background tab waits until it's shown again
    const interval = setInterval(() => {
      if (live && !document.hidden) refresh();
    }, 10000);
    const shown = () => {
      if (live && !document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", shown);
    return () => {
      live = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [id, tab, page, userId, problemId]);
  async function exportCsv() {
    try {
      const result = await callContest("export", { id });
      const url = URL.createObjectURL(new Blob(["\ufeff" + result.csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `contest-${id}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <ContestFrame detail={detail} tab={tab}>
      {error && <Message negative>{error}</Message>}
      {tab === "overview" && (
        <>
          <MarkdownContent content={detail.contest.description} />
          <p className={style.description}>{ruleDescription(detail.contest.rule)}</p>
          {!detail.started && !detail.manager ? (
            <Message>
              {tr("比赛尚未开始，题目将在开始后公开。", "Problems will become available when the contest starts.")}
            </Message>
          ) : (
            <Table basic="very">
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>#</Table.HeaderCell>
                  <Table.HeaderCell>{tr("题目", "Problem")}</Table.HeaderCell>
                  <Table.HeaderCell>{tr("权重", "Weight")}</Table.HeaderCell>
                  <Table.HeaderCell>{tr("文件输入输出", "File I/O")}</Table.HeaderCell>
                  <Table.HeaderCell>{tr("我的成绩", "My result")}</Table.HeaderCell>
                  <Table.HeaderCell>{tr("通过 / 参与", "Solved / attempted")}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {detail.problems.map((p: any, i: number) => (
                  <Table.Row key={p.id} className={style.row}>
                    <Table.Cell>{problemLetter(i)}</Table.Cell>
                    <Table.Cell>
                      <Link href={`/contest/${id}/problem/${p.id}`}>{p.title}</Link>
                    </Table.Cell>
                    <Table.Cell>{p.weight}</Table.Cell>
                    <Table.Cell>
                      {p.inputFilename
                        ? `${p.inputFilename} / ${p.outputFilename}`
                        : tr("标准输入输出", "Standard I/O")}
                    </Table.Cell>
                    <Table.Cell>
                      {detail.ownResults?.[p.id] ? (
                        <Link href={`/contest/${id}/submission/${detail.ownResults[p.id].submissionId}`}>
                          {detail.ownResults[p.id].score ??
                            (detail.ownResults[p.id].status
                              ? contestStatusText(detail.ownResults[p.id].status)
                              : detail.ownResults[p.id].accepted
                              ? "AC"
                              : "—")}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      {detail.problemStats?.[p.id]
                        ? `${detail.problemStats[p.id].accepted} / ${detail.problemStats[p.id].attempted}`
                        : "—"}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          )}
          <p>
            {tr("允许的语言", "Allowed languages")}:{" "}
            {languageChoices(detail.contest.languages, localizeLanguage)
              .map(choice => choice.text)
              .join(", ")}
          </p>
        </>
      )}
      {tab === "ranklist" && (
        <>
          <div className={style.sectionToolbar}>
            <Header as="h2">{tr("排名", "Standings")}</Header>
            <div className={style.headerRightControls}>
              <Button
                className="labeled icon"
                icon="download"
                onClick={exportCsv}
                content={tr("导出 CSV", "Export CSV")}
              />
            </div>
          </div>
          {data && (
            <div className={style.tableScroll}>
              <Table basic="very" textAlign="center" unstackable>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>#</Table.HeaderCell>
                    <Table.HeaderCell>{tr("用户", "User")}</Table.HeaderCell>
                    <Table.HeaderCell>{tr("总分", "Score")}</Table.HeaderCell>
                    <Table.HeaderCell>{tr("用时 / 罚时", "Time / penalty")}</Table.HeaderCell>
                    {data.problems.map((p: any, i: number) => (
                      <Table.HeaderCell key={p.id}>
                        <Link href={`/contest/${id}/problem/${p.id}`}>{problemLetter(i)}</Link>
                      </Table.HeaderCell>
                    ))}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {data.rows.map((row: any) => (
                    <Table.Row key={row.userId} className={style.row}>
                      <Table.Cell>{row.rank}</Table.Cell>
                      <Table.Cell>
                        <Link href={`/u/${row.username}`}>{row.username}</Link>
                      </Table.Cell>
                      <Table.Cell>{row.score}</Table.Cell>
                      <Table.Cell>{Math.round(row.penalty / 60)}</Table.Cell>
                      {data.problems.map((p: any) => {
                        const x = row.problems[p.id];
                        return (
                          <Table.Cell key={p.id} positive={!!x?.accepted || x?.status === "Accepted"}>
                            {!x
                              ? "—"
                              : detail.contest.rule === "acm"
                              ? `${x.accepted ? "+" : "−"}${x.wrong || ""}${x.accepted ? ` (${x.minutes})` : ""}`
                              : x.score ?? "—"}
                          </Table.Cell>
                        );
                      })}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          )}
          {data && !data.rows.length && <Message>{tr("暂无参赛记录", "No participants yet")}</Message>}
        </>
      )}
      {tab === "submissions" && (
        <>
          <Header as="h2">{tr("提交记录", "Submissions")}</Header>
          <Form>
            <Form.Group widths="equal">
              <Form.Input
                label={tr("用户 ID", "User ID")}
                type="number"
                value={userId}
                onChange={(_, v) => {
                  setUserId(v.value);
                  setPage(1);
                }}
              />
              <Form.Select
                clearable
                label={tr("题目", "Problem")}
                options={detail.problems.map((p: any, i: number) => ({
                  value: String(p.id),
                  text: `${problemLetter(i)}. ${p.title}`
                }))}
                value={problemId}
                onChange={(_, v) => {
                  setProblemId(String(v.value));
                  setPage(1);
                }}
              />
            </Form.Group>
          </Form>
          {data && (
            <div className={style.tableScroll}>
              <Table basic="very">
                <Table.Header>
                  <Table.Row>
                    {[
                      "ID",
                      tr("用户", "User"),
                      tr("题目", "Problem"),
                      tr("状态", "Status"),
                      tr("分数", "Score"),
                      tr("语言", "Language"),
                      tr("时间", "Time")
                    ].map(h => (
                      <Table.HeaderCell key={h}>{h}</Table.HeaderCell>
                    ))}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {data.submissions.map((s: any) => (
                    <Table.Row key={s.id} className={style.row}>
                      <Table.Cell>
                        <SubmissionPreviewLink
                          submissionId={s.id}
                          contestId={id}
                          href={`/contest/${id}/submission/${s.id}`}
                        >
                          #{s.id}
                        </SubmissionPreviewLink>
                      </Table.Cell>
                      <Table.Cell>{s.username}</Table.Cell>
                      <Table.Cell>
                        <Link href={`/contest/${id}/problem/${s.contestProblemId}`}>
                          {detail.problems.find((p: any) => p.id === s.contestProblemId)?.title}
                        </Link>
                      </Table.Cell>
                      <Table.Cell>
                        <Label color={s.status === "Accepted" ? "green" : undefined}>
                          {contestStatusText(s.status)}
                        </Label>
                      </Table.Cell>
                      <Table.Cell>{s.score ?? "—"}</Table.Cell>
                      <Table.Cell>{contestLanguageName(s.codeLanguage, localizeLanguage)}</Table.Cell>
                      <Table.Cell>{formatDate(s.submitTime)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          )}
          {data && !data.total && <Message>{tr("暂无提交", "No submissions yet")}</Message>}
          {data?.total > 50 && (
            <div className={style.pagination}>
              <Pagination
                firstItem={null}
                lastItem={null}
                activePage={page}
                totalPages={Math.ceil(data.total / 50)}
                onPageChange={(_, v) => setPage(Number(v.activePage))}
              />
            </div>
          )}
        </>
      )}
    </ContestFrame>
  );
}
export const overview = defineRoute(async req => (
  <ContestPage
    key={`${req.params.contestId}-overview`}
    initial={await callContest("detail", { id: Number(req.params.contestId) })}
    tab="overview"
  />
));
export const ranklist = defineRoute(async req => (
  <ContestPage
    key={`${req.params.contestId}-ranklist`}
    initial={await callContest("detail", { id: Number(req.params.contestId) })}
    tab="ranklist"
  />
));
export const submissions = defineRoute(async req => (
  <SubmissionPreviewProvider>
    <ContestPage
      key={`${req.params.contestId}-submissions`}
      initial={await callContest("detail", { id: Number(req.params.contestId) })}
      tab="submissions"
    />
  </SubmissionPreviewProvider>
));

export default { overview, ranklist, submissions };
