import React, { useState } from "react";
import { Button } from "semantic-ui-react";
import { aiText, AiJob, AiRunRecord, AiSpending } from "./api";
import { failureKindName } from "./AiFailureDetails";
import style from "./Ai.module.less";

const purposeName = (purpose: string) =>
  ({
    import: aiText("导入", "import"),
    source: aiText("原题检索", "source search"),
    translate: aiText("翻译", "translation"),
    tags: aiText("标签", "tags"),
    difficulty: aiText("难度", "difficulty"),
    tutorial: aiText("题解", "tutorial"),
    plan: aiText("计划", "plans"),
    programs: aiText("编写程序", "programs"),
    repairs: aiText("修复", "repairs"),
    other: aiText("其他", "other")
  })[purpose] || purpose;

const number = (value: number) => value.toLocaleString("en-US");

export const duration = (seconds: number) => {
  if (seconds < 9.95) return aiText(`${seconds.toFixed(1)} 秒`, `${seconds.toFixed(1)} s`);
  const whole = Math.round(seconds);
  if (whole < 60) return aiText(`${whole} 秒`, `${whole} s`);
  const minutes = Math.floor(whole / 60);
  return aiText(`${minutes} 分 ${whole % 60} 秒`, `${minutes} min ${whole % 60} s`);
};

const replayResult = (result: string) =>
  ({
    reproduced: aiText("已复现", "reproduced"),
    not_reproduced: aiText("未复现", "not reproduced"),
    unstable: aiText("不稳定", "unstable"),
    different: aiText("以另一种方式失败", "failed another way")
  })[result] || result;

const runText = (run: AiRunRecord) =>
  [
    run.operation === "replay"
      ? aiText(
          `重放保存的失败${run.repair ? `，检验第 ${run.repair} 次修复` : ""}：${replayResult(run.result)}`,
          `replay of the kept failure${run.repair ? `, testing repair ${run.repair}` : ""}: ${replayResult(run.result)}`
        )
      : run.result === "passed"
        ? aiText(
            `全部程序通过${run.repair ? `（第 ${run.repair} 次修复之后）` : ""}`,
            `all programs passed${run.repair ? ` (after repair ${run.repair})` : ""}`
          )
        : aiText(
            `失败：${failureKindName(run.result)}${run.repair ? `（第 ${run.repair} 次修复之后）` : ""}`,
            `failed: ${failureKindName(run.result)}${run.repair ? ` (after repair ${run.repair})` : ""}`
          ),
    duration(run.seconds),
    run.origin === "judge"
      ? aiText("在评测机上", "on a judge machine")
      : run.origin === "local"
        ? aiText("在本机", "on this server")
        : "",
    run.reuse && (run.reuse.builds || run.reuse.inputs)
      ? aiText(
          `复用 ${[
            run.reuse.builds ? `${run.reuse.builds} 个已编译程序` : "",
            run.reuse.inputs ? `${run.reuse.inputs} 个输入` : ""
          ]
            .filter(Boolean)
            .join("、")}`,
          `${[
            run.reuse.builds ? `${run.reuse.builds} ${run.reuse.builds === 1 ? "program" : "programs"}` : "",
            run.reuse.inputs ? `${run.reuse.inputs} ${run.reuse.inputs === 1 ? "input" : "inputs"}` : ""
          ]
            .filter(Boolean)
            .join(" and ")} reused`
        )
      : ""
  ]
    .filter(Boolean)
    .join(" · ");

/**
 * A job's evidence and cost (review Part III, §8.4): its model requests, by what they were for, and the tokens
 * providers reported; and each run of its programs, how it ended and how long it took. Measured, never estimated.
 */
export default function AiEvidence({ job }: { job: AiJob }) {
  const [open, setOpen] = useState(false);
  const evidence = job.result.evidence;
  if (!evidence) return null;
  const spending = Object.entries(evidence.spending || {}) as [string, AiSpending][];
  const counted = spending.reduce((sum, [, item]) => sum + item.requests, 0);
  const totals = evidence.usage || {
    requests: counted,
    searches: spending.reduce((sum, [, item]) => sum + item.searches, 0),
    failed: spending.reduce((sum, [, item]) => sum + item.failed, 0),
    inputTokens: spending.reduce((sum, [, item]) => sum + item.inputTokens, 0),
    outputTokens: spending.reduce((sum, [, item]) => sum + item.outputTokens, 0),
    unreported: spending.reduce((sum, [, item]) => sum + item.unreported, 0)
  };
  // Requests the job didn't count by purpose (e.g. the last one before it failed)
  const other = Math.max(0, totals.requests - counted);
  const purposes = [
    ...spending
      .filter(([, item]) => item.requests > 0)
      .map(([purpose, item]) => `${purposeName(purpose)} ${item.requests}`),
    ...(other ? [`${purposeName("other")} ${other}`] : [])
  ];
  const runs = evidence.runs || [];
  const runSeconds = runs.reduce((sum, run) => sum + run.seconds, 0);
  return (
    <div className={style.evidence}>
      <p className={style.jobDetail}>
        <strong>{aiText("证据与开销", "Evidence and cost")}</strong>
        {" · "}
        {aiText(
          `${totals.requests} 次模型请求${totals.failed ? `（${totals.failed} 次失败）` : ""}`,
          `${totals.requests} model ${totals.requests === 1 ? "request" : "requests"}${totals.failed ? ` (${totals.failed} failed)` : ""}`
        )}
        {purposes.length > 0 && aiText(`：${purposes.join("、")}`, `: ${purposes.join(", ")}`)}
        {" · "}
        {aiText(
          `输入 ${number(totals.inputTokens)} 个 token，输出 ${number(totals.outputTokens)} 个`,
          `${number(totals.inputTokens)} tokens in, ${number(totals.outputTokens)} out`
        )}
        {totals.unreported > 0 &&
          aiText(
            `（${totals.unreported} 次请求服务商未报告用量）`,
            ` (the provider reported no usage for ${totals.unreported})`
          )}
        {totals.searches > 0 &&
          aiText(
            ` · ${totals.searches} 次搜索`,
            ` · ${totals.searches} ${totals.searches === 1 ? "search" : "searches"}`
          )}
        {runs.length > 0 && (
          <>
            {" · "}
            {aiText(
              `程序运行 ${runs.length} 次，共 ${duration(runSeconds)}`,
              `${runs.length} ${runs.length === 1 ? "run" : "runs"} of the programs, ${duration(runSeconds)} in all`
            )}{" "}
            <Button size="mini" type="button" basic onClick={() => setOpen(!open)}>
              {open ? aiText("隐藏运行记录", "Hide runs") : aiText("显示运行记录", "Show runs")}
            </Button>
          </>
        )}
      </p>
      {open && (
        <ol className={style.runList}>
          {runs.map((run, index) => (
            <li key={index}>{runText(run)}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
