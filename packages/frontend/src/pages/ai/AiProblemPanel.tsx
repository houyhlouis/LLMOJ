import React, { useState } from "react";
import { Button, Dropdown, Form, Header, Message } from "semantic-ui-react";
import { observer } from "mobx-react";
import { appState } from "@/appState";
import { Link } from "@/utils/hooks";
import { aiCall, aiText, actionName } from "./api";
import AiJobs from "./AiJobs";
import style from "./Ai.module.less";
export { startAiAfterSave } from "./api";

export const AiProblemPanel = observer(function AiProblemPanel({
  problemId,
  problemType,
  onCompleted
}: {
  problemId: number;
  problemType: string;
  onCompleted?: () => void;
}) {
  const [count, setCount] = useState(20),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [refreshKey, setRefreshKey] = useState(0);
  if (!appState.currentUserHasPrivilege("UseAi" as any)) return null;
  const generate = async (action: string) => {
    setPending(true);
    setError("");
    try {
      await aiCall("start", { problemId, action, count });
      setRefreshKey(x => x + 1);
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  };
  const canGenerate =
    ["Traditional", "Interaction", "Communication"].includes(problemType) &&
    appState.currentUserHasPrivilege("GenerateTestdata" as any);
  const invalidCount = !Number.isInteger(count) || count < 5 || count > 1000;
  return (
    <section className={style.problemPanel}>
      <div className={style.panelHeading}>
        <Header as="h3">{aiText("AI 辅助", "AI assistance")}</Header>
        <Link href="/ai/configuration">{aiText("配置 AI API", "AI API Configuration")}</Link>
      </div>
      <p className={style.notes}>
        {aiText(
          "使用已保存的题面与评测协议执行。生成数据时优先验证题解中的 C++ 标程，再决定是否独立生成。任务在后台继续运行，返回页面可查看进度。",
          "Uses the saved statement and judging protocol. Test-data generation first checks C++ reference code from tutorials before deciding whether to generate it independently. Jobs continue in the background; return here to check progress."
        )}
      </p>
      {problemType === "SubmitAnswer" && (
        <p className={style.notes}>
          {aiText(
            "提交答案题可使用题面信息、翻译和题解等 AI 功能，暂不支持自动生成数据。",
            "Output-only tasks support AI metadata, translation and tutorials; automatic test-data generation is not available."
          )}
        </p>
      )}
      {error && <Message negative>{error}</Message>}
      <Form className={style.problemToolbar} onSubmit={e => e.preventDefault()}>
        {canGenerate && (
          <>
            <Form.Input
              inline
              className={style.caseCount}
              label={aiText("数据组数", "Test cases")}
              aria-label={aiText("测试数据组数（5–1000）", "Test cases (5–1000)")}
              type="number"
              min={5}
              max={1000}
              value={count}
              onChange={(_e, value) => setCount(Number(value.value))}
            />
            <Button
              size="small"
              type="button"
              primary
              disabled={pending || invalidCount}
              loading={pending}
              onClick={() => generate("all")}
            >
              {actionName("all")}
            </Button>
          </>
        )}
        <Dropdown
          button
          className="small"
          text={aiText("单步执行", "Run a step")}
          disabled={pending}
          aria-label={aiText("单步执行 AI 功能", "Run an AI step")}
        >
          <Dropdown.Menu>
            {["source", "translate", "tags", "difficulty", "tutorial", "testdata"]
              .filter(action => action !== "testdata" || canGenerate)
              .map(action => (
                <Dropdown.Item
                  key={action}
                  text={actionName(action)}
                  disabled={action === "testdata" && invalidCount}
                  onClick={() => generate(action)}
                />
              ))}
          </Dropdown.Menu>
        </Dropdown>
        {canGenerate && <span className={style.rangeNote}>{aiText("5–1000 组", "5–1000 cases")}</span>}
      </Form>
      <AiJobs problemId={problemId} refreshKey={refreshKey} onCompleted={onCompleted} />
    </section>
  );
});
export default AiProblemPanel;
