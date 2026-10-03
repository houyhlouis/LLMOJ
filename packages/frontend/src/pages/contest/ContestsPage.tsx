import React, { useEffect } from "react";
import { Button, Header, Icon, Label, Segment, Table } from "semantic-ui-react";
import { observer } from "mobx-react";
import { defineRoute } from "@/AppRouter";
import { appState } from "@/appState";
import { Link } from "@/utils/hooks";
import { Pagination } from "@/components/Pagination";
import MarkdownContent from "@/markdown/MarkdownContent";
import { callContest, tr, formatDate } from "./api";
import style from "./ContestPages.module.less";

const ContestsPage = observer(({ data, page }: { data: any; page: number }) => {
  useEffect(() => {
    appState.enterNewPage(tr("比赛", "Contests"), "contests");
  }, [appState.locale]);
  const pagination = (top = false) =>
    data.total <= 30 ? null : (
      <div className={`${style.pagination}${top ? ` ${style.topPagination}` : ""}`}>
        {data.total > 30 && (
          <Pagination
            currentPage={page}
            totalCount={data.total}
            itemsPerPage={30}
            pageUrl={newPage => ({ pathname: "/contests", query: { page: String(newPage) } })}
          />
        )}
      </div>
    );
  return (
    <>
      <div className={style.headerRow}>
        <Header as="h2" className={style.toolbarTitle}>
          {tr("比赛", "Contests")}
        </Header>
        <div className={style.headerRightControls}>
          {data.canCreate && (
            <Button
              className="labeled icon"
              icon="plus"
              content={tr("创建比赛", "Create contest")}
              as={Link}
              href="/contest/new"
            />
          )}
        </div>
      </div>
      {pagination(true)}
      {!data.total ? (
        <Segment placeholder>
          <Header icon>
            <Icon name="trophy" />
            {tr("暂无比赛", "No contests yet")}
          </Header>
          {data.canCreate && (
            <Segment.Inline>
              <Button primary as={Link} href="/contest/new">
                {tr("创建比赛", "Create contest")}
              </Button>
            </Segment.Inline>
          )}
        </Segment>
      ) : (
        <div className={style.tableScroll}>
          <Table basic="very" textAlign="center" unstackable>
            <Table.Header>
              <Table.Row className={style.tableHeaderRow}>
                <Table.HeaderCell textAlign="left">{tr("比赛", "Contest")}</Table.HeaderCell>
                <Table.HeaderCell width={1}>{tr("赛制", "Rule")}</Table.HeaderCell>
                <Table.HeaderCell width={3}>{tr("开始时间", "Start time")}</Table.HeaderCell>
                <Table.HeaderCell width={2}>{tr("状态", "Status")}</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.contests.map((c: any) => (
                <Table.Row key={c.id} className={style.row}>
                  <Table.Cell textAlign="left">
                    <Link href={`/contest/${c.id}`}>{c.title}</Link>
                    {!c.isPublic && (
                      <Label size="small" color="red" basic>
                        {tr("未公开", "Private")}
                      </Label>
                    )}
                    {c.subtitle && (
                      <div className={style.subtitle}>
                        <MarkdownContent content={c.subtitle} />
                      </div>
                    )}
                  </Table.Cell>
                  <Table.Cell>{c.rule.toUpperCase()}</Table.Cell>
                  <Table.Cell className={style.nowrap}>{formatDate(c.startTime)}</Table.Cell>
                  <Table.Cell className={style.nowrap}>
                    {Date.now() < +new Date(c.startTime)
                      ? tr("未开始", "Upcoming")
                      : Date.now() < +new Date(c.endTime)
                      ? tr("进行中", "Running")
                      : tr("已结束", "Ended")}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
      {pagination()}
    </>
  );
});
export default defineRoute(async request => {
  const page = Math.max(1, parseInt(request.query.page) || 1);
  return <ContestsPage data={await callContest("list", { page })} page={page} />;
});
