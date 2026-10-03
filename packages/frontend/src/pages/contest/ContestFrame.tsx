import React, { useEffect } from "react";
import { Header, Menu, Label } from "semantic-ui-react";
import { observer } from "mobx-react";
import { appState } from "@/appState";
import { Link } from "@/utils/hooks";
import { tr, formatDate } from "./api";
import style from "./ContestPages.module.less";

export default observer(function ContestFrame({
  detail,
  tab,
  children
}: {
  detail: any;
  tab: string;
  children: React.ReactNode;
}) {
  const { contest } = detail;
  useEffect(() => {
    appState.enterNewPage(`${contest.title} - ${tr("比赛", "Contests")}`, "contests");
  }, [contest.id, appState.locale]);
  const base = `/contest/${contest.id}`;
  return (
    <>
      <Header as="h1">
        {contest.title}
        <Header.Subheader>
          <Label>{contest.rule.toUpperCase()}</Label> {formatDate(contest.startTime)} — {formatDate(contest.endTime)}
        </Header.Subheader>
      </Header>
      <Menu pointing secondary stackable>
        <Menu.Item as={Link} href={base} active={tab === "overview"}>
          {tr("概览", "Overview")}
        </Menu.Item>
        {detail.canRank && (
          <Menu.Item as={Link} href={`${base}/ranklist`} active={tab === "ranklist"}>
            {tr("排名", "Standings")}
          </Menu.Item>
        )}
        <Menu.Item as={Link} href={`${base}/submissions`} active={tab === "submissions"}>
          {tr("提交记录", "Submissions")}
        </Menu.Item>
        {appState.currentUser && (
          <Menu.Item as={Link} href={`${base}/summary`} active={tab === "summary"}>
            {tr("比赛总结", "Summary")}
          </Menu.Item>
        )}
        {detail.manager && (
          <Menu.Item as={Link} href={`${base}/edit`} active={tab === "edit"}>
            {tr("管理", "Manage")}
          </Menu.Item>
        )}
        <Menu.Menu position="right">
          <Menu.Item as={Link} href="/contests">
            {tr("全部比赛", "All contests")}
          </Menu.Item>
        </Menu.Menu>
      </Menu>
      <div className={style.pageContent}>{children}</div>
    </>
  );
});
