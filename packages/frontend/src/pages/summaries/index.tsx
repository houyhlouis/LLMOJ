import React, { useEffect } from "react";
import { FormattedNumber } from "react-intl";
import { Header, Segment } from "semantic-ui-react";
import { observer } from "mobx-react";
import { defineRoute } from "@/AppRouter";
import { appState } from "@/appState";
import { Link } from "@/utils/hooks";
import { Pagination } from "@/components/Pagination";
import MarkdownContent from "@/markdown/MarkdownContent";
import { callContest, tr, formatDate } from "../contest/api";
import style from "../contest/ContestPages.module.less";

// Compensate accumulated rounding error before formatting the displayed total.
function totalMinutes(problems: { minutes: number }[]) {
  let total = 0;
  let correction = 0;
  for (const { minutes } of problems) {
    const adjusted = minutes - correction;
    const next = total + adjusted;
    correction = next - total - adjusted;
    total = next;
  }
  return total;
}

const SummariesPage = observer(({ data, page }: { data: any; page: number }) => {
  useEffect(() => {
    appState.enterNewPage(tr("我的总结", "My Summaries"), null);
  }, [appState.locale]);
  const pagination = (top = false) =>
    data.total <= 30 ? null : (
      <div className={`${style.pagination}${top ? ` ${style.topPagination}` : ""}`}>
        {data.total > 30 && (
          <Pagination
            currentPage={page}
            totalCount={data.total}
            itemsPerPage={30}
            pageUrl={newPage => ({ pathname: "/summaries", query: { page: String(newPage) } })}
          />
        )}
      </div>
    );
  return (
    <>
      <div className={style.headerRow}>
        <Header as="h2" className={style.toolbarTitle}>
          {tr("我的总结", "My Summaries")}
        </Header>
      </div>
      {pagination(true)}
      {!data.total ? (
        <Segment placeholder>
          <Header>{tr("暂无比赛总结", "No summaries yet")}</Header>
          <p>{tr("进入比赛的总结页面即可撰写。", "Open a contest's Summary page to write one.")}</p>
        </Segment>
      ) : (
        <div>
          {data.summaries.map((s: any) => (
            <article key={s.id} className={style.summaryEntry}>
              <Header as="h3">
                <Link href={`/contest/${s.contestId}/summary`}>{s.title}</Link>
                <Header.Subheader>
                  {formatDate(s.updatedAt)} · {tr("总耗时", "Total time")}:{" "}
                  <FormattedNumber value={totalMinutes(s.problems)} maximumSignificantDigits={15} />{" "}
                  {tr("分钟", "minutes")}
                </Header.Subheader>
              </Header>
              <MarkdownContent content={s.content} />
            </article>
          ))}
        </div>
      )}
      {pagination()}
    </>
  );
});
export default defineRoute(async request => {
  const page = Math.max(1, parseInt(request.query.page) || 1);
  return <SummariesPage data={await callContest("summaries", { page })} page={page} />;
});
