import React, { useEffect, useState } from "react";
import { Button, Form, Message, Modal, Table } from "semantic-ui-react";
import ProblemSearch from "@/components/ProblemSearch";
import { localDateInput, parseIds, tr } from "./api";
import { ruleChoices } from "@/pages/contest/contest-rules";

export default function ResourceEditor({
  mode,
  initial,
  groups,
  members,
  problems = [],
  busy,
  error,
  onClose,
  onSave
}: {
  mode: string;
  initial?: any;
  groups: any[];
  members: any[];
  problems?: any[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (action: string, data: any) => void;
}) {
  const [form, setForm] = useState<any>({}),
    [localError, setLocalError] = useState(""),
    [sourceTitle, setSourceTitle] = useState("");
  useEffect(() => {
    setForm({
      title: "",
      content: "",
      description: "",
      subtitle: "",
      rule: "noi",
      visibility: "private",
      startTime: localDateInput(new Date().toISOString()),
      endTime: localDateInput(new Date(Date.now() + 10800000).toISOString()),
      invitedUsers: "",
      items: [],
      assignedUserIds: [],
      assignedGroupIds: [],
      archived: false,
      ...initial,
      deadline: localDateInput(initial?.deadline)
    });
    setLocalError("");
    setSourceTitle("");
  }, [mode, initial]);
  const change = (key: string, value: any) => setForm({ ...form, [key]: value });
  const title = {
    problem: tr("创建团队题目", "Create team problem"),
    contest: tr("创建团队比赛", "Create team contest"),
    discussion: tr("发表团队讨论", "Publish team discussion"),
    assignment: tr("题单与作业", "Study list and assignment"),
    contestAccess: tr("比赛访问设置", "Contest access")
  }[mode];
  function save() {
    setLocalError("");
    try {
      if (mode === "problem") onSave("createProblem", { sourceProblemId: form.sourceProblemId });
      if (mode === "contest")
        onSave("createContest", {
          title: form.title,
          subtitle: form.subtitle,
          description: form.description,
          rule: form.rule,
          startTime: new Date(form.startTime).toISOString(),
          endTime: new Date(form.endTime).toISOString(),
          visibility: form.visibility,
          invitedUserIds: parseIds(form.invitedUsers)
        });
      if (mode === "contestAccess")
        onSave("updateContestAccess", {
          contestId: form.id,
          visibility: form.visibility,
          invitedUserIds: parseIds(form.invitedUsers)
        });
      if (mode === "discussion")
        onSave("createDiscussion", { title: form.title, content: form.content, problemId: form.problemId });
      if (mode === "assignment")
        onSave("saveAssignment", {
          id: form.id,
          title: form.title,
          description: form.description,
          items: form.items.map(x => ({ problemId: x.problemId, section: x.section || "", note: x.note || "" })),
          assignedUserIds: form.assignedUserIds,
          assignedGroupIds: form.assignedGroupIds,
          deadline: form.deadline ? new Date(form.deadline).toISOString() : null,
          archived: !!form.archived
        });
    } catch (e) {
      setLocalError(e.message);
    }
  }
  const accessFields = (
    <>
      <Form.Select
        label={tr("访问范围", "Visibility")}
        value={form.visibility}
        onChange={(_, d) => change("visibility", d.value)}
        options={[
          { value: "private", text: tr("团队内部", "Team only") },
          { value: "public", text: tr("公开比赛", "Public") },
          { value: "invite", text: tr("邀请比赛", "Invited participants") }
        ]}
      />
      {form.visibility === "invite" && (
        <Form.Input
          label={tr("受邀用户编号（逗号分隔）", "Invited user IDs (comma separated)")}
          value={form.invitedUsers}
          onChange={(_, d) => change("invitedUsers", d.value)}
        />
      )}
    </>
  );
  const items = form.items || [];
  const teamProblems = problems.filter(problem => !problem.archived);
  function selectTeamProblem(id: number) {
    const problem = teamProblems.find(item => item.id === id);
    if (!problem) return;
    if (mode === "assignment") {
      if (!items.some(item => item.problemId === id))
        change("items", [...items, { problemId: id, title: problem.title, section: "", note: "" }]);
    } else {
      change(mode === "problem" ? "sourceProblemId" : "problemId", id);
      setSourceTitle(problem.title || "#" + id);
    }
  }
  const teamProblemPicker = teamProblems.length > 0 && (
    <Form.Select
      search
      clearable
      label={tr("从团队题库选择", "Choose from team problems")}
      value={mode === "assignment" ? "" : (form[mode === "problem" ? "sourceProblemId" : "problemId"] ?? "")}
      options={teamProblems.map(problem => ({
        value: problem.id,
        text: (problem.title || "#" + problem.id) + " (#" + problem.id + ")"
      }))}
      onChange={(_, value) => {
        if (!value.value) {
          if (mode !== "assignment") {
            change(mode === "problem" ? "sourceProblemId" : "problemId", undefined);
            setSourceTitle("");
          }
          return;
        }
        selectTeamProblem(Number(value.value));
      }}
    />
  );
  return (
    <Modal open={!!mode} onClose={onClose} closeOnDimmerClick={!busy}>
      <Modal.Header>{title}</Modal.Header>
      <Modal.Content>
        <Form>
          {mode === "problem" ? (
            <>
              <Message
                info
                content={tr(
                  "留空创建新题目，或搜索并复制已有题目的题面、样例、测试数据和附件。",
                  "Create a blank problem, or copy an existing statement, samples, test data and attachments."
                )}
              />
              <ProblemSearch
                onResultSelect={p => {
                  change("sourceProblemId", p.meta.id);
                  setSourceTitle(p.title);
                }}
              />
              {teamProblemPicker}
              {sourceTitle && (
                <p>
                  {sourceTitle}{" "}
                  <Button
                    size="tiny"
                    onClick={() => {
                      change("sourceProblemId", undefined);
                      setSourceTitle("");
                    }}
                  >
                    {tr("清除", "Clear")}
                  </Button>
                </p>
              )}
            </>
          ) : mode === "contestAccess" ? (
            accessFields
          ) : (
            <>
              <Form.Input
                required
                maxLength={mode === "discussion" ? 80 : 160}
                label={tr("标题", "Title")}
                value={form.title || ""}
                onChange={(_, d) => change("title", d.value)}
              />
              {mode === "discussion" ? (
                <>
                  <Form.TextArea
                    required
                    rows={12}
                    label={tr("内容（Markdown）", "Content (Markdown)")}
                    value={form.content}
                    onChange={(_, d) => change("content", String(d.value))}
                  />
                  <Form.Field>
                    <label>{tr("关联题目（可选）", "Related problem (optional)")}</label>
                    <ProblemSearch
                      onResultSelect={p => {
                        change("problemId", p.meta.id);
                        setSourceTitle(p.title);
                      }}
                    />
                    {sourceTitle}
                  </Form.Field>
                  {teamProblemPicker}
                </>
              ) : (
                <Form.TextArea
                  label={tr("说明（Markdown）", "Description (Markdown)")}
                  value={form.description || ""}
                  onChange={(_, d) => change("description", String(d.value))}
                />
              )}
              {mode === "contest" && (
                <>
                  <Form.Input
                    label={tr("副标题", "Subtitle")}
                    value={form.subtitle}
                    onChange={(_, d) => change("subtitle", d.value)}
                  />
                  <Form.Select
                    label={tr("赛制", "Scoring")}
                    value={form.rule}
                    options={ruleChoices()}
                    onChange={(_, d) => change("rule", d.value)}
                  />
                  <Form.Group widths="equal">
                    <Form.Input
                      required
                      type="datetime-local"
                      label={tr("开始时间", "Starts")}
                      value={form.startTime}
                      onChange={(_, d) => change("startTime", d.value)}
                    />
                    <Form.Input
                      required
                      type="datetime-local"
                      label={tr("结束时间", "Ends")}
                      value={form.endTime}
                      onChange={(_, d) => change("endTime", d.value)}
                    />
                  </Form.Group>
                  {accessFields}
                </>
              )}
              {mode === "assignment" && (
                <>
                  <Form.Input
                    type="datetime-local"
                    label={tr("截止时间（留空作为题单）", "Deadline (empty for a study list)")}
                    value={form.deadline}
                    onChange={(_, d) => change("deadline", d.value)}
                  />
                  <Form.Select
                    multiple
                    search
                    clearable
                    label={tr(
                      "指定成员（成员和分组均留空时面向全体）",
                      "Assigned members (all members when both lists are empty)"
                    )}
                    value={form.assignedUserIds || []}
                    options={members
                      .filter(m => m.status === "member")
                      .map(m => ({
                        value: m.userId,
                        text: (m.note || m.userMeta?.username || String(m.userId)) + " (#" + m.userId + ")"
                      }))}
                    onChange={(_, d) => change("assignedUserIds", d.value)}
                  />
                  <Form.Select
                    multiple
                    clearable
                    label={tr("指定分组（与指定成员合并）", "Assigned groups (combined with selected members)")}
                    value={form.assignedGroupIds || []}
                    options={groups.filter(g => !g.archived).map(g => ({ value: g.id, text: g.name }))}
                    onChange={(_, d) => change("assignedGroupIds", d.value)}
                  />
                  <Form.Field>
                    <label>{tr("添加题目", "Add problem")}</label>
                    <ProblemSearch
                      onResultSelect={p => {
                        if (!items.some(x => x.problemId === p.meta.id))
                          change("items", [...items, { problemId: p.meta.id, title: p.title, section: "", note: "" }]);
                      }}
                    />
                  </Form.Field>
                  {teamProblemPicker}
                  <Table basic="very">
                    <Table.Header>
                      <Table.Row>
                        <Table.HeaderCell>{tr("题目", "Problem")}</Table.HeaderCell>
                        <Table.HeaderCell>{tr("分节 / 备注", "Section / note")}</Table.HeaderCell>
                        <Table.HeaderCell />
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {items.map((item, i) => (
                        <Table.Row key={item.problemId}>
                          <Table.Cell>{item.title || "#" + item.problemId}</Table.Cell>
                          <Table.Cell>
                            <Form.Input
                              value={item.section}
                              placeholder={tr("分节", "Section")}
                              onChange={(_, d) =>
                                change(
                                  "items",
                                  items.map((x, index) => (index === i ? { ...x, section: d.value } : x))
                                )
                              }
                            />
                            <Form.Input
                              value={item.note}
                              placeholder={tr("备注", "Note")}
                              onChange={(_, d) =>
                                change(
                                  "items",
                                  items.map((x, index) => (index === i ? { ...x, note: d.value } : x))
                                )
                              }
                            />
                          </Table.Cell>
                          <Table.Cell>
                            <Button
                              size="mini"
                              icon="arrow up"
                              aria-label={tr("上移", "Move up")}
                              disabled={!i}
                              onClick={() => {
                                const next = [...items];
                                [next[i - 1], next[i]] = [next[i], next[i - 1]];
                                change("items", next);
                              }}
                            />
                            <Button
                              size="mini"
                              icon="arrow down"
                              aria-label={tr("下移", "Move down")}
                              disabled={i === items.length - 1}
                              onClick={() => {
                                const next = [...items];
                                [next[i + 1], next[i]] = [next[i], next[i + 1]];
                                change("items", next);
                              }}
                            />
                            <Button
                              size="mini"
                              icon="remove"
                              aria-label={tr("移除", "Remove")}
                              onClick={() =>
                                change(
                                  "items",
                                  items.filter((_, index) => index !== i)
                                )
                              }
                            />
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                  <Message
                    info
                    content={tr(
                      "作业只统计截止时间之前的提交；fake 记录计为零分。",
                      "Assignments count submissions before the deadline; fake records earn zero points."
                    )}
                  />
                </>
              )}
            </>
          )}
        </Form>
        {(localError || error) && <Message negative content={localError || error} />}
      </Modal.Content>
      <Modal.Actions>
        <Button disabled={busy} onClick={onClose}>
          {tr("取消", "Cancel")}
        </Button>
        <Button primary loading={busy} disabled={busy} onClick={save}>
          {tr("保存", "Save")}
        </Button>
      </Modal.Actions>
    </Modal>
  );
}
