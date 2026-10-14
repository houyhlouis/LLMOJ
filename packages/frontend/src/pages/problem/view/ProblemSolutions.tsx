import React, { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { Button, Header, Loader, Message, Table } from "semantic-ui-react";

import style from "./ProblemSolutions.module.less";
import api from "@/api";
import { appState } from "@/appState";
import { Link } from "@/utils/hooks";
import UserLink from "@/components/UserLink";
import { Pagination } from "@/components/Pagination";
import formatDateTime from "@/utils/formatDateTime";
import { getNewDiscussionUrl } from "@/pages/discussion/discussions/DiscussionsPage";

export default observer(function ProblemSolutions({ problemId, page = 1 }: { problemId: number; page?: number }) {
  const zh = appState.locale === "zh_CN";
  const [response, setResponse] = useState<ApiTypes.QueryDiscussionsResponseDto>();
  const [error, setError] = useState("");
  const perPage = appState.serverPreference.pagination.discussions;
  useEffect(() => {
    let cancelled = false;
    setResponse(undefined);
    setError("");
    api.discussion
      .queryDiscussions({
        problemId,
        type: "Solution",
        locale: appState.locale,
        skipCount: (page - 1) * perPage,
        takeCount: perPage
      })
      .then(result => {
        if (cancelled) return;
        if (result.requestError || result.response.error)
          setError(
            zh ? "无法读取题解，请检查访问权限后重试。" : "Unable to load solutions. Check your access and retry."
          );
        else setResponse(result.response);
      })
      .catch(() => {
        if (!cancelled) setError(zh ? "题解加载失败，请重试。" : "Failed to load solutions. Please retry.");
      });
    return () => {
      cancelled = true;
    };
  }, [problemId, page, appState.locale, appState.currentUser?.id]);

  return (
    <section className={style.solutions} aria-label={zh ? "题解" : "Solutions"}>
      <div className={style.toolbar}>
        <Header as="h2">{zh ? "题解" : "Solutions"}</Header>
        {response?.permissions.createDiscussion && (
          <Button
            as={Link}
            href={getNewDiscussionUrl(problemId, "Solution")}
            primary
            icon="plus"
            content={zh ? "发表题解" : "Write a solution"}
          />
        )}
      </div>
      {error && <Message negative content={error} />}
      {!response && !error && <Loader active inline="centered" />}
      {response && (
        <>
          <div className={style.tableContainer}>
            <Table basic="very" unstackable>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{zh ? "标题" : "Title"}</Table.HeaderCell>
                  <Table.HeaderCell>{zh ? "作者" : "Author"}</Table.HeaderCell>
                  <Table.HeaderCell textAlign="right">{zh ? "回复" : "Replies"}</Table.HeaderCell>
                  <Table.HeaderCell textAlign="right">{zh ? "更新时间" : "Updated"}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {response.discussions.map(discussion => (
                  <Table.Row key={discussion.meta.id}>
                    <Table.Cell>
                      <Link href={`/d/${discussion.meta.id}`}>{discussion.meta.title}</Link>
                    </Table.Cell>
                    <Table.Cell>
                      <UserLink user={discussion.publisher} />
                    </Table.Cell>
                    <Table.Cell textAlign="right">{discussion.meta.replyCount}</Table.Cell>
                    <Table.Cell textAlign="right">{formatDateTime(discussion.meta.sortTime)[0]}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
          {response.discussions.length === 0 && <p className={style.empty}>{zh ? "暂无题解" : "No solutions yet"}</p>}
          {response.count > perPage && (
            <div className={style.pagination}>
              <Pagination
                totalCount={response.count}
                itemsPerPage={perPage}
                currentPage={page}
                pageUrl={next => ({ query: { tab: "solutions", solutionPage: String(next) } })}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
});
