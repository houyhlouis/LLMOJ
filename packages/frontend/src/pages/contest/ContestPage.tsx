import React, { useState } from "react";
import { Button, Checkbox, Form, Header, Label, Loader, Message, Pagination, Table } from "semantic-ui-react";
import { defineRoute } from "@/AppRouter";
import { Link, useLocalizer, usePoll } from "@/utils/hooks";
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
import { ArchiveManifest, ArchiveProgress, downloadContestArchive } from "./contestArchive";
import { VirtualParticipationPanel, virtualRunActive } from "./VirtualRun";

export function ContestPage({ initial, tab }: { initial: any; tab: string }) {
  const localizeLanguage = useLocalizer("code_language");
  const [detail, setDetail] = useState(initial),
    [shown, setShown] = useState<{ query: string; data: any }>(null),
    [error, setError] = useState(""),
    [page, setPage] = useState(1);
  const [userId, setUserId] = useState(""),
    [problemId, setProblemId] = useState("");
  // The standings with virtual runs too (after the contest; the server shows them by itself during the viewer's run)
  const [showVirtual, setShowVirtual] = useState(false);
  const inVirtualRun = virtualRunActive(detail);
  const id = detail.contest.id;
  const filter = { userId: Number(userId) || undefined, problemId: Number(problemId) || undefined };
  // What the tab, page and filters ask for. Rows are kept with the query that produced them, so an earlier query's
  // answer is never shown as the current one: while a new query loads, the last rows stay, dimmed.
  const query = JSON.stringify([tab, page, filter.userId ?? null, filter.problemId ?? null, showVirtual]);
  const data = shown?.data;
  const stale = !!shown && shown.query !== query;
  const loading = tab !== "overview" && (!shown || stale) && !error;
  // Every open contest page refreshes every 10 seconds, one request at a time; one in a background tab waits until it's
  // shown again. Changing the tab, page or a filter aborts the request in flight, and its answer is dropped.
  usePoll(
    async (signal, first) => {
      try {
        // The first request for a query skips the contest's detail: the page has just loaded it, or only the query
        // changed
        const nextDetail = first ? null : await callContest("detail", { id });
        const requestData = tab === "ranklist" && showVirtual ? { ...filter, virtual: true } : filter;
        const next = tab === "overview" ? null : await callContest(tab, { id, page, data: requestData });
        if (signal.aborted) return;
        if (nextDetail) setDetail(nextDetail);
        if (tab !== "overview") setShown({ query, data: next });
        setError("");
      } catch (e) {
        if (!signal.aborted) setError(e.message);
      }
    },
    [id, tab, page, userId, problemId, showVirtual],
    { intervalMs: 10000, hiddenIntervalMs: null }
  );
  async function exportCsv() {
    try {
      const result = await callContest("export", { id });
      // The server's CSV starts with a byte order mark (for spreadsheets); older servers' didn't
      const csv = result.csv.startsWith("\ufeff") ? result.csv : "\ufeff" + result.csv;
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `contest-${id}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    }
  }
  const [archive, setArchive] = useState<{ progress?: ArchiveProgress; result?: ArchiveManifest }>({});
  async function downloadArchive() {
    if (archive.progress) return;
    setError("");
    try {
      const result = await downloadContestArchive(id, progress => setArchive({ progress }));
      setArchive({ result });
    } catch (e) {
      setArchive({});
      setError(e.message || String(e));
    }
  }
  const archiveProgress = archive.progress;
  const archiveResult = archive.result;
  return (
    <ContestFrame detail={detail} tab={tab}>
      {error && <Message negative>{error}</Message>}
      {tab === "overview" && (
        <>
          <MarkdownContent content={detail.contest.description} />
          <p className={style.description}>{ruleDescription(detail.contest.rule)}</p>
          <VirtualParticipationPanel
            contestId={id}
            startTime={detail.contest.startTime}
            endTime={detail.contest.endTime}
            participation={detail.virtualParticipation}
            onStarted={setDetail}
          />
          {(detail.started || detail.manager) && detail.problems.length > 0 && (
            <div className={style.sectionToolbar}>
              <Button
                className="labeled icon"
                icon="download"
                loading={!!archiveProgress}
                disabled={!!archiveProgress}
                onClick={downloadArchive}
                content={tr("下载题目包（ZIP）", "Download problems (ZIP)")}
              />
              <span className={style.archiveNote} role="status">
                {archiveProgress?.stage === "preparing"
                  ? tr("正在生成题面 PDF……", "Making the statements PDF…")
                  : archiveProgress?.stage === "downloading"
                    ? archiveProgress.total
                      ? tr(
                          `正在下载附件（${archiveProgress.done} / ${archiveProgress.total}）……`,
                          `Downloading attachments (${archiveProgress.done} / ${archiveProgress.total})…`
                        )
                      : tr("正在保存……", "Saving…")
                    : tr(
                        "包含所有题面（statements.pdf）、每道题的样例和附件。",
                        "Every statement (statements.pdf), and each problem's samples and attachments."
                      )}
              </span>
            </div>
          )}
          {archiveResult && (archiveResult.warnings.length > 0 || archiveResult.attachmentsWithheld) && (
            <Message warning onDismiss={() => setArchive({})}>
              {archiveResult.attachmentsWithheld && (
                <p>
                  {tr(
                    "你没有下载附件的权限，题目包中不含附件。",
                    "You don't have the privilege to download attachments, so the archive has none."
                  )}
                </p>
              )}
              {archiveResult.warnings.length > 0 && (
                <>
                  <p>
                    {tr(
                      "以下内容未能放入 PDF，题面中以文字代替：",
                      "These couldn't be put in the PDF; the statements show a note instead:"
                    )}
                  </p>
                  <ul className={style.archiveWarnings}>
                    {archiveResult.warnings.map((warning, index) => (
                      <li key={index}>
                        {warning.kind === "image" ? tr("图片", "Image") : tr("公式", "Formula")}{" "}
                        <code>{warning.source}</code>: {warning.message}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Message>
          )}
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
              {detail.hasVirtualParticipants && (
                <Checkbox
                  toggle
                  checked={showVirtual}
                  label={tr("显示虚拟参赛者", "Show virtual participants")}
                  onChange={(_, v) => setShowVirtual(!!v.checked)}
                />
              )}
              <Button
                className="labeled icon"
                icon="download"
                onClick={exportCsv}
                content={tr("导出 CSV", "Export CSV")}
              />
            </div>
          </div>
          {inVirtualRun && (
            <Message info size="small">
              {tr(
                "你正在虚拟参赛：排行榜显示比赛进行到同一时刻时的状态，并计入你自己的结果。",
                "During your virtual run, the standings show the contest as it stood at the same point of its time, with your own results added."
              )}
            </Message>
          )}
          {loading && <Loader active inline="centered" size="small" className={style.loading} />}
          {data && (
            <div className={stale ? `${style.tableScroll} ${style.stale}` : style.tableScroll} aria-busy={stale}>
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
                    <Table.Row
                      key={row.userId}
                      className={row.virtual ? `${style.row} ${style.virtualRow}` : style.row}
                    >
                      <Table.Cell>{row.rank}</Table.Cell>
                      <Table.Cell>
                        <Link href={`/u/${row.username}`}>{row.username}</Link>
                        {row.virtual && (
                          <Label
                            size="mini"
                            className={style.virtualLabel}
                            title={tr(
                              `虚拟参赛，开始于 ${formatDate(row.virtualStartTime)}`,
                              `Virtual run, started ${formatDate(row.virtualStartTime)}`
                            )}
                          >
                            {tr("虚拟", "Virtual")}
                          </Label>
                        )}
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
                                : (x.score ?? "—")}
                            {x?.versions > 1 && (
                              <span
                                className={style.versionsNote}
                                title={tr(
                                  `有 ${x.versions} 个测试数据版本的结果：只合并同一版本的子任务`,
                                  `Results of ${x.versions} test data versions: only subtasks of one version combine`
                                )}
                              >
                                *
                              </span>
                            )}
                          </Table.Cell>
                        );
                      })}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          )}
          {data && !stale && !data.rows.length && <Message>{tr("暂无参赛记录", "No participants yet")}</Message>}
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
          {loading && <Loader active inline="centered" size="small" className={style.loading} />}
          {data && (
            <div className={stale ? `${style.tableScroll} ${style.stale}` : style.tableScroll} aria-busy={stale}>
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
          {data && !stale && !data.total && <Message>{tr("暂无提交", "No submissions yet")}</Message>}
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
