import React, { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import {
  Button,
  Checkbox,
  Form,
  Header,
  Icon,
  Label,
  Loader,
  Menu,
  Message,
  Modal,
  Progress,
  Segment,
  Table
} from "semantic-ui-react";
import { appState } from "@/appState";
import { Link, useNavigationChecked } from "@/utils/hooks";
import MarkdownContent from "@/markdown/MarkdownContent";
import { uploadTeamFile } from "@/utils/uploadTeamFile";
import TeamMembers from "./TeamMembers";
import ResourceEditor from "./ResourceEditor";
import { dateText, downloadCsv, joinPolicyText, policyOptions, teamApi, tr } from "./api";
import style from "./TeamPage.module.less";
import { actsAsButton } from "@/utils/keyboard";

const bytes = (value: number) =>
  Number(value) >= 1073741824
    ? (Number(value) / 1073741824).toFixed(1) + " GiB"
    : (Number(value) / 1048576).toFixed(1) + " MiB";

export default observer(function TeamPage({
  teamId,
  initialTab = "overview"
}: {
  teamId: number;
  initialTab?: string;
}) {
  const nav = useNavigationChecked();
  const [data, setData] = useState<any>(null),
    [members, setMembers] = useState<any[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [tab, setTab] = useState(initialTab);
  const [filter, setFilter] = useState(""),
    [showArchived, setShowArchived] = useState(false);
  const [editor, setEditor] = useState(""),
    [editorInitial, setEditorInitial] = useState<any>(undefined);
  const [assignment, setAssignment] = useState<any>(null),
    [settings, setSettings] = useState<any>({});
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [file, setFile] = useState<File>(null),
    [progress, setProgress] = useState<number>(null);
  const fileInput = useRef<HTMLInputElement>(null),
    generation = useRef(0),
    sessionVersion = useRef(0),
    uploadAbort = useRef<AbortController>(null);
  function captureSession() {
    const version = sessionVersion.current,
      token = appState.token;
    return () => version === sessionVersion.current && token === appState.token;
  }
  async function refresh() {
    const isCurrent = captureSession();
    const key = ++generation.current,
      result = await teamApi("get", { teamId });
    if (!isCurrent() || key !== generation.current) return;
    setData(result);
    setAssignment(null);
    setSettings({
      name: result.team.name,
      description: result.team.description || "",
      announcement: result.team.announcement || "",
      joinPolicy: result.team.joinPolicy,
      groupChangeLocked: result.team.groupChangeLocked,
      archived: result.team.archived
    });
    if (result.membership?.status === "member" || appState.currentUserHasPrivilege("ManageTeams")) {
      const m = await teamApi("members", { teamId });
      if (isCurrent() && key === generation.current) setMembers(m.members);
    } else setMembers([]);
  }
  useEffect(() => {
    const isCurrent = captureSession();
    setData(null);
    setAssignment(null);
    setMembers([]);
    setEditor("");
    setEditorInitial(undefined);
    setFile(null);
    setProgress(null);
    setLeaveOpen(false);
    if (fileInput.current) fileInput.current.value = "";
    setError("");
    setBusy(true);
    refresh()
      .catch(e => {
        if (isCurrent()) setError(e.message);
      })
      .finally(() => {
        if (isCurrent()) setBusy(false);
      });
    return () => {
      ++generation.current;
      ++sessionVersion.current;
      uploadAbort.current?.abort();
    };
  }, [teamId, appState.token]);
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);
  useEffect(() => {
    if (data) appState.enterNewPage(data.team.name, "members");
  }, [data?.team?.name, appState.locale]);
  async function run(action: string, body: any = {}) {
    const isCurrent = captureSession();
    setBusy(true);
    setError("");
    try {
      const result = await teamApi(action, { teamId, ...body });
      if (!isCurrent()) return null;
      await refresh();
      return isCurrent() ? result : null;
    } catch (e) {
      if (isCurrent()) setError(e.message);
      return null;
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  function openEditor(mode: string, initial?: any) {
    setError("");
    setEditorInitial(initial);
    setEditor(mode);
  }
  async function readAssignment(id: number) {
    const isCurrent = captureSession(),
      key = generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await teamApi("assignment", { teamId, id });
      if (isCurrent() && key === generation.current) setAssignment(result);
    } catch (e) {
      if (isCurrent() && key === generation.current) setError(e.message);
    } finally {
      if (isCurrent() && key === generation.current) setBusy(false);
    }
  }
  async function saveResource(action: string, body: any) {
    const r = await run(action, body);
    if (!r) return;
    setEditor("");
    if (r.problemId) await nav.navigate("/p/id/" + r.problemId + "/edit");
    else if (r.contestId) await nav.navigate("/contest/" + r.contestId + "/edit");
    else if (r.discussionId) await nav.navigate("/d/" + r.discussionId);
    else if (action === "saveAssignment") await readAssignment(r.id ?? body.id);
  }
  async function exportScores() {
    const isCurrent = captureSession(),
      key = generation.current;
    setBusy(true);
    setError("");
    try {
      const r = await teamApi("exportAssignment", { teamId, id: assignment.assignment.id });
      if (isCurrent() && key === generation.current) downloadCsv(r.filename, r.csv);
    } catch (e) {
      if (isCurrent() && key === generation.current) setError(e.message);
    } finally {
      if (isCurrent() && key === generation.current) setBusy(false);
    }
  }
  async function upload() {
    if (!file) return;
    const isCurrent = captureSession(),
      controller = new AbortController(),
      uploadToken = appState.token;
    if (file.size + data.team.quotaUsed > data.team.quotaLimit) {
      setError(tr("团队剩余空间不足。", "The team does not have enough free space."));
      return;
    }
    setBusy(true);
    setError("");
    setProgress(0);
    uploadAbort.current = controller;
    try {
      await uploadTeamFile({
        teamId,
        file,
        request: (action, body) => {
          if (!isCurrent() && !(action === "cancelFileUpload" && uploadToken === appState.token))
            throw new DOMException("Upload cancelled", "AbortError");
          return teamApi(action, body);
        },
        signal: controller.signal,
        onProgress: p => {
          if (isCurrent()) setProgress(p * 100);
        }
      });
      if (controller.signal.aborted || !isCurrent()) return;
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      await refresh();
    } catch (e) {
      if (isCurrent() && !controller.signal.aborted)
        setError(
          ["File upload failed", "Invalid upload session"].includes(e.message)
            ? tr("上传失败，请重试。", "Upload failed. Please retry.")
            : e.message
        );
    } finally {
      if (uploadAbort.current === controller) uploadAbort.current = null;
      if (isCurrent()) {
        setBusy(false);
        setProgress(null);
      }
    }
  }
  async function download(id: number) {
    const isCurrent = captureSession(),
      key = generation.current;
    setError("");
    try {
      const r = await teamApi("downloadFile", { teamId, id });
      if (isCurrent() && key === generation.current) window.location.assign(r.url);
    } catch (e) {
      if (isCurrent() && key === generation.current) setError(e.message);
    }
  }
  if (!data)
    return (
      <div className={style.page}>
        {busy && <Loader active inline="centered" />}
        {error && <Message negative content={error} />}
        {error && (
          <Button as={Link} href="/teams">
            {tr("我的团队", "My teams")}
          </Button>
        )}
      </div>
    );
  const { team, membership, permissions = [], groups = [], resources = {} } = data;
  const member =
    (membership?.status === "member" && membership.userId === appState.currentUser?.id) ||
    appState.currentUserHasPrivilege("ManageTeams");
  if (!member)
    return (
      <div className={style.page}>
        <div className={style.toolbar}>
          <Header as="h1">
            <Icon name="users" />
            <Header.Content>{team.name}</Header.Content>
          </Header>
          <Label>#{team.id}</Label>
          <Button as={Link} href="/teams">
            {tr("我的团队", "My teams")}
          </Button>
        </div>
        <Segment>
          <Message info content={tr("你的申请正在等待审核。", "Your application is awaiting approval.")} />
          {membership.application && (
            <>
              <Header as="h3">{tr("我的申请理由", "My application message")}</Header>
              <p className={style.application}>{membership.application}</p>
            </>
          )}
          {error && <Message negative content={error} />}
          <Button
            disabled={busy}
            loading={busy}
            onClick={async () => {
              const isCurrent = captureSession();
              setBusy(true);
              setError("");
              try {
                await teamApi("leave", { teamId });
                if (isCurrent()) await nav.navigate("/teams");
              } catch (e) {
                if (isCurrent()) setError(e.message);
              } finally {
                if (isCurrent()) setBusy(false);
              }
            }}
          >
            {tr("撤回申请", "Withdraw application")}
          </Button>
        </Segment>
      </div>
    );
  const can = (permission: string) => permissions.includes(permission);
  const activeTab = !member || (tab === "settings" && !can("settings")) ? "overview" : tab;
  const visible = (rows: any[] = []) =>
    rows.filter(
      row =>
        (showArchived || !row.archived) &&
        String(row.title || row.name || "")
          .toLowerCase()
          .includes(filter.toLowerCase())
    );
  const archive = (kind: string, row: any) =>
    kind === "file"
      ? run("archiveFile", { id: row.id, archived: !row.archived })
      : run("archiveResource", { kind, resourceId: row.resourceId ?? row.id, archived: !row.archived });
  const tabs = [
    ["overview", tr("概览", "Overview")],
    ["members", tr("成员", "Members")],
    ["problems", tr("题库", "Problems")],
    ["contests", tr("比赛", "Contests")],
    ["assignments", tr("题单与作业", "Lists and assignments")],
    ["discussions", tr("讨论", "Discussions")],
    ["files", tr("文件", "Files")],
    ...(can("settings") ? [["settings", tr("设置", "Settings")]] : [])
  ];
  const empty = <div className={style.empty}>{tr("暂无内容。", "No content yet.")}</div>;
  const searchToolbar = (
    <div className={style.actions}>
      <Form.Input
        icon="search"
        placeholder={tr("搜索", "Search")}
        value={filter}
        onChange={(_, d) => setFilter(d.value)}
      />
      <Checkbox
        label={tr("显示已归档", "Show archived")}
        checked={showArchived}
        onChange={(_, d) => setShowArchived(!!d.checked)}
      />
    </div>
  );
  return (
    <div className={style.page}>
      <div className={style.toolbar}>
        <Header as="h1">
          <Icon name="users" />
          <Header.Content>{team.name}</Header.Content>
        </Header>
        <Label>#{team.id}</Label>
        <Label>
          {team.memberCount} {tr("成员", "members")}
        </Label>
        <Label>{joinPolicyText(team.joinPolicy)}</Label>
        {team.archived && <Label>{tr("已归档", "Archived")}</Label>}
        <Button as={Link} href="/teams">
          {tr("我的团队", "My teams")}
        </Button>
        {membership?.status === "member" &&
          membership.userId === appState.currentUser?.id &&
          !team.archived &&
          team.ownerId !== appState.currentUser?.id && (
            <Button disabled={busy} onClick={() => setLeaveOpen(true)}>
              {tr("退出团队", "Leave team")}
            </Button>
          )}
      </div>
      <div className={style.tabs}>
        <Menu secondary pointing>
          {tabs
            .filter(([key]) => member || key === "overview")
            .map(([key, text]) => (
              <Menu.Item
                {...actsAsButton}
                key={key}
                active={activeTab === key}
                onClick={() => {
                  setTab(key);
                  setFilter("");
                  setAssignment(null);
                  nav.navigate("/teams/" + teamId + "?tab=" + key);
                }}
              >
                {text}
              </Menu.Item>
            ))}
        </Menu>
      </div>
      {error && <Message negative content={error} />}
      {busy && <Loader active inline="centered" />}
      {team.archived && (
        <Message
          info
          content={tr(
            "团队已归档。团主可在设置中恢复。",
            "The team is archived. Its owner can restore it in settings."
          )}
        />
      )}
      {activeTab === "overview" && (
        <Segment>
          <Header as="h3">{tr("团队公告", "Announcement")}</Header>
          <MarkdownContent content={team.announcement || tr("暂无公告。", "No announcement yet.")} />
          <Header as="h3">{tr("团队简介", "About")}</Header>
          <div className={style.description}>
            <MarkdownContent content={team.description || ""} />
          </div>
        </Segment>
      )}
      {member && activeTab === "members" && (
        <TeamMembers
          teamId={teamId}
          team={team}
          membership={membership}
          permissions={permissions}
          members={members}
          groups={groups}
          busy={busy}
          run={run}
          error={error}
        />
      )}
      {member && ["problems", "contests", "discussions"].includes(activeTab) && (
        <>
          <div className={style.actions}>
            {(can(activeTab) || activeTab === "discussions") && !team.archived && (
              <Button
                primary
                icon="plus"
                content={tr("新建", "Create")}
                disabled={busy}
                onClick={() =>
                  openEditor({ problems: "problem", contests: "contest", discussions: "discussion" }[activeTab])
                }
              />
            )}
          </div>
          {searchToolbar}
          <Table basic="very">
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{tr("标题", "Title")}</Table.HeaderCell>
                <Table.HeaderCell>{tr("操作", "Actions")}</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {visible(resources[activeTab]).map(row => (
                <Table.Row key={row.id}>
                  <Table.Cell>
                    <Link
                      href={
                        activeTab === "problems"
                          ? "/p/id/" + row.id
                          : activeTab === "contests"
                            ? "/contest/" + row.id
                            : "/d/" + row.id
                      }
                    >
                      {row.title || "#" + row.id}
                    </Link>
                    {row.archived && <Label size="mini">{tr("已归档", "Archived")}</Label>}
                    {activeTab === "contests" && (
                      <Label size="mini">
                        {
                          {
                            private: tr("内部", "Team only"),
                            public: tr("公开", "Public"),
                            invite: tr("邀请", "Invitation")
                          }[row.visibility]
                        }
                      </Label>
                    )}
                    {activeTab === "contests" && row.inviteCode && (
                      <div className={style.token}>{window.location.origin + "/contest-invite/" + row.inviteCode}</div>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    {can(activeTab) && !team.archived && (
                      <div className={style.rowActions}>
                        {!row.archived && (
                          <Button
                            size="mini"
                            as={Link}
                            href={
                              activeTab === "problems"
                                ? "/p/id/" + row.id + "/edit"
                                : activeTab === "contests"
                                  ? "/contest/" + row.id + "/edit"
                                  : "/d/" + row.id + "/edit"
                            }
                          >
                            {tr("编辑", "Edit")}
                          </Button>
                        )}
                        {activeTab === "contests" && !row.archived && (
                          <Button
                            size="mini"
                            onClick={() =>
                              openEditor("contestAccess", {
                                ...row,
                                invitedUsers: (row.invitedUserIds || []).join(",")
                              })
                            }
                          >
                            {tr("访问设置", "Access")}
                          </Button>
                        )}
                        <Button
                          size="mini"
                          disabled={busy}
                          onClick={() =>
                            archive(
                              { problems: "problem", contests: "contest", discussions: "discussion" }[activeTab],
                              row
                            )
                          }
                        >
                          {row.archived ? tr("恢复", "Restore") : tr("归档", "Archive")}
                        </Button>
                      </div>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
          {!visible(resources[activeTab]).length && empty}
        </>
      )}
      {member &&
        activeTab === "assignments" &&
        (assignment ? (
          <>
            <div className={style.toolbar}>
              <Header as="h2">{assignment.assignment.title}</Header>
              <Button onClick={() => setAssignment(null)}>{tr("返回列表", "Back")}</Button>
              {can("assignments") && !team.archived && (
                <Button onClick={() => openEditor("assignment", assignment.assignment)}>{tr("编辑", "Edit")}</Button>
              )}
              {assignment.canManage && (
                <Button
                  disabled={busy}
                  icon="download"
                  content={tr("导出成绩", "Export scores")}
                  onClick={exportScores}
                />
              )}
            </div>
            <Label>{dateText(assignment.assignment.deadline)}</Label>
            <div className={style.description}>
              <MarkdownContent content={assignment.assignment.description || ""} />
            </div>
            <Table basic="very">
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{tr("题目", "Problem")}</Table.HeaderCell>
                  <Table.HeaderCell>{tr("分节 / 备注", "Section / note")}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {(assignment.details || []).map(item => (
                  <Table.Row key={item.problemId}>
                    <Table.Cell>
                      {item.unavailable ? (
                        tr("题目暂不可用", "Problem unavailable")
                      ) : (
                        <Link href={"/p/id/" + item.problemId}>{item.title || "#" + item.problemId}</Link>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      {item.section}
                      <MarkdownContent content={item.note || ""} />
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
            <Header as="h3">{tr("完成情况", "Progress")}</Header>
            <div className={style.table}>
              <Table basic="very" unstackable>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>{tr("成员", "Member")}</Table.HeaderCell>
                    <Table.HeaderCell>{tr("总分", "Total")}</Table.HeaderCell>
                    {(assignment.details || []).map(item => (
                      <Table.HeaderCell key={item.problemId}>{item.title || "#" + item.problemId}</Table.HeaderCell>
                    ))}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {(assignment.rows || []).map(row => (
                    <Table.Row key={row.userId}>
                      <Table.Cell>
                        <Link href={"/u/" + row.username}>{row.note || row.username}</Link>
                      </Table.Cell>
                      <Table.Cell>{row.total}</Table.Cell>
                      {(assignment.details || []).map(item => {
                        const score = row.problems?.[item.problemId];
                        return (
                          <Table.Cell key={item.problemId}>
                            {score?.submissionId ? (
                              <Link href={"/s/" + score.submissionId}>
                                <Icon
                                  name={score.accepted ? "check" : "circle outline"}
                                  color={score.accepted ? "green" : undefined}
                                />
                                {score.score}
                              </Link>
                            ) : (
                              "—"
                            )}
                          </Table.Cell>
                        );
                      })}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          </>
        ) : (
          <>
            <div className={style.actions}>
              {can("assignments") && !team.archived && (
                <Button
                  primary
                  icon="plus"
                  content={tr("新建题单 / 作业", "Create list / assignment")}
                  onClick={() => openEditor("assignment")}
                />
              )}
            </div>
            {searchToolbar}
            <Table basic="very">
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{tr("标题", "Title")}</Table.HeaderCell>
                  <Table.HeaderCell>{tr("题目数", "Problems")}</Table.HeaderCell>
                  <Table.HeaderCell>{tr("截止时间", "Deadline")}</Table.HeaderCell>
                  <Table.HeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {visible(resources.assignments).map(row => (
                  <Table.Row key={row.id}>
                    <Table.Cell>
                      <Button basic onClick={() => readAssignment(row.id)}>
                        {row.title}
                      </Button>
                      {row.archived && <Label>{tr("已归档", "Archived")}</Label>}
                    </Table.Cell>
                    <Table.Cell>{row.itemCount}</Table.Cell>
                    <Table.Cell>{dateText(row.deadline)}</Table.Cell>
                    <Table.Cell>
                      {can("assignments") && !team.archived && (
                        <Button size="mini" disabled={busy} onClick={() => archive("assignment", row)}>
                          {row.archived ? tr("恢复", "Restore") : tr("归档", "Archive")}
                        </Button>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
            {!visible(resources.assignments).length && empty}
          </>
        ))}
      {member && activeTab === "files" && (
        <>
          <Message
            info
            content={
              tr("文件仅对团队成员可见。", "Files are visible to team members.") +
              " " +
              bytes(team.quotaUsed) +
              " / " +
              bytes(team.quotaLimit) +
              " · " +
              tr(
                "无单文件大小限制，上传占用团队剩余空间。",
                "No separate per-file limit; uploads use the team's remaining space."
              )
            }
          />
          {!team.archived && (
            <div className={style.actions}>
              <input
                ref={fileInput}
                type="file"
                aria-label={tr("选择文件", "Select file")}
                disabled={busy}
                onChange={e => setFile(e.target.files?.[0] || null)}
              />
              <Button
                primary
                icon="upload"
                content={tr("上传文件", "Upload file")}
                disabled={!file || busy}
                loading={progress !== null}
                onClick={upload}
              />
              {progress !== null && (
                <Button content={tr("取消上传", "Cancel upload")} onClick={() => uploadAbort.current?.abort()} />
              )}
            </div>
          )}
          {progress !== null && <Progress percent={Math.round(progress)} progress />}
          {searchToolbar}
          <Table basic="very">
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{tr("文件名", "Filename")}</Table.HeaderCell>
                <Table.HeaderCell>{tr("大小", "Size")}</Table.HeaderCell>
                <Table.HeaderCell>{tr("上传时间", "Uploaded")}</Table.HeaderCell>
                <Table.HeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {visible(resources.files).map(row => (
                <Table.Row key={row.id}>
                  <Table.Cell>
                    {row.name}
                    {row.archived && <Label>{tr("已归档", "Archived")}</Label>}
                  </Table.Cell>
                  <Table.Cell>{bytes(row.size)}</Table.Cell>
                  <Table.Cell>{dateText(row.createdAt)}</Table.Cell>
                  <Table.Cell>
                    <div className={style.rowActions}>
                      {!row.archived && (
                        <Button
                          size="mini"
                          icon="download"
                          content={tr("下载", "Download")}
                          onClick={() => download(row.id)}
                        />
                      )}
                      {can("files") && !team.archived && (
                        <Button size="mini" disabled={busy} onClick={() => archive("file", row)}>
                          {row.archived ? tr("恢复", "Restore") : tr("归档", "Archive")}
                        </Button>
                      )}
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
          {!visible(resources.files).length && empty}
        </>
      )}
      {member && activeTab === "settings" && can("settings") && (
        <Form onSubmit={() => run("save", settings)}>
          <Form.Input
            required
            label={tr("团队名称", "Team name")}
            maxLength={80}
            value={settings.name}
            onChange={(_, d) => setSettings({ ...settings, name: d.value })}
          />
          <Form.TextArea
            rows={6}
            label={tr("简介（Markdown）", "Description (Markdown)")}
            value={settings.description}
            onChange={(_, d) => setSettings({ ...settings, description: String(d.value) })}
          />
          <Form.TextArea
            rows={8}
            label={tr("公告（Markdown）", "Announcement (Markdown)")}
            value={settings.announcement}
            onChange={(_, d) => setSettings({ ...settings, announcement: String(d.value) })}
          />
          <Form.Select
            label={tr("加入方式", "Join policy")}
            options={policyOptions()}
            value={settings.joinPolicy}
            onChange={(_, d) => setSettings({ ...settings, joinPolicy: d.value })}
          />
          <Form.Checkbox
            label={tr("禁止成员自行更换分组", "Prevent members from changing groups")}
            checked={settings.groupChangeLocked}
            onChange={(_, d) => setSettings({ ...settings, groupChangeLocked: d.checked })}
          />
          {(team.ownerId === appState.currentUser?.id || appState.currentUserHasPrivilege("ManageTeams")) && (
            <Form.Checkbox
              label={tr("归档团队（可恢复并保留内容）", "Archive team (recoverable; content retained)")}
              checked={settings.archived}
              onChange={(_, d) => setSettings({ ...settings, archived: d.checked })}
            />
          )}
          <Button primary loading={busy} disabled={busy}>
            {tr("保存设置", "Save settings")}
          </Button>
        </Form>
      )}
      <ResourceEditor
        mode={member ? editor : ""}
        initial={editorInitial}
        members={members}
        groups={groups}
        problems={resources.problems || []}
        busy={busy}
        error={error}
        onClose={() => setEditor("")}
        onSave={saveResource}
      />
      <Modal size="small" open={leaveOpen} onClose={() => setLeaveOpen(false)}>
        <Modal.Header>{tr("退出团队", "Leave team")}</Modal.Header>
        <Modal.Content>
          {tr("退出后将失去团队私有内容的访问权限。", "Leaving removes access to the team's private content.")}
        </Modal.Content>
        <Modal.Actions>
          <Button onClick={() => setLeaveOpen(false)}>{tr("取消", "Cancel")}</Button>
          <Button
            negative
            disabled={busy}
            onClick={async () => {
              const isCurrent = captureSession();
              setBusy(true);
              setError("");
              try {
                await teamApi("leave", { teamId });
                if (!isCurrent()) return;
                setData(null);
                setMembers([]);
                setAssignment(null);
                setLeaveOpen(false);
                await nav.navigate("/teams");
              } catch (e) {
                if (isCurrent()) setError(e.message);
              } finally {
                if (isCurrent()) setBusy(false);
              }
            }}
          >
            {tr("确认退出", "Leave team")}
          </Button>
        </Modal.Actions>
      </Modal>
    </div>
  );
});
