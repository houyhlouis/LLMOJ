import React from "react";
import { Table } from "semantic-ui-react";
import { aiText, AiJob, AiScoringPolicy, AiScoringReason } from "./api";
import style from "./Ai.module.less";

const scoringTypeName = (type: string) =>
  ({
    Sum: aiText("按测试点得分求和", "Sum of test cases"),
    GroupMin: aiText("取最低测试点得分（捆绑）", "Lowest test case (all or nothing)"),
    GroupMul: aiText("测试点得分相乘", "Product of test cases")
  })[type] || type;

const points = (value: number) => String(Math.round(value * 100) / 100);

const reasonText = (reason: AiScoringReason) => {
  switch (reason.code) {
    case "SUBTASK_COUNT":
      return aiText(
        `题目有 ${reason.current} 个子任务，题面描述了 ${reason.proposed} 个。`,
        `The problem has ${reason.current} subtask${reason.current === 1 ? "" : "s"}; the statement describes ${
          reason.proposed
        }.`
      );
    case "SUBTASK_POINTS":
      return aiText(
        `子任务 ${reason.subtask}：题目设为 ${points(reason.current)} 分，题面为 ${points(reason.proposed)} 分。`,
        `Subtask ${reason.subtask} is worth ${points(reason.current)} points in the problem and ${points(
          reason.proposed
        )} in the statement.`
      );
    case "SUBTASK_ORDER":
      return aiText(
        "题面的子任务与题目的子任务无法一一对应。",
        "The statement's subtasks don't match the problem's in order."
      );
    case "SUBTASK_LIMITS":
      return aiText(
        `子任务 ${reason.subtask} 有自己的时间或内存限制，生成数据时无法按它检验，确认后将改用题目的限制。`,
        `Subtask ${reason.subtask} has its own time or memory limit, which the generated data can't be checked with; approving uses the problem's limits.`
      );
    case "CASE_LIMITS":
      return aiText(
        `子任务 ${reason.subtask} 的测试点有自己的时间或内存限制，新测试点不会沿用。`,
        `Test cases of subtask ${reason.subtask} have their own time or memory limits, which new test cases don't keep.`
      );
    case "CASE_POINTS":
      return aiText(
        `子任务 ${reason.subtask} 的测试点有各自的分值，新测试点将平均分配。`,
        `Test cases of subtask ${reason.subtask} have their own points; new test cases share the subtask's points equally.`
      );
    default:
      return "";
  }
};

export function PolicyTable({ policy }: { policy: AiScoringPolicy }) {
  return (
    <Table compact unstackable celled className={style.scoringTable}>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{aiText("子任务", "Subtask")}</Table.HeaderCell>
          <Table.HeaderCell>{aiText("分值", "Points")}</Table.HeaderCell>
          <Table.HeaderCell>{aiText("计分方式", "Scoring")}</Table.HeaderCell>
          <Table.HeaderCell>{aiText("依赖", "Depends on")}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {policy.subtasks.map((subtask, index) => (
          <Table.Row key={index}>
            <Table.Cell>
              {index + 1}
              {(subtask.timeLimit || subtask.memoryLimit) && (
                <span className={style.scoringNote}>
                  {" "}
                  (
                  {[subtask.timeLimit && `${subtask.timeLimit} ms`, subtask.memoryLimit && `${subtask.memoryLimit} MiB`]
                    .filter(Boolean)
                    .join(", ")}
                  )
                </span>
              )}
            </Table.Cell>
            <Table.Cell>{points(subtask.points)}</Table.Cell>
            <Table.Cell>{scoringTypeName(subtask.scoringType)}</Table.Cell>
            <Table.Cell>
              {subtask.dependencies.length ? subtask.dependencies.map(i => i + 1).join(", ") : "—"}
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}

/** The scoring change a failed test-data job waits for its owner to approve: what the problem has, and what it would. */
export default function AiScoringReview({ review }: { review: AiJob["result"]["scoringReview"] }) {
  const samples = (policy: AiScoringPolicy) =>
    policy.runSamples
      ? aiText("样例未通过则不得分。", "A submission that fails a sample gets no points.")
      : aiText("不先运行样例。", "Samples aren't judged first.");
  return (
    <div className={style.scoringReview}>
      <ul className={style.scoringReasons}>
        {review.reasons.map((reason, index) => (
          <li key={index}>{reasonText(reason)}</li>
        ))}
      </ul>
      <div className={style.scoringPolicies}>
        <div>
          <strong>{aiText("题目现有的设置", "The problem's settings")}</strong>
          <PolicyTable policy={review.current} />
          <p className={style.notes}>{samples(review.current)}</p>
        </div>
        <div>
          <strong>{aiText("确认后发布的设置", "Published if you approve")}</strong>
          <PolicyTable policy={review.proposed} />
          <p className={style.notes}>{samples(review.proposed)}</p>
        </div>
      </div>
    </div>
  );
}

/** What a finished test-data job did with the problem's scoring and judging helpers. */
/**
 * Where a finished job's test data was made (review Part III, W03): on the local AI runner or a judge machine, made
 * for the job or collected again after the job stopped, and what its run took from earlier attempts.
 */
export function AiRunSummary({ result }: { result: AiJob["result"] }) {
  const { execution, corpus } = result;
  if (!execution) return null;
  // Cases with the same input as another (absent before review Part III, W05)
  const repeated = corpus?.distinct != null && corpus.distinct < corpus.cases;
  const where =
    execution.origin === "judge"
      ? aiText("在评测机上生成", "Made on a judge machine")
      : aiText("在本机生成", "Made on this server");
  const how =
    execution.result === "collected-again"
      ? aiText(
          "，任务中断后重新取回已完成的结果（未重新生成）",
          ", and collected again after the job stopped (not made again)"
        )
      : execution.result === "resumed"
        ? aiText("，任务中断后继续等待同一次运行", ", the job waiting again for the same run after it stopped")
        : "";
  const reused = [
    execution.reuse.builds &&
      aiText(
        `复用 ${execution.reuse.builds} 个已编译程序`,
        `${execution.reuse.builds} ${execution.reuse.builds === 1 ? "program" : "programs"} taken from earlier builds`
      ),
    execution.reuse.inputs &&
      aiText(
        `复用同一生成器此前生成的 ${execution.reuse.inputs} 个输入`,
        `${execution.reuse.inputs} ${execution.reuse.inputs === 1 ? "input" : "inputs"} the same generator made in an earlier run`
      ),
    result.revision?.repairs &&
      aiText(
        `经过 ${result.revision.repairs} 次修复`,
        `after ${result.revision.repairs} ${result.revision.repairs === 1 ? "repair" : "repairs"}`
      )
  ].filter(Boolean);
  return (
    <p className={style.jobDetail} title={`${execution.operation} · ${execution.runtime.judgeProgram.slice(0, 12)}`}>
      {where}
      {how}
      {reused.length > 0 && ` · ${reused.join(" · ")}`}
      {corpus &&
        aiText(
          ` · ${corpus.cases} 个测试点${
            corpus.adversarial || repeated
              ? `（${[
                  corpus.adversarial && `其中 ${corpus.adversarial} 个为对抗数据`,
                  repeated && `${corpus.distinct} 个不同的输入`
                ]
                  .filter(Boolean)
                  .join("，")}）`
              : ""
          }`,
          ` · ${corpus.cases} cases${
            corpus.adversarial || repeated
              ? ` (${[
                  corpus.adversarial && `${corpus.adversarial} adversarial`,
                  repeated && `${corpus.distinct} distinct ${corpus.distinct === 1 ? "input" : "inputs"}`
                ]
                  .filter(Boolean)
                  .join(", ")})`
              : ""
          }`
        )}
    </p>
  );
}

export function AiJudgingSummary({ result }: { result: AiJob["result"] }) {
  const { scoring, helpers } = result;
  if (!scoring && !helpers?.length) return null;
  const helperName = (role: string) =>
    ({
      checker: aiText("SPJ", "Checker"),
      interactor: aiText("交互程序", "Interactor"),
      manager: aiText("通信管理程序", "Communication manager")
    })[role] || role;
  return (
    <p className={style.jobDetail}>
      {scoring &&
        (scoring.status === "kept"
          ? aiText(
              `保留题目的计分设置（${scoring.subtasks} 个子任务）`,
              `Scoring settings kept (${scoring.subtasks} ${scoring.subtasks === 1 ? "subtask" : "subtasks"})`
            )
          : scoring.status === "replaced"
            ? aiText(
                `已按确认替换计分设置（${scoring.subtasks} 个子任务）`,
                `Scoring settings replaced as approved (${scoring.subtasks} ${scoring.subtasks === 1 ? "subtask" : "subtasks"})`
              )
            : aiText(
                `按题面设置 ${scoring.subtasks} 个子任务`,
                `${scoring.subtasks} ${scoring.subtasks === 1 ? "subtask" : "subtasks"} from the statement`
              ))}
      {(helpers || []).map(helper => (
        <React.Fragment key={helper.role}>
          {" · "}
          {helperName(helper.role)}
          {aiText(
            helper.origin === "problem" ? "（题目自带）" : "（AI 生成）",
            helper.origin === "problem" ? " (the problem's)" : " (AI-written)"
          )}
          {`: ${helper.options}, ${helper.timeLimitMs} ms, ${helper.memoryLimitMiB} MiB`}
        </React.Fragment>
      ))}
    </p>
  );
}
