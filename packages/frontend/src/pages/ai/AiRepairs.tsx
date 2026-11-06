import React, { useState } from "react";
import { Button, Message } from "semantic-ui-react";
import { aiCall, aiText, AiJob, AiRepairRevision, AiRepairReview } from "./api";
import { failureKindName, programName } from "./AiFailureDetails";
import style from "./Ai.module.less";

/** A program's name, as a repair names it by its role ("std", "quality-alt-0", …). */
export const repairProgramName = (role: string) => {
  const candidate = /^quality-(alt|challenge)-(\d+)$/.exec(role);
  if (!candidate) return programName(role);
  const number = Number(candidate[2]) + 1;
  return candidate[1] === "alt"
    ? aiText(`另一种正解 ${number}`, `alternative ${number}`)
    : aiText(`对抗程序 ${number}`, `challenge ${number}`);
};

// A program's name in Chinese text: spaced from it when it's Latin (修复 std.cpp, 修复独立暴力解)
const before = (name: string) => (/^[\x21-\x7e]/.test(name) ? ` ${name}` : name);
const around = (name: string) => (/^[\x21-\x7e]/.test(name) ? ` ${name} ` : name);

const reviewText = (review: AiRepairReview, limits: { automatic: number; total: number }) => {
  switch (review.reason) {
    case "ATTRIBUTION":
      return aiText(
        "两个程序的结果不一致，且没有可信的依据（如题面样例）判断哪一个有误。请选择要修复的程序。",
        "Two programs disagree, and nothing trusted (such as a statement sample) says which one is wrong. Choose the program to repair."
      );
    case "PROBLEM_HELPER":
      return aiText(
        `题目自带的${around(programName(review.role))}失败了。AI 任务不会修改题目自带的程序：请在题目的评测设置中修正后重试。`,
        `The problem's own ${programName(review.role)} failed. The job never changes the problem's own programs: fix it in the problem's judging settings, then retry.`
      );
    case "TUTORIAL_REFERENCE":
      return aiText(
        "标程来自题解的代码。修复会用单独的程序替换它，题解本身不变。",
        "The reference solution is the tutorial's code. Repairing it replaces it with a separate program; the tutorial stays as it is."
      );
    case "CAPACITY":
      return aiText(
        "找到了能拦截错误或低效算法的输入，但没有可以替换的测试点。可以用更多的测试点重新生成。",
        "An input that rejects a wrong or slow algorithm was found, but no test case could be replaced with it. Generating more test cases leaves room for it."
      );
    case "BUDGET":
      return aiText("这次运行用完了全部执行时间预算。", "The run used its whole execution time budget.");
    case "REPAIR_LIMIT":
      return review.roles.length
        ? aiText(
            `任务已自动修复 ${limits.automatic} 次，不再自动修复。你可以选择修复一个程序。`,
            `The job made its ${limits.automatic} automatic repairs and makes no more by itself. You can choose a program to repair.`
          )
        : aiText(
            `任务已进行了允许的全部 ${limits.total} 次修复。`,
            `The job made all ${limits.total} repairs it may make.`
          );
    case "UNCHANGED":
      return aiText(
        "修复没有改变这个失败：程序仍以同样的方式失败。",
        "A repair didn't change the failure: the program still fails the same way."
      );
    case "IDENTICAL":
      return aiText("模型给出的程序与原程序完全相同。", "The model proposed the program unchanged.");
    case "INVALID":
      return aiText("模型给出的不是一个有效的此类程序。", "The model's proposal wasn't a valid program of its kind.");
    case "STALE":
      return aiText("程序在失败之后已经改变，这个失败不再说明现在的程序。", "The program changed since it failed.");
    case "INFRASTRUCTURE":
      return aiText(
        "重新运行同样的程序后，评测环境再次出现故障（不是程序的问题）。请稍后重试。",
        "The infrastructure failed again after the programs were run again (not the programs). Retry later."
      );
    case "EVIDENCE":
      return aiText(
        "失败的证据未能保存，无法用它检验修复。",
        "The failure's evidence couldn't be kept, so a repair couldn't be tested against it."
      );
    default:
      return aiText(
        "失败中没有信息说明应修复任务的哪个程序。",
        "Nothing in the failure says which of the job's programs to repair."
      );
  }
};

const testText = (revision: AiRepairRevision) => {
  if (revision.rejected === "IDENTICAL") return aiText("未采用：程序没有改变", "not used: the program was unchanged");
  if (revision.rejected === "INVALID") return aiText("未采用：不是有效的程序", "not used: not a valid program");
  return (
    {
      passed: aiText("通过了保存的失败", "passed the kept failure"),
      failed: aiText("仍未通过保存的失败", "still fails the kept failure"),
      unstable: aiText("只在部分运行中通过保存的失败", "passed the kept failure in some runs only"),
      untested: aiText(
        "未单独检验（失败不属于该程序或未能保存）",
        "not tested alone (the failure isn't this program's, or wasn't kept)"
      )
    }[revision.test] || ""
  );
};

const resultText = (result?: string) =>
  !result
    ? ""
    : result === "passed"
      ? aiText("之后的完整运行通过", "the run after it passed")
      : aiText(`之后的运行：${failureKindName(result)}`, `the run after it: ${failureKindName(result)}`);

/** What a repair changed in its program, read when the owner asks for it (review Part III, §8.1). */
export function RepairChange({ jobId, revision }: { jobId: string; revision: AiRepairRevision }) {
  const [change, setChange] = useState<{ text: string; truncated: boolean }>(null),
    [open, setOpen] = useState(false),
    [error, setError] = useState("");
  const toggle = async () => {
    if (!open && !change)
      try {
        setChange(await aiCall("repairChange", { jobId, round: revision.round }));
        setError("");
      } catch (e) {
        setError(e.message);
        return;
      }
    setOpen(!open);
  };
  const { added, removed } = revision.diff;
  return (
    <>
      {" "}
      <Button size="mini" type="button" basic onClick={toggle}>
        {open
          ? aiText("隐藏修改", "Hide change")
          : aiText(`查看修改（+${added} −${removed}）`, `Show change (+${added} −${removed})`)}
      </Button>
      {error && <span className={style.jobError}> {error}</span>}
      {open && change && (
        <pre className={style.repairDiff}>
          {change.text.split("\n").map((line, index) => (
            <span
              key={index}
              className={line.startsWith("+") ? style.diffAdded : line.startsWith("-") ? style.diffRemoved : undefined}
            >
              {`${line}\n`}
            </span>
          ))}
          {change.truncated && aiText("……（修改过长，只显示开头）", "… (a long change: only its start is shown)")}
        </pre>
      )}
    </>
  );
}

/**
 * A job's repairs (review Part III, W04): the programs it replaced, each tested against the failure it repaired, and,
 * when it stopped for its owner, why and the programs they may have repaired.
 */
export default function AiRepairs({
  job,
  busy,
  onRetry
}: {
  job: AiJob;
  busy: boolean;
  onRetry: (retryFrom: "repair" | "regenerate", role?: string) => void;
}) {
  const repair = job.result.repair;
  if (!repair) return null;
  const { review, revisions, limits } = repair;
  const roles = job.repairRoles || [];
  return (
    <>
      {job.status === "failed" && review && (
        <Message warning size="small" className={style.repairReview}>
          <Message.Header>{aiText("任务暂停，等待你的决定", "The job stopped for your decision")}</Message.Header>
          {/* The failure, unless the job's card shows it (a stop before the run, after a repair the owner chose) */}
          {!job.result.failure && (
            <p>
              {failureKindName(review.kind)}
              {review.role && ` · ${repairProgramName(review.role)}`}
              {review.subject && ` · ${review.subject}`}
            </p>
          )}
          <p>{reviewText(review, limits)}</p>
          <div className={style.repairActions}>
            {roles.map((role, index) => (
              <Button
                key={role}
                size="mini"
                type="button"
                primary={index === 0}
                disabled={busy}
                onClick={() => onRetry("repair", role)}
              >
                {aiText(`修复${before(repairProgramName(role))}`, `Repair ${repairProgramName(role)}`)}
              </Button>
            ))}
            {job.retryOptions?.includes("regenerate") && (
              <Button size="mini" type="button" basic disabled={busy} onClick={() => onRetry("regenerate")}>
                {aiText("重新编写全部程序", "Write all programs again")}
              </Button>
            )}
          </div>
        </Message>
      )}
      {revisions.length > 0 && (
        <div className={style.repairs}>
          <p className={style.jobDetail}>
            <strong>{aiText("修复记录", "Repairs")}</strong>
            {aiText(
              ` · 自动修复 ${repair.automatic}/${limits.automatic} 次`,
              ` · ${repair.automatic} of ${limits.automatic} automatic repairs made`
            )}
          </p>
          <ol className={style.repairList}>
            {revisions.map(revision => (
              <li key={revision.round}>
                {repairProgramName(revision.role)}
                {` · ${failureKindName(revision.failure.kind)}`}
                {revision.failure.subject && ` (${revision.failure.subject})`}
                {" · "}
                {revision.by === "owner"
                  ? aiText("由你选择", "you chose it")
                  : aiText("任务自动修复", "made by the job")}
                {` · ${testText(revision)}`}
                {revision.result && ` · ${resultText(revision.result)}`}
                {revision.diff && <RepairChange jobId={job.id} revision={revision} />}
              </li>
            ))}
          </ol>
        </div>
      )}
      {repair.pending && ["queued", "running"].includes(job.status) && (
        <p className={style.jobDetail}>
          {aiText(
            `将先修复${before(repairProgramName(repair.pending.role))}，再重新运行全部程序。`,
            `Repairing ${repairProgramName(repair.pending.role)} first, then running all programs again.`
          )}
        </p>
      )}
    </>
  );
}
