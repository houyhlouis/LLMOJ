import React, { useState } from "react";
import { Button } from "semantic-ui-react";
import { aiText, AiJob, AiJobUsage, AiRunRecord, AiSpending } from "./api";
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
 * A job's evidence and cost (review Part III, §8.4): its model generations, by what they were for, and the tokens
 * providers reported; and each run of its programs, how it ended and how long it took. Measured, never estimated.
 * A generation is one paid answer; polls that recover a background answer are transport requests, counted apart
 * (review Part IV, W01). A provider's success isn't the plan's acceptance: rejected plans are counted too.
 */
export default function AiEvidence({ job }: { job: AiJob }) {
  const [open, setOpen] = useState(false);
  const evidence = job.result.evidence;
  if (!evidence) return null;
  const spending = Object.entries(evidence.spending || {}) as [string, AiSpending][];
  // Jobs from before counted requests only: each was a generation as far as they know
  const generationsOf = (item: AiSpending) => item.generations ?? item.requests;
  const sum = (pick: (item: AiSpending) => number) => spending.reduce((total, [, item]) => total + pick(item), 0);
  const totals: AiJobUsage = evidence.usage || {
    generations: sum(generationsOf),
    requests: sum(item => item.requests),
    searches: sum(item => item.searches),
    failed: sum(item => item.failed),
    inputTokens: sum(item => item.inputTokens),
    outputTokens: sum(item => item.outputTokens),
    unreported: sum(item => item.unreported)
  };
  // Recorded before generations were told apart from polls: as many generations as requests
  const generations = totals.generations ?? totals.requests;
  // By purpose: as recorded when each request was sent, else as the job counted them (jobs from before)
  const recorded = Object.entries(totals.purposes || {});
  const byPurpose: [string, number][] = recorded.length
    ? recorded.map(([purpose, item]) => [purpose, item.generations])
    : spending.map(([purpose, item]) => [purpose, generationsOf(item)]);
  // Generations not counted by purpose (recorded without one, or not counted by an older job before it failed)
  const other = Math.max(0, generations - byPurpose.reduce((total, [, count]) => total + count, 0));
  const purposes = [
    ...byPurpose.filter(([, count]) => count > 0).map(([purpose, count]) => `${purposeName(purpose)} ${count}`),
    ...(other ? [`${purposeName("other")} ${other}`] : [])
  ];
  const transport = totals.requests - generations;
  const runs = evidence.runs || [];
  const runSeconds = runs.reduce((total, run) => total + run.seconds, 0);
  const rejected = job.result.planRejections || 0;
  return (
    <div className={style.evidence}>
      <p className={style.jobDetail}>
        <strong>{aiText("证据与开销", "Evidence and cost")}</strong>
        {" · "}
        {aiText(
          `${generations} 次模型生成${totals.failed ? `（${totals.failed} 次请求失败）` : ""}`,
          `${generations} model ${generations === 1 ? "generation" : "generations"}${totals.failed ? ` (${totals.failed} failed ${totals.failed === 1 ? "request" : "requests"})` : ""}`
        )}
        {purposes.length > 0 && aiText(`：${purposes.join("、")}`, `: ${purposes.join(", ")}`)}
        {transport > 0 &&
          aiText(
            `；另有 ${transport} 次获取后台结果的轮询请求（不是新的生成）`,
            `; ${transport} more ${transport === 1 ? "request" : "requests"} polled for background answers (not new generations)`
          )}
        {rejected > 0 &&
          aiText(
            ` · ${rejected} 个测试方案因不符合规则被拒绝`,
            ` · ${rejected} testing ${rejected === 1 ? "plan" : "plans"} rejected for breaking the plan's rules`
          )}
        {" · "}
        {aiText(
          `输入 ${number(totals.inputTokens)} 个 token，输出 ${number(totals.outputTokens)} 个`,
          `${number(totals.inputTokens)} tokens in, ${number(totals.outputTokens)} out`
        )}
        {(totals.cachedTokens > 0 || totals.reasoningTokens > 0) &&
          aiText(
            `（其中${[
              totals.cachedTokens > 0 ? `缓存输入 ${number(totals.cachedTokens)} 个` : "",
              totals.reasoningTokens > 0 ? `推理输出 ${number(totals.reasoningTokens)} 个` : ""
            ]
              .filter(Boolean)
              .join("，")}）`,
            ` (of which ${[
              totals.cachedTokens > 0 ? `${number(totals.cachedTokens)} cached input` : "",
              totals.reasoningTokens > 0 ? `${number(totals.reasoningTokens)} reasoning output` : ""
            ]
              .filter(Boolean)
              .join(", ")})`
          )}
        {totals.unreported > 0 &&
          aiText(
            `（${totals.unreported} 次生成的用量服务商未报告）`,
            ` (no usage reported for ${totals.unreported} ${totals.unreported === 1 ? "generation" : "generations"})`
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
