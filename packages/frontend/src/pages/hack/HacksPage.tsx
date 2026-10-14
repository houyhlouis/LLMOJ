import React, { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { Button, Form, Icon, Message, Table } from "semantic-ui-react";
import { defineRoute } from "@/AppRouter";
import { appState } from "@/appState";
import { Link, useNavigationChecked, useScreenWidthWithin } from "@/utils/hooks";
import { isValidUsername } from "@/utils/validators";
import formatFileSize from "@/utils/formatFileSize";
import { friendlyFormatDateTime } from "@/utils/formatDateTime";
import { SimplePagination } from "@/components/Pagination";
import ContestFrame from "@/pages/contest/ContestFrame";
import { callContest } from "@/pages/contest/api";
import {
  errorText,
  hackApi,
  HackRecord,
  HackStatus,
  hackStatuses,
  problemUrl,
  statusText,
  submissionUrl,
  tr
} from "./api";
import style from "./HackPages.module.less";
import listStyle from "@/pages/submission/submissions/SubmissionsPage.module.less";
import { DetailPreviewProvider, HackPreviewLink, SubmissionPreviewLink } from "@/pages/submission/SubmissionPreview";

interface HackQuery {
  problemId?: number;
  submissionId?: number;
  hacker?: string;
  status?: HackStatus;
  mine?: boolean;
  page?: number;
}
function positiveId(value: string) {
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : undefined;
}
function normalizeQuery(query: Record<string, string>): HackQuery {
  return {
    problemId: positiveId(query.problemId),
    submissionId: positiveId(query.submissionId),
    hacker: isValidUsername(query.hacker) ? query.hacker : undefined,
    status: hackStatuses.includes(query.status as HackStatus) ? (query.status as HackStatus) : undefined,
    mine: query.mine === "1",
    page: positiveId(query.page) || 1
  };
}
const HacksPage = observer(function HacksPage({
  query,
  initial,
  detail
}: {
  query: HackQuery;
  initial: { hacks: HackRecord[]; total: number; pageSize: number };
  detail?: any;
}) {
  const navigation = useNavigationChecked(),
    contestId = detail?.contest.id,
    wide = useScreenWidthWithin(1024, Infinity);
  const [data, setData] = useState(initial),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [problemId, setProblemId] = useState(query.problemId ? String(query.problemId) : ""),
    [submissionId, setSubmissionId] = useState(query.submissionId ? String(query.submissionId) : ""),
    [hacker, setHacker] = useState(query.hacker || (query.mine ? appState.currentUser?.username || "" : "")),
    [status, setStatus] = useState(query.status || "");
  useEffect(() => {
    if (!detail) appState.enterNewPage(tr("Hack 记录", "Hacks"), "hacks");
  }, [appState.locale]);
  async function refresh() {
    setBusy(true);
    try {
      setData(await hackApi("list", { ...query, contestId }));
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!data.hacks.some(record => record.status === "Pending" || record.status === "Running")) return;
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, [data.hacks, contestId]);
  function queryUrl(next: HackQuery) {
    return {
      pathname: contestId ? `/contest/${contestId}/hacks` : "/hacks",
      query: Object.fromEntries(
        Object.entries(next)
          .filter(([, value]) => value != null && value !== false)
          .map(([key, value]) => [key, value === true ? "1" : String(value)])
      )
    };
  }
  function filter(mine = false) {
    if ((problemId && !positiveId(problemId)) || (submissionId && !positiveId(submissionId))) {
      setError(tr("题目和提交编号必须是正整数。", "Problem and submission IDs must be positive integers."));
      return;
    }
    if (!mine && hacker && !isValidUsername(hacker)) {
      setError(tr("请输入有效的 Hacker 用户名。", "Enter a valid hacker username."));
      return;
    }
    navigation.navigate(
      queryUrl({
        problemId: positiveId(problemId),
        submissionId: positiveId(submissionId),
        hacker: mine ? undefined : hacker || undefined,
        mine,
        status: (status as HackStatus) || undefined
      })
    );
  }
  const content = (
    <>
      {error && <Message negative content={error} />}
      <Form className={`${listStyle.queryForm} ${style.hackQuery}`} onSubmit={() => filter()}>
        <Form.Group inline unstackable>
          <Form.Input
            id="hack-query-problem"
            className={listStyle.queryInputProblemId}
            icon="hashtag"
            iconPosition="left"
            aria-label={tr("题目 ID", "Problem ID")}
            placeholder={tr("题目 ID", "Problem ID")}
            value={problemId}
            onChange={(_, value) => setProblemId(value.value)}
          />
          <Form.Input
            id="hack-query-hacker"
            className={listStyle.queryInputSubmitter}
            icon="user"
            iconPosition="left"
            aria-label="Hacker"
            placeholder="Hacker"
            value={hacker}
            onChange={(_, value) => setHacker(value.value)}
          />
          <Form.Input
            id="hack-query-submission"
            className={style.targetFilter}
            icon="hashtag"
            iconPosition="left"
            aria-label={tr("提交编号", "Submission ID")}
            placeholder={tr("提交编号", "Submission ID")}
            value={submissionId}
            onChange={(_, value) => setSubmissionId(value.value)}
          />
          <Form.Select
            aria-label={tr("Hack 状态", "Hack status")}
            className={`${listStyle.queryInputStatus} ${listStyle.select} ${!status ? listStyle.selectedAll : ""} ${
              style.statusFilter
            }`}
            value={status || "ALL"}
            options={[
              {
                value: "ALL",
                text: (
                  <>
                    <Icon name="question" />
                    <span>{tr("全部状态", "All statuses")}</span>
                  </>
                )
              },
              ...hackStatuses.map(value => ({ value, text: statusText(value) }))
            ]}
            onChange={(_, value) => setStatus(value.value === "ALL" ? "" : String(value.value))}
          />
          <Button
            type="submit"
            className={`${listStyle.queryButton} ${wide ? "labeled icon" : ""}`}
            icon="search"
            content={wide ? tr("筛选", "Filter") : null}
          />
          {appState.currentUser && (
            <Button
              type="button"
              className={`${listStyle.mySubmissions} ${wide ? "labeled icon" : ""}`}
              primary
              icon="user"
              title={tr("我的 Hack", "My hacks")}
              content={wide ? tr("我的 Hack", "My hacks") : null}
              onClick={() => filter(true)}
            />
          )}
          <Button type="button" icon="refresh" loading={busy} onClick={refresh} title={tr("刷新", "Refresh")} />
        </Form.Group>
      </Form>
      <div className={style.tableScroll} aria-busy={busy}>
        <Table textAlign="center" basic="very" unstackable fixed className={`${listStyle.table} ${style.hackTable}`}>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell textAlign="left" className={style.statusColumn}>
                {tr("状态", "Status")}
              </Table.HeaderCell>
              <Table.HeaderCell>{tr("提交编号", "Submission")}</Table.HeaderCell>
              <Table.HeaderCell className={style.problemColumn}>{tr("题目", "Problem")}</Table.HeaderCell>
              <Table.HeaderCell>{tr("提交者", "Submitter")}</Table.HeaderCell>
              <Table.HeaderCell>Hacker</Table.HeaderCell>
              <Table.HeaderCell>{tr("运行时间", "Runtime")}</Table.HeaderCell>
              <Table.HeaderCell>{tr("运行内存", "Memory")}</Table.HeaderCell>
              <Table.HeaderCell>{tr("Hack 时间", "Hack time")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.hacks.map(record => {
              const time = friendlyFormatDateTime(record.createTime);
              return (
                <Table.Row key={record.id}>
                  <Table.Cell textAlign="left">
                    <HackPreviewLink hackId={record.id} className={style[`status${record.status}`]}>
                      {statusText(record.status)}
                    </HackPreviewLink>
                  </Table.Cell>
                  <Table.Cell>
                    <SubmissionPreviewLink
                      submissionId={record.submissionId}
                      contestId={record.contestId}
                      href={submissionUrl(record)}
                    >
                      #{record.submissionId}
                    </SubmissionPreviewLink>
                  </Table.Cell>
                  <Table.Cell>
                    <Link href={problemUrl(record)}>
                      P{record.problemId}
                      {record.problemTitle ? ` ${record.problemTitle}` : ""}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    <Link href={`/u/${encodeURIComponent(record.submitter.username)}`}>
                      {record.submitter.username}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    <Link href={`/u/${encodeURIComponent(record.hacker.username)}`}>{record.hacker.username}</Link>
                  </Table.Cell>
                  <Table.Cell>{record.timeUsed == null ? "—" : `${Math.round(record.timeUsed)} ms`}</Table.Cell>
                  <Table.Cell title={record.memoryUsed == null ? undefined : `${record.memoryUsed} KiB`}>
                    {record.memoryUsed == null ? "—" : formatFileSize(record.memoryUsed * 1024, 1)}
                  </Table.Cell>
                  <Table.Cell title={time[1]}>
                    <HackPreviewLink hackId={record.id}>{time[0]}</HackPreviewLink>
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      </div>
      {(query.page > 1 || (query.page || 1) * data.pageSize < data.total) && (
        <div className={listStyle.pagination}>
          <SimplePagination
            hasPrevPage={(query.page || 1) > 1}
            hasNextPage={(query.page || 1) * data.pageSize < data.total}
            pageUrl={direction => queryUrl({ ...query, page: (query.page || 1) + direction })}
          />
        </div>
      )}
    </>
  );
  return detail ? (
    <ContestFrame detail={detail} tab="hacks">
      {content}
    </ContestFrame>
  ) : (
    content
  );
});
export default defineRoute(async request => {
  const contestId = positiveId(request.params.contestId),
    query = normalizeQuery(request.query),
    [initial, detail] = await Promise.all([
      hackApi("list", { ...query, contestId }),
      contestId ? callContest("detail", { id: contestId }) : Promise.resolve(undefined)
    ]);
  return (
    <DetailPreviewProvider>
      <HacksPage key={JSON.stringify([contestId, request.query])} query={query} initial={initial} detail={detail} />
    </DetailPreviewProvider>
  );
});
