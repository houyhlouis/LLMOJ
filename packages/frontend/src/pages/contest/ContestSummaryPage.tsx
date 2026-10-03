import React, { useState } from "react";
import { Button, Divider, Form, Header, Message } from "semantic-ui-react";
import { defineRoute } from "@/AppRouter";
import MarkdownContent from "@/markdown/MarkdownContent";
import ContestFrame from "./ContestFrame";
import { callContest, tr, problemLetter } from "./api";
import style from "./ContestPages.module.less";

function ContestSummaryPage({ detail, initial }: { detail: any; initial: any }) {
  const [content, setContent] = useState(initial.summary.content),
    [parts, setParts] = useState<any[]>(
      detail.problems.map(
        (p: any) =>
          initial.summary.problems.find((x: any) => x.contestProblemId === p.id) ?? {
            contestProblemId: p.id,
            content: "",
            minutes: 0
          }
      )
    );
  const [pending, setPending] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  function update(index: number, field: string, value: any) {
    setParts(parts.map((p, i) => (i === index ? { ...p, [field]: value } : p)));
    setMessage("");
  }
  async function save() {
    setPending(true);
    setError("");
    try {
      await callContest("saveSummary", { id: detail.contest.id, data: { content, problems: parts } });
      setMessage(tr("总结已保存，仅自己可见。", "Summary saved. Only you can view it."));
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  }
  return (
    <ContestFrame detail={detail} tab="summary">
      <Header as="h2">{tr("比赛总结", "Contest summary")}</Header>
      <p className={style.description}>
        {tr(
          "总结仅自己可见。支持 Markdown 和 LaTeX，输入后自动预览。",
          "Summaries are private. Markdown and LaTeX are rendered automatically below each editor."
        )}
      </p>
      {error && <Message negative>{error}</Message>}
      {message && <Message positive>{message}</Message>}
      <Form onSubmit={save} loading={pending}>
        {detail.problems.map((p: any, i: number) => (
          <React.Fragment key={p.id}>
            <Header as="h3">
              {problemLetter(i)}. {p.title}
            </Header>
            <Form.Input
              type="number"
              min={0}
              step={0.1}
              label={tr("完成耗时（分钟）", "Completion time (minutes)")}
              value={parts[i].minutes}
              onChange={(_, v) => update(i, "minutes", Number(v.value))}
            />
            <Form.TextArea
              rows={6}
              label={tr("这道题的总结", "Problem summary")}
              value={parts[i].content}
              onChange={(_, v) => update(i, "content", String(v.value))}
            />
            {parts[i].content && (
              <div className={style.preview}>
                <MarkdownContent content={parts[i].content} />
              </div>
            )}
            <Divider />
          </React.Fragment>
        ))}
        <Header as="h3">{tr("整场比赛总结", "Overall contest summary")}</Header>
        <Form.TextArea
          rows={10}
          value={content}
          onChange={(_, v) => {
            setContent(String(v.value));
            setMessage("");
          }}
        />
        {content && (
          <div className={style.preview}>
            <MarkdownContent content={content} />
          </div>
        )}
        <Button primary type="submit">
          {tr("保存总结", "Save summary")}
        </Button>
      </Form>
    </ContestFrame>
  );
}
export default defineRoute(async req => {
  const id = Number(req.params.contestId);
  const [detail, initial] = await Promise.all([callContest("detail", { id }), callContest("summary", { id })]);
  return <ContestSummaryPage key={id} detail={detail} initial={initial} />;
});
