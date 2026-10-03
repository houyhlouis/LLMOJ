import React, { useEffect, useState } from "react";
import { Button, Divider, Form, Header, Message, Table } from "semantic-ui-react";
import { defineRoute, RouteError } from "@/AppRouter";
import { useNavigationChecked, useLocalizer, Link } from "@/utils/hooks";
import { appState } from "@/appState";
import { CodeLanguage, normalizeContestLanguages } from "@/interfaces/CodeLanguage";
import ContestFrame from "./ContestFrame";
import { callContest, tr, problemLetter, languageChoices } from "./api";
import style from "./ContestPages.module.less";

const dateInput = (value: string) => {
  const d = new Date(value);
  return new Date(+d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
function ContestEditPage({ detail }: { detail?: any }) {
  const navigation = useNavigationChecked();
  const localizeLanguage = useLocalizer("code_language");
  useEffect(() => {
    if (!detail) appState.enterNewPage(tr("创建比赛", "Create contest"), "contests");
  }, [detail, appState.locale]);
  const [data, setData] = useState<any>(
    detail
      ? {
          ...detail.contest,
          languages: normalizeContestLanguages(detail.contest.languages),
          startTime: dateInput(detail.contest.startTime),
          endTime: dateInput(detail.contest.endTime)
        }
      : {
          title: "",
          subtitle: "",
          description: "",
          rule: "noi",
          startTime: dateInput(new Date(Date.now() + 3600000).toISOString()),
          endTime: dateInput(new Date(Date.now() + 14400000).toISOString()),
          adminIds: [],
          languages: normalizeContestLanguages(Object.values(CodeLanguage)),
          isPublic: false,
          hideStatistics: false
        }
  );
  const [adminIds, setAdminIds] = useState(data.adminIds.join(", "));
  const [problems, setProblems] = useState(detail?.problems ?? []),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [deleteConfirm, setDeleteConfirm] = useState(false);
  const blankProblem = {
    problemId: "",
    title: "",
    position: problems.length + 1,
    weight: 1,
    inputFilename: "",
    outputFilename: "",
    subtaskAllOrNothing: false
  };
  const [problem, setProblem] = useState<any>(blankProblem);
  function change(name: string, value: any) {
    setData({ ...data, [name]: value });
  }
  async function save() {
    setPending(true);
    setError("");
    try {
      const result = await callContest("save", {
        id: detail?.contest.id,
        data: {
          ...data,
          startTime: new Date(data.startTime).toISOString(),
          endTime: new Date(data.endTime).toISOString(),
          adminIds: adminIds
            .split(/[,，\s]+/)
            .filter(Boolean)
            .map(Number)
        }
      });
      await navigation.navigate(`/contest/${result.id}/edit`);
      navigation.refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  }
  async function saveProblem() {
    setPending(true);
    setError("");
    try {
      await callContest("saveProblem", {
        id: detail.contest.id,
        data: {
          ...problem,
          problemId: Number(problem.problemId),
          position: Number(problem.position),
          weight: Number(problem.weight)
        }
      });
      setProblems((await callContest("detail", { id: detail.contest.id })).problems);
      setProblem({ ...blankProblem, position: problems.length + 2 });
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  }
  async function removeProblem(id: number) {
    try {
      await callContest("removeProblem", { id: detail.contest.id, problemId: id });
      setProblems(problems.filter((p: any) => p.id !== id));
    } catch (e) {
      setError(e.message);
    }
  }
  async function remove() {
    try {
      await callContest("delete", { id: detail.contest.id });
      await navigation.navigate("/contests");
    } catch (e) {
      setError(e.message);
    }
  }
  const view = (
    <>
      <Header as={detail ? "h2" : "h1"}>
        {detail ? tr("编辑比赛", "Edit contest") : tr("创建比赛", "Create contest")}
      </Header>
      {error && <Message negative>{error}</Message>}
      <Form loading={pending} onSubmit={save}>
        <Form.Input
          required
          label={tr("比赛名称", "Title")}
          value={data.title}
          maxLength={160}
          onChange={(_, v) => change("title", v.value)}
        />
        <Form.TextArea
          label={tr("副标题（Markdown / LaTeX）", "Subtitle (Markdown / LaTeX)")}
          value={data.subtitle}
          onChange={(_, v) => change("subtitle", v.value)}
        />
        <Form.TextArea
          label={tr("比赛说明（Markdown / LaTeX）", "Description (Markdown / LaTeX)")}
          value={data.description}
          rows={10}
          onChange={(_, v) => change("description", v.value)}
        />
        <Form.Group widths="equal">
          <Form.Select
            label={tr("赛制", "Rule")}
            value={data.rule}
            options={[
              { value: "noi", text: "NOI" },
              { value: "ioi", text: "IOI" },
              { value: "acm", text: "ICPC" }
            ]}
            onChange={(_, v) => change("rule", v.value)}
          />
          <Form.Input
            type="datetime-local"
            label={tr("开始时间（本地时区）", "Start time (local timezone)")}
            value={data.startTime}
            onChange={(_, v) => change("startTime", v.value)}
          />
          <Form.Input
            type="datetime-local"
            label={tr("结束时间（本地时区）", "End time (local timezone)")}
            value={data.endTime}
            onChange={(_, v) => change("endTime", v.value)}
          />
        </Form.Group>
        <Form.Input
          label={tr("协管员用户 ID（逗号分隔）", "Administrator user IDs (comma separated)")}
          value={adminIds}
          onChange={(_, v) => setAdminIds(v.value)}
        />
        <Form.Select
          required
          multiple
          label={tr("允许提交的语言", "Allowed submission languages")}
          value={data.languages}
          options={languageChoices(Object.values(CodeLanguage), localizeLanguage)}
          onChange={(_, v) => change("languages", v.value)}
        />
        <Form.Checkbox
          label={tr("公开比赛", "Publish contest")}
          checked={data.isPublic}
          onChange={(_, v) => change("isPublic", v.checked)}
        />
        <Form.Checkbox
          label={tr("隐藏题目统计", "Hide problem statistics")}
          checked={data.hideStatistics}
          onChange={(_, v) => change("hideStatistics", v.checked)}
        />
        <Button primary type="submit">
          {tr("保存比赛", "Save contest")}
        </Button>
      </Form>
      {detail && (
        <>
          <Divider />
          <Header as="h2">{tr("比赛题目", "Contest problems")}</Header>
          <Table basic="very">
            <Table.Body>
              {problems.map((p: any, i: number) => (
                <Table.Row key={p.id}>
                  <Table.Cell>{problemLetter(i)}</Table.Cell>
                  <Table.Cell>
                    <Link href={`/contest/${detail.contest.id}/problem/${p.id}`}>{p.title}</Link>
                  </Table.Cell>
                  <Table.Cell>#{p.problemId}</Table.Cell>
                  <Table.Cell>
                    <Button size="small" onClick={() => setProblem({ ...p, problemId: String(p.problemId) })}>
                      {tr("编辑", "Edit")}
                    </Button>
                    <Button size="small" onClick={() => removeProblem(p.id)}>
                      {tr("移除", "Remove")}
                    </Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
          <Form onSubmit={saveProblem}>
            <Form.Group widths="equal">
              <Form.Input
                required
                type="number"
                min={1}
                label={tr("题目内部 ID", "Problem internal ID")}
                value={problem.problemId}
                onChange={(_, v) => setProblem({ ...problem, problemId: v.value })}
              />
              <Form.Input
                type="number"
                min={1}
                label={tr("顺序", "Order")}
                value={problem.position}
                onChange={(_, v) => setProblem({ ...problem, position: v.value })}
              />
              <Form.Input
                type="number"
                min={0.001}
                step={0.001}
                label={tr("计分权重", "Score weight")}
                value={problem.weight}
                onChange={(_, v) => setProblem({ ...problem, weight: v.value })}
              />
            </Form.Group>
            <Form.Input
              label={tr("比赛内标题（可选）", "Contest title override (optional)")}
              value={problem.title}
              onChange={(_, v) => setProblem({ ...problem, title: v.value })}
            />
            <Form.Checkbox
              label={tr("每个子任务必须全部通过才得分", "All tests in each subtask must pass to earn its score")}
              checked={!!problem.subtaskAllOrNothing}
              onChange={(_, v) => setProblem({ ...problem, subtaskAllOrNothing: !!v.checked })}
            />
            <p className={style.description}>
              {tr(
                "开启后，每个子任务全对得满分，否则该子任务为 0 分；关闭时使用原题的逐点或自定义子任务计分。此设置仅影响本场比赛。",
                "When enabled, a subtask earns full score only if every test passes; otherwise it earns zero. When disabled, use the problem's per-test or custom subtask scoring. This affects only this contest."
              )}
            </p>
            <Form.Group widths="equal">
              <Form.Input
                label={tr("输入文件名（留空使用标准输入）", "Input filename (empty for standard input)")}
                value={problem.inputFilename}
                onChange={(_, v) => setProblem({ ...problem, inputFilename: v.value })}
              />
              <Form.Input
                label={tr("输出文件名（留空使用标准输出）", "Output filename (empty for standard output)")}
                value={problem.outputFilename}
                onChange={(_, v) => setProblem({ ...problem, outputFilename: v.value })}
              />
            </Form.Group>
            <p className={style.description}>
              {tr(
                "比赛内的文件输入输出和附件与原题独立。附件可在比赛题目页面上传。",
                "Contest file I/O and attachments are independent of the original problem. Upload attachments on the contest problem page."
              )}
            </p>
            <Button primary type="submit" loading={pending}>
              {tr("保存题目设置", "Save problem settings")}
            </Button>
          </Form>
          <Divider />
          <Button
            onClick={async () => {
              try {
                await callContest("rejudge", { id: detail.contest.id });
              } catch (e) {
                setError(e.message);
              }
            }}
          >
            {tr("重测本场比赛提交", "Rejudge contest submissions")}
          </Button>
          <Button negative onClick={() => setDeleteConfirm(true)}>
            {tr("删除比赛", "Delete contest")}
          </Button>
          {deleteConfirm && (
            <Message warning>
              <p>
                {tr(
                  "将删除此比赛、比赛提交和总结。确认删除？",
                  "This deletes the contest, its submissions and summaries. Confirm deletion?"
                )}
              </p>
              <Button negative onClick={remove}>
                {tr("确认删除", "Confirm deletion")}
              </Button>
              <Button onClick={() => setDeleteConfirm(false)}>{tr("取消", "Cancel")}</Button>
            </Message>
          )}
        </>
      )}
    </>
  );
  return detail ? (
    <ContestFrame detail={detail} tab="edit">
      {view}
    </ContestFrame>
  ) : (
    view
  );
}
export const edit = defineRoute(async req => {
  const detail = await callContest("detail", { id: Number(req.params.contestId) });
  if (!detail.manager) throw new RouteError(tr("没有管理权限", "Permission denied"));
  return <ContestEditPage key={detail.contest.id} detail={detail} />;
});
const create = defineRoute(async () => <ContestEditPage />);
export { create as new };

export default { edit, new: create };
