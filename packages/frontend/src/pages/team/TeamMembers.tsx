import React, { useEffect, useState } from "react";
import { observer } from "mobx-react";
import {
  Button,
  Checkbox,
  Dropdown,
  Form,
  Header,
  Label,
  Loader,
  Message,
  Modal,
  Segment,
  Table
} from "semantic-ui-react";
import { appState } from "@/appState";
import UserLink from "@/components/UserLink";
import UserSearch from "@/components/UserSearch";
import copyToClipboard from "@/utils/copyToClipboard";
import { dateText, teamApi, tr } from "./api";
import style from "./TeamPage.module.less";
import membersStyle from "./TeamMembers.module.less";
import { keyboardMenu } from "@/utils/keyboard";

interface TeamMembersProps {
  teamId: number;
  team: any;
  membership: any;
  permissions: string[];
  members: any[];
  groups: any[];
  busy: boolean;
  run: (action: string, body: any) => Promise<any | null>;
  error: string;
}

const memberStatus = (member: any) => ({ member: "active", applicant: "pending" }[member?.status] || member?.status);
const permissionLabels = () => [
  { value: "settings", text: tr("团队设置", "Team settings") },
  { value: "members", text: tr("成员管理", "Member management") },
  { value: "problems", text: tr("题目管理", "Problem management") },
  { value: "contests", text: tr("比赛管理", "Contest management") },
  { value: "assignments", text: tr("题单与作业", "Study lists and assignments") },
  { value: "discussions", text: tr("讨论管理", "Discussion management") },
  { value: "files", text: tr("文件管理", "File management") }
];

export default observer(function TeamMembers({
  teamId,
  team,
  membership,
  permissions,
  members,
  groups,
  busy,
  run,
  error
}: TeamMembersProps) {
  const owner = appState.currentUser?.id === team.ownerId || appState.currentUserHasPrivilege("ManageTeams");
  const manage = owner || permissions.includes("members");
  const editable = manage && !team.archived;
  const settings = owner || permissions.includes("settings");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [selected, setSelected] = useState<number[]>([]);
  const [editor, setEditor] = useState<any>(null);
  const [confirmation, setConfirmation] = useState<any>(null);
  const [groupId, setGroupId] = useState(0);
  const [note, setNote] = useState("");
  const [grants, setGrants] = useState<string[]>([]);
  const [groupName, setGroupName] = useState("");
  const [groupArchived, setGroupArchived] = useState(false);
  const [targetUser, setTargetUser] = useState<any>(null);
  const [maxUses, setMaxUses] = useState("1");
  const [expiresAt, setExpiresAt] = useState("");
  const [transferAccepted, setTransferAccepted] = useState(false);
  const [invitations, setInvitations] = useState<any[]>([]);
  const [invitationLoading, setInvitationLoading] = useState(false);
  const [localError, setLocalError] = useState("");
  const [notice, setNotice] = useState("");
  const activeGroups = groups.filter(group => !group.archived);
  const groupOptions = [
    { value: 0, text: tr("未分组", "No group") },
    ...activeGroups.map(group => ({ value: group.id, text: group.name }))
  ];
  const groupText = (id: number) => groups.find(group => group.id === id)?.name || tr("未分组", "No group");
  const stateText = (member: any) =>
    ({
      active: tr("正式成员", "Member"),
      pending: tr("待审核", "Pending"),
      blocked: tr("黑名单", "Blocked")
    }[memberStatus(member)] || member.status);
  const filtered = members.filter(member => {
    const query = search.trim().toLowerCase();
    return (
      (statusFilter === "all" || memberStatus(member) === statusFilter) &&
      (groupFilter === "all" || (groupFilter === "none" ? !member.groupId : member.groupId === Number(groupFilter))) &&
      (!query ||
        [member.userMeta?.username, member.userId, member.note, member.application]
          .join(" ")
          .toLowerCase()
          .includes(query))
    );
  });

  useEffect(() => {
    setSelected(ids => ids.filter(id => members.some(member => member.userId === id)));
  }, [members]);
  useEffect(() => {
    setSelected([]);
    setEditor(null);
    setConfirmation(null);
    setLocalError("");
    setNotice("");
  }, [teamId]);
  useEffect(() => {
    let current = true;
    if (!manage) {
      setInvitations([]);
      return;
    }
    setInvitationLoading(true);
    teamApi("invitations", { teamId })
      .then(result => {
        if (current) setInvitations(result.invitations || []);
      })
      .catch(reason => {
        if (current) setLocalError(reason.message);
      })
      .finally(() => {
        if (current) setInvitationLoading(false);
      });
    return () => {
      current = false;
    };
  }, [teamId, manage]);

  async function reloadInvitations() {
    setInvitationLoading(true);
    try {
      const result = await teamApi("invitations", { teamId });
      setInvitations(result.invitations || []);
    } catch (reason) {
      setLocalError(reason.message);
    } finally {
      setInvitationLoading(false);
    }
  }
  function toggle(id: number, checked: boolean) {
    setSelected(ids => (checked ? Array.from(new Set([...ids, id])) : ids.filter(value => value !== id)));
  }
  function eligible(action: string, ids = selected): number[] {
    return ids.filter(id => {
      const member = members.find(item => item.userId === id);
      if (!member) return false;
      if (!["note", "setGroup"].includes(action) && id === team.ownerId) return false;
      if (!["note", "setGroup"].includes(action) && member.permissions?.length && !owner) return false;
      const state = memberStatus(member);
      if (action === "approve" || action === "reject") return state === "pending";
      if (action === "unblock") return state === "blocked";
      if (action === "block") return state !== "blocked";
      return state === "active";
    });
  }
  function openEditor(mode: string, ids: number[] = selected, group?: any) {
    setLocalError("");
    setNotice("");
    const member = ids.length === 1 ? members.find(item => item.userId === ids[0]) : null;
    setGroupId(member?.groupId || 0);
    setNote(member?.note || "");
    setGrants(member?.permissions || []);
    setGroupName(group?.name || "");
    setGroupArchived(!!group?.archived);
    setTargetUser(null);
    setMaxUses("1");
    setExpiresAt("");
    setTransferAccepted(false);
    setEditor({ mode, ids, group });
  }
  async function memberAction(action: string, ids: number[], extra: any = {}) {
    if (ids.length > 1000) {
      setLocalError(
        tr("一次最多管理 1000 位成员，请缩小选择范围。", "Manage up to 1,000 members at a time. Reduce the selection.")
      );
      return null;
    }
    const result = await run("manageMembers", { action, userIds: ids, ...extra });
    if (result !== null) setSelected([]);
    return result;
  }
  function confirmAction(action: string, ids: number[], title: string) {
    setLocalError("");
    setConfirmation({ action, ids, title });
  }
  async function confirm() {
    const result =
      confirmation.action === "deactivateInvitation"
        ? await run("deactivateInvitation", { id: confirmation.id })
        : await memberAction(confirmation.action, confirmation.ids);
    if (result !== null) {
      const invitation = confirmation.action === "deactivateInvitation";
      setConfirmation(null);
      if (invitation) await reloadInvitations();
    }
  }
  async function saveEditor() {
    setLocalError("");
    try {
      let result: any = null;
      if (editor.mode === "note") result = await memberAction("note", editor.ids, { note });
      if (editor.mode === "setGroup") result = await memberAction("setGroup", editor.ids, { groupId: groupId || null });
      if (editor.mode === "permissions")
        result = await memberAction("permissions", editor.ids, { permissions: grants });
      if (editor.mode === "groupEditor")
        result = await run("saveGroup", { id: editor.group?.id, name: groupName.trim(), archived: groupArchived });
      if (editor.mode === "blockUser") {
        if (!targetUser) throw new Error(tr("请选择用户。", "Select a user."));
        result = await memberAction("block", [targetUser.id]);
      }
      if (editor.mode === "transfer") {
        if (!targetUser || !transferAccepted)
          throw new Error(tr("请选择新团主并确认转让。", "Select the new owner and confirm the transfer."));
        result = await run("transfer", { userId: targetUser.id });
      }
      if (editor.mode === "invitation") {
        const uses = targetUser ? 1 : Number(maxUses);
        if (!Number.isSafeInteger(uses) || uses < 1 || uses > 1000)
          throw new Error(tr("邀请次数须为 1 到 1000 的整数。", "Uses must be an integer between 1 and 1,000."));
        if (expiresAt && (!Number.isFinite(+new Date(expiresAt)) || +new Date(expiresAt) <= Date.now()))
          throw new Error(tr("有效期须晚于当前时间。", "Expiry must be in the future."));
        result = await run("createInvitation", {
          userId: targetUser?.id,
          maxUses: uses,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined
        });
      }
      if (result !== null) {
        const invitation = editor.mode === "invitation";
        setEditor(null);
        if (invitation) await reloadInvitations();
      }
    } catch (reason) {
      setLocalError(reason.message);
    }
  }
  const editorTitles = {
    note: tr("编辑成员备注", "Edit member note"),
    setGroup: tr("设置成员分组", "Set member group"),
    permissions: tr("分配管理权限", "Assign management permissions"),
    groupEditor: tr("编辑成员分组", "Edit member group"),
    blockUser: tr("加入黑名单", "Block a user"),
    invitation: tr("创建邀请", "Create invitation"),
    transfer: tr("转让团队", "Transfer ownership")
  };
  const actions = [
    { action: "approve", text: tr("批准申请", "Approve") },
    { action: "reject", text: tr("拒绝申请", "Reject") },
    { action: "remove", text: tr("移除成员", "Remove") },
    { action: "block", text: tr("加入黑名单", "Block") },
    { action: "unblock", text: tr("解除黑名单", "Unblock") }
  ];
  const inviteUrl = (invitation: any) => window.location.origin + "/team-invite/" + invitation.token;
  async function copyInvitation(invitation: any) {
    if (await copyToClipboard(inviteUrl(invitation))) setNotice(tr("邀请链接已复制。", "Invitation link copied."));
    else setLocalError(tr("复制失败，请手动复制邀请链接。", "Copy failed. Copy the invitation link manually."));
  }

  return (
    <>
      {(error || localError) && <Message negative content={localError || error} />}
      {notice && <Message positive content={notice} onDismiss={() => setNotice("")} />}
      <Form>
        <Form.Group widths="equal">
          <Form.Input
            label={tr("搜索成员", "Search members")}
            icon="search"
            value={search}
            placeholder={tr("用户名、编号或备注", "Username, ID or note")}
            onChange={(_, data) => setSearch(data.value)}
          />
          <Form.Select
            label={tr("状态", "Status")}
            value={statusFilter}
            onChange={(_, data) => setStatusFilter(String(data.value))}
            options={[
              { value: "all", text: tr("全部", "All") },
              { value: "active", text: tr("正式成员", "Members") },
              ...(manage
                ? [
                    { value: "pending", text: tr("待审核", "Pending") },
                    { value: "blocked", text: tr("黑名单", "Blocked") }
                  ]
                : [])
            ]}
          />
          <Form.Select
            label={tr("分组", "Group")}
            value={groupFilter}
            onChange={(_, data) => setGroupFilter(String(data.value))}
            options={[
              { value: "all", text: tr("全部分组", "All groups") },
              { value: "none", text: tr("未分组", "No group") },
              ...groups.map(group => ({
                value: String(group.id),
                text: group.name + (group.archived ? tr("（已归档）", " (archived)") : "")
              }))
            ]}
          />
        </Form.Group>
      </Form>
      {editable && (
        <>
          <div className={style.actions}>
            <span>
              {tr("已选", "Selected")} {selected.length}
            </span>
            <Button size="small" disabled={!selected.length || busy} onClick={() => setSelected([])}>
              {tr("清空选择", "Clear selection")}
            </Button>
            {actions.map(({ action, text }) => {
              const ids = eligible(action);
              return (
                <Button
                  key={action}
                  size="small"
                  disabled={busy || !ids.length}
                  onClick={() =>
                    action === "approve" || action === "unblock"
                      ? memberAction(action, ids)
                      : confirmAction(action, ids, text)
                  }
                >
                  {text} ({ids.length})
                </Button>
              );
            })}
            <Button
              size="small"
              disabled={busy || !eligible("setGroup").length}
              onClick={() => openEditor("setGroup", eligible("setGroup"))}
            >
              {tr("批量分组", "Set group")}
            </Button>
            <Button
              size="small"
              disabled={busy || !eligible("note").length}
              onClick={() => openEditor("note", eligible("note"))}
            >
              {tr("批量备注", "Set note")}
            </Button>
            {owner && (
              <Button
                size="small"
                disabled={busy || !eligible("permissions").length}
                onClick={() => openEditor("permissions", eligible("permissions"))}
              >
                {tr("分配权限", "Assign permissions")}
              </Button>
            )}
            <Button size="small" disabled={busy} onClick={() => openEditor("blockUser", [])}>
              {tr("添加黑名单用户", "Block another user")}
            </Button>
          </div>
          <div className={style.note}>
            {tr(
              "批量操作仅针对所选成员中状态符合的用户；团主和管理员的变更限制由权限控制。",
              "Bulk actions apply to selected users with a matching status. Owner and administrator changes follow your permissions."
            )}
          </div>
        </>
      )}
      <div className={style.table}>
        <Table basic="very" unstackable>
          <Table.Header>
            <Table.Row>
              {editable && (
                <Table.HeaderCell>
                  <Checkbox
                    aria-label={tr("选择所有可见成员", "Select all visible members")}
                    checked={filtered.length > 0 && filtered.every(member => selected.includes(member.userId))}
                    indeterminate={
                      filtered.some(member => selected.includes(member.userId)) &&
                      !filtered.every(member => selected.includes(member.userId))
                    }
                    onChange={(_, data) =>
                      setSelected(ids =>
                        data.checked
                          ? Array.from(new Set([...ids, ...filtered.map(member => member.userId)]))
                          : ids.filter(id => !filtered.some(member => member.userId === id))
                      )
                    }
                  />
                </Table.HeaderCell>
              )}
              <Table.HeaderCell>{tr("成员", "Member")}</Table.HeaderCell>
              <Table.HeaderCell>{tr("状态 / 权限", "Status / permissions")}</Table.HeaderCell>
              <Table.HeaderCell>{tr("分组", "Group")}</Table.HeaderCell>
              {manage && <Table.HeaderCell>{tr("备注 / 申请", "Note / application")}</Table.HeaderCell>}
              {editable && <Table.HeaderCell>{tr("管理", "Manage")}</Table.HeaderCell>}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {filtered.map(member => (
              <Table.Row key={member.userId}>
                {editable && (
                  <Table.Cell>
                    <Checkbox
                      aria-label={tr("选择成员", "Select member") + " #" + member.userId}
                      checked={selected.includes(member.userId)}
                      onChange={(_, data) => toggle(member.userId, !!data.checked)}
                    />
                  </Table.Cell>
                )}
                <Table.Cell>
                  {member.userMeta ? <UserLink user={member.userMeta} /> : "#" + member.userId}
                  {member.userId === team.ownerId && (
                    <Label color="orange" size="tiny">
                      {tr("团主", "Owner")}
                    </Label>
                  )}
                </Table.Cell>
                <Table.Cell>
                  <Label
                    size="small"
                    color={
                      memberStatus(member) === "blocked"
                        ? "red"
                        : memberStatus(member) === "pending"
                        ? "yellow"
                        : undefined
                    }
                  >
                    {stateText(member)}
                  </Label>
                  {(member.permissions || []).map(permission => (
                    <Label key={permission} size="tiny" basic>
                      {permissionLabels().find(item => item.value === permission)?.text || permission}
                    </Label>
                  ))}
                </Table.Cell>
                <Table.Cell>{groupText(member.groupId)}</Table.Cell>
                {manage && (
                  <Table.Cell>
                    {member.note}
                    {memberStatus(member) === "pending" && member.application && (
                      <div className={style.note}>{member.application}</div>
                    )}
                  </Table.Cell>
                )}
                {editable && (
                  <Table.Cell>
                    <Dropdown {...keyboardMenu} text={tr("管理", "Manage")} button basic compact disabled={busy}>
                      <Dropdown.Menu>
                        {memberStatus(member) === "active" && (
                          <>
                            <Dropdown.Item
                              text={tr("修改分组", "Set group")}
                              onClick={() => openEditor("setGroup", [member.userId])}
                            />
                            <Dropdown.Item
                              text={tr("编辑备注", "Edit note")}
                              onClick={() => openEditor("note", [member.userId])}
                            />
                            {owner && member.userId !== team.ownerId && (
                              <Dropdown.Item
                                text={tr("管理权限", "Management permissions")}
                                onClick={() => openEditor("permissions", [member.userId])}
                              />
                            )}
                            {owner && member.userId !== team.ownerId && (
                              <Dropdown.Item
                                text={tr("转让团主", "Transfer ownership")}
                                onClick={() => {
                                  openEditor("transfer", [member.userId]);
                                  setTargetUser({
                                    id: member.userId,
                                    username: member.userMeta?.username || "#" + member.userId
                                  });
                                }}
                              />
                            )}
                          </>
                        )}
                        {actions
                          .filter(item => eligible(item.action, [member.userId]).length)
                          .map(item => (
                            <Dropdown.Item
                              key={item.action}
                              text={item.text}
                              onClick={() =>
                                item.action === "approve" || item.action === "unblock"
                                  ? memberAction(item.action, [member.userId])
                                  : confirmAction(item.action, [member.userId], item.text)
                              }
                            />
                          ))}
                      </Dropdown.Menu>
                    </Dropdown>
                  </Table.Cell>
                )}
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
        {!filtered.length && <div className={style.empty}>{tr("没有符合条件的成员。", "No matching members.")}</div>}
      </div>
      <Segment>
        <div className={membersStyle.groupHeader}>
          <Header as="h3">{tr("成员分组", "Member groups")}</Header>
          {editable && (
            <Button
              size="small"
              icon="plus"
              content={tr("新增分组", "Add group")}
              onClick={() => openEditor("groupEditor", [])}
            />
          )}
        </div>
        {!!groups.length && (
          <div className={membersStyle.groupList}>
            {groups.map(group => (
              <Label key={group.id} basic={group.archived}>
                {group.name}
                {group.archived && tr("（已归档）", " (archived)")}
                {editable && (
                  <Button
                    size="mini"
                    basic
                    icon="edit"
                    aria-label={tr("编辑分组", "Edit group")}
                    onClick={() => openEditor("groupEditor", [], group)}
                  />
                )}
              </Label>
            ))}
          </div>
        )}
        <Form className={membersStyle.groupForm}>
          <div className={membersStyle.groupControls}>
            {memberStatus(membership) === "active" && (
              <Form.Select
                label={tr("我的分组", "My group")}
                value={membership.groupId || 0}
                options={groupOptions}
                disabled={busy || team.groupChangeLocked || team.archived}
                onChange={(_, data) => run("changeGroup", { groupId: Number(data.value) || null })}
              />
            )}
            {settings && !team.archived && (
              <Button
                type="button"
                size="small"
                disabled={busy}
                onClick={() =>
                  run("save", {
                    name: team.name,
                    description: team.description || "",
                    announcement: team.announcement || "",
                    joinPolicy: team.joinPolicy,
                    groupChangeLocked: !team.groupChangeLocked
                  })
                }
              >
                {team.groupChangeLocked
                  ? tr("允许成员自主换组", "Allow members to change groups")
                  : tr("锁定成员自主换组", "Lock member group changes")}
              </Button>
            )}
          </div>
          {team.groupChangeLocked && (
            <div className={style.note + " " + membersStyle.groupNote}>
              {tr("团队已锁定成员自主换组。", "Members cannot change their own group.")}
            </div>
          )}
        </Form>
      </Segment>
      {manage && (
        <Segment>
          <Header as="h3">{tr("团队邀请", "Team invitations")}</Header>
          <div className={style.actions}>
            {editable && (
              <Button
                primary
                disabled={busy}
                icon="plus"
                content={tr("创建邀请", "Create invitation")}
                onClick={() => openEditor("invitation", [])}
              />
            )}
            <Button
              disabled={invitationLoading}
              loading={invitationLoading}
              icon="refresh"
              content={tr("刷新", "Refresh")}
              onClick={reloadInvitations}
            />
          </div>
          {invitationLoading && <Loader active inline="centered" />}
          <div className={style.table}>
            <Table basic="very" unstackable>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{tr("邀请链接", "Invitation link")}</Table.HeaderCell>
                  <Table.HeaderCell>{tr("指定用户", "Recipient")}</Table.HeaderCell>
                  <Table.HeaderCell>{tr("使用次数", "Uses")}</Table.HeaderCell>
                  <Table.HeaderCell>{tr("有效期 / 状态", "Expiry / status")}</Table.HeaderCell>
                  <Table.HeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {invitations.map(invitation => {
                  const valid =
                    invitation.active &&
                    invitation.uses < invitation.maxUses &&
                    +new Date(invitation.expiresAt) > Date.now();
                  return (
                    <Table.Row key={invitation.id}>
                      <Table.Cell>
                        <span className={style.token}>{inviteUrl(invitation)}</span>
                      </Table.Cell>
                      <Table.Cell>
                        {invitation.userId ? "#" + invitation.userId : tr("不限用户", "Any user")}
                      </Table.Cell>
                      <Table.Cell>
                        {invitation.uses} / {invitation.maxUses} · {tr("剩余", "Remaining")}{" "}
                        {Math.max(0, invitation.maxUses - invitation.uses)}
                      </Table.Cell>
                      <Table.Cell>
                        {dateText(invitation.expiresAt)}
                        <div>
                          <Label size="tiny" color={valid ? "green" : "grey"}>
                            {valid
                              ? tr("有效", "Active")
                              : !invitation.active
                              ? tr("已停用", "Disabled")
                              : invitation.uses >= invitation.maxUses
                              ? tr("次数用尽", "Exhausted")
                              : tr("已过期", "Expired")}
                          </Label>
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <div className={style.rowActions}>
                          <Button
                            size="mini"
                            disabled={!valid}
                            icon="copy"
                            content={tr("复制", "Copy")}
                            onClick={() => copyInvitation(invitation)}
                          />
                          {editable && (
                            <Button
                              size="mini"
                              disabled={busy || !invitation.active}
                              content={tr("停用", "Disable")}
                              onClick={() => {
                                setLocalError("");
                                setConfirmation({
                                  action: "deactivateInvitation",
                                  id: invitation.id,
                                  title: tr("停用邀请", "Disable invitation")
                                });
                              }}
                            />
                          )}
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
          {!invitationLoading && !invitations.length && (
            <div className={style.empty}>{tr("暂无邀请。", "No invitations yet.")}</div>
          )}
        </Segment>
      )}
      <Modal open={!!confirmation} onClose={() => !busy && setConfirmation(null)} closeOnDimmerClick={!busy}>
        <Modal.Header>{confirmation?.title}</Modal.Header>
        <Modal.Content>
          <p>
            {confirmation?.action === "deactivateInvitation"
              ? tr("停用后，该邀请链接将不能再使用。", "This invitation link will stop accepting new members.")
              : tr("确认对以下用户执行操作：", "Confirm this action for these users:")}
          </p>
          {confirmation?.ids && <p>{confirmation.ids.map(id => "#" + id).join(", ")}</p>}
          {error && <Message negative content={error} />}
        </Modal.Content>
        <Modal.Actions>
          <Button disabled={busy} onClick={() => setConfirmation(null)}>
            {tr("取消", "Cancel")}
          </Button>
          <Button negative loading={busy} disabled={busy} onClick={confirm}>
            {tr("确认", "Confirm")}
          </Button>
        </Modal.Actions>
      </Modal>
      <Modal open={!!editor} onClose={() => !busy && setEditor(null)} closeOnDimmerClick={!busy}>
        <Modal.Header>{editorTitles[editor?.mode]}</Modal.Header>
        <Modal.Content className={style.editor}>
          {editor?.ids?.length > 0 && (
            <p>
              {tr("用户", "Users")}: {editor.ids.map(id => "#" + id).join(", ")}
            </p>
          )}
          <Form>
            {editor?.mode === "setGroup" && (
              <Form.Select
                label={tr("分组", "Group")}
                value={groupId}
                options={groupOptions}
                onChange={(_, data) => setGroupId(Number(data.value))}
              />
            )}
            {editor?.mode === "note" && (
              <>
                <Form.TextArea
                  label={tr("成员备注", "Member note")}
                  maxLength={2000}
                  value={note}
                  onChange={(_, data) => setNote(String(data.value))}
                />
                {editor.ids.length > 1 && (
                  <Message
                    info
                    content={tr(
                      "此备注将替换所有选中成员的现有备注。",
                      "This note replaces the existing notes for all selected members."
                    )}
                  />
                )}
              </>
            )}
            {editor?.mode === "permissions" && (
              <>
                <Message
                  info
                  content={tr(
                    "仅团主和站点管理员可以授权；未选中的权限将被撤销。",
                    "Only owners and site administrators can assign permissions. Unchecked permissions will be revoked."
                  )}
                />
                {permissionLabels().map(permission => (
                  <Form.Checkbox
                    key={permission.value}
                    label={permission.text}
                    checked={grants.includes(permission.value)}
                    onChange={(_, data) =>
                      setGrants(values =>
                        data.checked
                          ? [...values, permission.value]
                          : values.filter(value => value !== permission.value)
                      )
                    }
                  />
                ))}
              </>
            )}
            {editor?.mode === "groupEditor" && (
              <>
                <Form.Input
                  required
                  label={tr("分组名称", "Group name")}
                  maxLength={80}
                  value={groupName}
                  onChange={(_, data) => setGroupName(data.value)}
                />
                <Form.Checkbox
                  label={tr("归档分组", "Archive group")}
                  checked={groupArchived}
                  onChange={(_, data) => setGroupArchived(!!data.checked)}
                />
                {groupArchived && (
                  <Message
                    info
                    content={tr("归档会将该组成员改为未分组。", "Archiving moves members of this group to no group.")}
                  />
                )}
              </>
            )}
            {["blockUser", "invitation"].includes(editor?.mode) && (
              <Form.Field>
                <label>
                  {editor.mode === "invitation" ? tr("指定用户（可留空）", "Recipient (optional)") : tr("用户", "User")}
                </label>
                {targetUser && (
                  <Label
                    content={targetUser.username + " (#" + targetUser.id + ")"}
                    onRemove={() => setTargetUser(null)}
                  />
                )}
                <UserSearch onResultSelect={user => setTargetUser(user)} />
              </Form.Field>
            )}
            {editor?.mode === "invitation" && (
              <>
                <Form.Input
                  required
                  label={tr("最多使用次数", "Maximum uses")}
                  type="number"
                  min={1}
                  max={1000}
                  disabled={!!targetUser}
                  value={targetUser ? 1 : maxUses}
                  onChange={(_, data) => setMaxUses(data.value)}
                />
                <Form.Input
                  label={tr("有效期（留空默认为 7 天）", "Expiry (defaults to 7 days)")}
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(_, data) => setExpiresAt(data.value)}
                />
              </>
            )}
            {editor?.mode === "transfer" && (
              <>
                <Form.Select
                  required
                  search
                  label={tr("新团主（正式成员）", "New owner (active member)")}
                  value={targetUser?.id}
                  options={members
                    .filter(member => memberStatus(member) === "active" && member.userId !== team.ownerId)
                    .map(member => ({
                      value: member.userId,
                      text: (member.userMeta?.username || "#" + member.userId) + " (#" + member.userId + ")"
                    }))}
                  onChange={(_, data) => {
                    const member = members.find(item => item.userId === data.value);
                    setTargetUser(member ? { id: member.userId } : null);
                  }}
                />
                <Form.Checkbox
                  label={tr(
                    "我确认将团队所有权交给上述成员。",
                    "I confirm transferring team ownership to this member."
                  )}
                  checked={transferAccepted}
                  onChange={(_, data) => setTransferAccepted(!!data.checked)}
                />
              </>
            )}
          </Form>
          {(error || localError) && <Message negative content={localError || error} />}
        </Modal.Content>
        <Modal.Actions>
          <Button disabled={busy} onClick={() => setEditor(null)}>
            {tr("取消", "Cancel")}
          </Button>
          <Button
            primary
            loading={busy}
            disabled={
              busy ||
              (editor?.mode === "groupEditor" && !groupName.trim()) ||
              (editor?.mode === "blockUser" && (!targetUser || targetUser.id === team.ownerId)) ||
              (editor?.mode === "transfer" && (!transferAccepted || !targetUser))
            }
            onClick={saveEditor}
          >
            {tr("保存", "Save")}
          </Button>
        </Modal.Actions>
      </Modal>
    </>
  );
});
