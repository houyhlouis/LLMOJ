import React, { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { Button, Form, Header, Icon, Label, Loader, Message, Modal, Segment, Table } from "semantic-ui-react";
import { appState } from "@/appState";
import { Link, useNavigationChecked } from "@/utils/hooks";
import { joinPolicyText, policyOptions, teamApi, tr } from "./api";
import style from "./TeamPage.module.less";

export default observer(function TeamList() {
  const nav = useNavigationChecked();
  const [teams, setTeams] = useState<any[]>([]),
    [total, setTotal] = useState(0),
    [pageSize, setPageSize] = useState(30),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0);
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [policy, setPolicy] = useState("approval");
  const [joinId, setJoinId] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [reason, setReason] = useState("");
  const sessionVersion = useRef(0);
  function captureSession() {
    const version = sessionVersion.current,
      token = appState.token;
    return () => version === sessionVersion.current && token === appState.token;
  }
  useEffect(() => {
    const isCurrent = captureSession();
    appState.enterNewPage(tr("我的团队", "My teams"), "members");
    setTeams([]);
    setTotal(0);
    setPreview(null);
    setError("");
    if (!appState.currentUser) {
      setBusy(false);
      return () => {
        ++sessionVersion.current;
      };
    }
    setBusy(true);
    teamApi("list?mine=1&query=" + encodeURIComponent(search) + "&page=" + page)
      .then(r => {
        if (isCurrent()) {
          setTeams(r.teams);
          setTotal(r.total);
          setPageSize(r.pageSize || 30);
        }
      })
      .catch(e => {
        if (isCurrent()) setError(e.message);
      })
      .finally(() => {
        if (isCurrent()) setBusy(false);
      });
    return () => {
      ++sessionVersion.current;
    };
  }, [search, page, revision, appState.locale, appState.token]);
  async function action(callback: () => Promise<void>) {
    const isCurrent = captureSession();
    setBusy(true);
    setError("");
    try {
      await callback();
    } catch (e) {
      if (isCurrent()) setError(e.message);
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  async function findTeam() {
    const teamId = Number(joinId),
      isCurrent = captureSession();
    if (!Number.isSafeInteger(teamId) || teamId < 1) {
      setError(tr("请输入有效的团队编号。", "Enter a valid team ID."));
      return;
    }
    await action(async () => {
      const result = await teamApi("joinPreview", { teamId });
      if (isCurrent()) {
        setPreview(result);
        setReason(result.membership?.application || "");
      }
    });
  }
  async function joinTeam() {
    const isCurrent = captureSession();
    await action(async () => {
      const result = await teamApi("join", { teamId: preview.team.id, message: reason });
      if (!isCurrent()) return;
      setPreview(null);
      if (result.status === "member") await nav.navigate("/teams/" + preview.team.id);
      else setRevision(value => value + 1);
    });
  }
  async function create() {
    const isCurrent = captureSession();
    await action(async () => {
      const result = await teamApi("create", { name, description, joinPolicy: policy });
      if (isCurrent()) await nav.navigate("/teams/" + result.teamId);
    });
  }
  return (
    <div className={style.page}>
      <div className={style.toolbar}>
        <Header as="h1">
          <Icon name="users" />
          <Header.Content>{tr("我的团队", "My teams")}</Header.Content>
        </Header>
        {appState.currentUser && (
          <Button as={Link} href={"/u/" + appState.currentUser.username}>
            {tr("个人主页", "My profile")}
          </Button>
        )}
        {appState.currentUserHasPrivilege("CreateTeam") && (
          <Button primary icon="plus" content={tr("创建团队", "Create team")} onClick={() => setCreating(true)} />
        )}
      </div>
      {!appState.currentUser ? (
        <Segment>
          <p>{tr("登录后查看自己的团队，或输入编号加入团队。", "Sign in to view your teams or join a team by ID.")}</p>
          <Button primary as={Link} href="/login">
            {tr("登录", "Sign in")}
          </Button>
        </Segment>
      ) : (
        <>
          <Segment>
            <Header as="h3">{tr("通过编号加入团队", "Join a team by ID")}</Header>
            <Form onSubmit={findTeam} className={style.joinForm}>
              <Form.Input
                label={tr("团队编号", "Team ID")}
                placeholder={tr("输入团主提供的编号", "Enter the ID provided by its owner")}
                inputMode="numeric"
                value={joinId}
                onChange={(_, d) => setJoinId(d.value)}
              />
              <Button primary type="submit" disabled={busy || !joinId.trim()} loading={busy}>
                {tr("查找并加入", "Find and join")}
              </Button>
            </Form>
          </Segment>
          <Segment>
            <Form
              onSubmit={() => {
                setSearch(query);
                setPage(1);
              }}
            >
              <Form.Input
                action={{ icon: "search", type: "submit", "aria-label": tr("搜索", "Search") }}
                placeholder={tr("搜索我的团队", "Search my teams")}
                value={query}
                onChange={(_, d) => setQuery(d.value)}
              />
            </Form>
            {busy && <Loader active inline="centered" />}
            <div className={style.table}>
              <Table basic="very" unstackable>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>{tr("编号", "ID")}</Table.HeaderCell>
                    <Table.HeaderCell>{tr("团队", "Team")}</Table.HeaderCell>
                    <Table.HeaderCell>{tr("成员", "Members")}</Table.HeaderCell>
                    <Table.HeaderCell>{tr("状态", "Status")}</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {teams.map(team => (
                    <Table.Row key={team.id}>
                      <Table.Cell>#{team.id}</Table.Cell>
                      <Table.Cell>
                        <Link href={"/teams/" + team.id}>{team.name}</Link>
                        {team.archived && <Label size="mini">{tr("已归档", "Archived")}</Label>}
                      </Table.Cell>
                      <Table.Cell>{team.membershipStatus === "member" ? team.memberCount : "—"}</Table.Cell>
                      <Table.Cell>
                        {team.membershipStatus === "applicant"
                          ? tr("等待审核", "Awaiting approval")
                          : tr("已加入", "Member")}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
            {!busy && !teams.length && (
              <div className={style.empty}>{tr("你尚未加入团队。", "You have not joined any teams.")}</div>
            )}
            {total > pageSize && (
              <div className={style.pagination}>
                <Button disabled={page <= 1 || busy} onClick={() => setPage(page - 1)}>
                  {tr("上一页", "Previous")}
                </Button>
                <span>
                  {page} / {Math.ceil(total / pageSize)}
                </span>
                <Button disabled={busy || page * pageSize >= total} onClick={() => setPage(page + 1)}>
                  {tr("下一页", "Next")}
                </Button>
              </div>
            )}
          </Segment>
        </>
      )}
      {error && <Message negative content={error} />}
      <Modal size="small" open={!!preview} onClose={() => setPreview(null)} closeOnDimmerClick={!busy}>
        <Modal.Header>{tr("加入团队", "Join team")}</Modal.Header>
        <Modal.Content>
          <Header as="h3">
            {preview?.team.name} <Label>#{preview?.team.id}</Label>
          </Header>
          <p>{joinPolicyText(preview?.team.joinPolicy)}</p>
          {preview?.membership?.status === "member" ? (
            <Message info content={tr("你已经是该团队的成员。", "You are already a member of this team.")} />
          ) : preview?.membership?.status === "applicant" ? (
            <Message info content={tr("你的申请正在等待审核。", "Your application is awaiting approval.")} />
          ) : preview?.team.joinPolicy === "closed" ? (
            <Message
              info
              content={tr(
                "本团队仅接受邀请，请联系团主获取邀请。",
                "This team accepts invitations only. Ask its owner for an invitation."
              )}
            />
          ) : preview?.team.joinPolicy === "approval" ? (
            <Form>
              <Form.TextArea
                label={tr("申请理由", "Application message")}
                value={reason}
                maxLength={2000}
                onChange={(_, d) => setReason(String(d.value))}
              />
            </Form>
          ) : (
            <p>{tr("确认后直接加入该团队。", "Confirm to join this team immediately.")}</p>
          )}
          {error && <Message negative content={error} />}
        </Modal.Content>
        <Modal.Actions>
          <Button disabled={busy} onClick={() => setPreview(null)}>
            {tr("取消", "Cancel")}
          </Button>
          {preview?.membership?.status === "member" ? (
            <Button primary as={Link} href={"/teams/" + preview?.team.id}>
              {tr("进入团队", "Open team")}
            </Button>
          ) : (
            !preview?.membership &&
            preview?.team.joinPolicy !== "closed" && (
              <Button primary disabled={busy} loading={busy} onClick={joinTeam}>
                {preview?.team.joinPolicy === "approval"
                  ? tr("提交申请", "Apply to join")
                  : tr("确认加入", "Confirm join")}
              </Button>
            )
          )}
        </Modal.Actions>
      </Modal>
      <Modal size="small" open={creating} onClose={() => setCreating(false)} closeOnDimmerClick={!busy}>
        <Modal.Header>{tr("创建团队", "Create team")}</Modal.Header>
        <Modal.Content>
          <Form>
            <Form.Input
              required
              label={tr("团队名称", "Team name")}
              value={name}
              maxLength={80}
              onChange={(_, d) => setName(d.value)}
            />
            <Form.TextArea
              label={tr("简介（Markdown）", "Description (Markdown)")}
              value={description}
              onChange={(_, d) => setDescription(String(d.value))}
            />
            <Form.Select
              label={tr("加入方式", "Join policy")}
              options={policyOptions()}
              value={policy}
              onChange={(_, d) => setPolicy(String(d.value))}
            />
          </Form>
          {error && <Message negative content={error} />}
        </Modal.Content>
        <Modal.Actions>
          <Button disabled={busy} onClick={() => setCreating(false)}>
            {tr("取消", "Cancel")}
          </Button>
          <Button primary disabled={busy || !name.trim()} loading={busy} onClick={create}>
            {tr("创建", "Create")}
          </Button>
        </Modal.Actions>
      </Modal>
    </div>
  );
});
