import React from "react";
import { Message } from "semantic-ui-react";
import formatFileSize from "@/utils/formatFileSize";
import { aiText, AiBlockingReason, AiRunnerCapabilities, AiTaskContract, AiTaskMode } from "./api";
import AiPlanIssues from "./AiPlanIssues";
import { failureKindName, programName } from "./AiFailureDetails";
import style from "./Ai.module.less";

const program = (role?: string) => programName(role) || aiText("程序", "A program");

export const modeName = (mode: AiTaskMode | string) =>
  ({
    batch: aiText("普通程序（标准输入输出）", "Batch program (stdin/stdout)"),
    interactive_stdio: aiText("交互（标准输入输出）", "Interactive (stdin/stdout)"),
    sequential_communication: aiText("通信题（依次运行两次）", "Communication (two sequential runs)"),
    persistent_duplex: aiText("持续双向会话（两个隔离角色同时运行）", "Persistent two-role session (both roles live)")
  })[mode] || mode;

const lifetimeName = (lifetime: string) =>
  ({
    single_process: aiText("单个进程", "one process"),
    single_session: aiText("一次会话", "one session"),
    two_fresh_processes: aiText("两个依次启动的进程", "two fresh processes, one after the other"),
    two_live_isolated_roles: aiText("两个同时存活的隔离角色", "two isolated roles alive at once")
  })[lifetime] || lifetime;

const scoringName = (scoring: AiTaskContract["scoring"] | string) => {
  const [scope, reduction] = typeof scoring === "string" ? scoring.split(":") : [scoring.scope, scoring.reduction];
  const text = aiText(
    `${scope === "subtask" ? "按子任务" : "按测试点"}${
      { binary: "通过/不通过", sum: "求和", min: "取最小", max: "取最大" }[reduction] || reduction
    }`,
    `${scope === "subtask" ? "subtask-wide" : "per case"} ${
      { binary: "pass/fail", sum: "sum", min: "minimum", max: "maximum" }[reduction] || reduction
    }`
  );
  return typeof scoring === "string" || !scoring.metric ? text : `${text} (${scoring.metric})`;
};

const replayName = (replay: string) =>
  ({
    pending: aiText("待重放", "replay pending"),
    passed: aiText("重放通过", "replay passed"),
    failed: aiText("重放仍失败", "replay still fails"),
    unstable: aiText("重放结果不稳定", "replay unstable"),
    untested: aiText("未重放", "not replayed")
  })[replay] || replay;

/** The functions the task's interface requires, and which side implements each. */
export function AiInterface({ value }: { value: AiTaskContract["interface"] }) {
  return (
    <ul className={style.runList}>
      {value.functions.map(fn => (
        <li key={`${fn.owner}:${fn.name}`}>
          <code>{fn.signature || fn.name}</code>
          {" · "}
          {fn.owner === "contestant"
            ? aiText(`选手实现（${fn.role}）`, `implemented by the contestant (${fn.role})`)
            : aiText(`评测程序提供（${fn.role}）`, `provided by the grader (${fn.role})`)}
        </li>
      ))}
      {value.headers.length > 0 && (
        <li>
          {aiText("头文件：", "Headers: ")}
          {value.headers.map(header => header.name).join(", ")}
        </li>
      )}
    </ul>
  );
}

function capabilities(runner: AiRunnerCapabilities) {
  return aiText(
    `${runner.modes.map(modeName).join("、")}；计分：${runner.scoring.map(scoringName).join("、") || "无"}`,
    `${runner.modes.map(modeName).join(", ")}; scoring: ${runner.scoring.map(scoringName).join(", ") || "none"}`
  );
}

function headline(reason: AiBlockingReason): string {
  const r = reason as any;
  switch (reason.kind) {
    case "needs_configuration":
      return r.required?.mode === "persistent_duplex"
        ? aiText("不支持的持续双向两角色会话", "Unsupported persistent two-role session")
        : aiText(
            `评测机不支持：${modeName(r.required?.mode)}`,
            `Unsupported by the judges: ${modeName(r.required?.mode)}`
          );
    case "plan_schema":
      return aiText(
        `测试方案有 ${r.issues?.length || 0} 个字段需要修复`,
        `${r.issues?.length || 0} testing plan ${r.issues?.length === 1 ? "field needs" : "fields need"} repair`
      );
    case "plan_feasibility":
      return aiText("测试方案在数学上不可行，需要新的方法", "The testing plan isn't feasible and needs a new method");
    case "interface_mismatch":
      return aiText(`${program(r.role)} 不符合函数接口`, `${program(r.role)} doesn't match the function interface`);
    case "candidate_baseline":
      return r.corpus === "author_validation"
        ? aiText(
            "提出的待拦截算法已被上传的验证样例拦截",
            "Proposed challenge already rejected by an uploaded validation sample"
          )
        : aiText("提出的待拦截算法已被题面样例拦截", "Proposed challenge already rejected by a public example");
    case "qualification_failed":
      return aiText(
        `${program(r.role)}：${failureKindName(r.failureKind)}${r.subject ? `（${r.subject}）` : ""}`,
        `${program(r.role)}: ${failureKindName(r.failureKind)}${r.subject ? ` on ${r.subject}` : ""}`
      );
    case "provenance_policy":
      return aiText(
        "来源核实规则：原题未核实，暂不发布测试数据",
        "Provenance rule: the source isn't verified, so test data isn't published yet"
      );
    default:
      return reason.kind;
  }
}

/** What stops a job, first and in its own terms (review Part V, §10.1). */
export default function AiBlocking({ reason }: { reason: AiBlockingReason }) {
  const r = reason as any;
  return (
    <Message warning className={style.blocking} role="status">
      <Message.Header>{headline(reason)}</Message.Header>
      {reason.kind === "needs_configuration" && (
        <>
          <p>
            {aiText(
              "已在写题解和生成程序之前停止，没有为此花费更多模型调用。题面保留为草稿。安装支持此方式的评测机后可重试。",
              "Stopped before the tutorial and programs, so no more model calls were spent. The statement stays a draft. Retry once a capable judge is installed."
            )}
          </p>
          <dl className={style.facts}>
            <dt>{aiText("需要", "Required")}</dt>
            <dd>
              {modeName(r.required.mode)} · {lifetimeName(r.required.lifetime)} · {scoringName(r.required.scoring)}
            </dd>
            <dt>{aiText("现有评测机", "Available")}</dt>
            <dd>
              {r.available?.length
                ? r.available.map((runner: AiRunnerCapabilities, i: number) => (
                    <div key={i}>{capabilities(runner)}</div>
                  ))
                : aiText("没有可用的评测机", "No judge available")}
            </dd>
            {r.missing?.length > 0 && (
              <>
                <dt>{aiText("缺少", "Missing")}</dt>
                <dd>{r.missing.join(", ")}</dd>
              </>
            )}
          </dl>
          {r.required.interface?.functions?.length > 0 && <AiInterface value={r.required.interface} />}
        </>
      )}
      {reason.kind === "plan_schema" && (
        <>
          <p>
            {r.remaining > 0
              ? aiText(
                  "只会让模型重写这些字段，其余已通过的部分保持不变。",
                  "Only these fields will be rewritten; the parts that passed are kept."
                )
              : aiText(
                  "字段修复次数已用完。可以选择重新设计方案（新的方法与新的程序）。",
                  "The field repair is used up. You can choose to design a new plan (a new method and new programs)."
                )}
          </p>
          <AiPlanIssues issues={r.issues || []} />
        </>
      )}
      {reason.kind === "plan_feasibility" && (
        <>
          <p>
            {aiText(
              "这类问题不能只改格式：不会删除目标或放宽约束来通过检查，需要你审查或重新设计方法。",
              "This can't be fixed by formatting: targets aren't deleted and constraints aren't relaxed to pass; review it or choose a new method."
            )}
          </p>
          <AiPlanIssues issues={r.issues || []} />
        </>
      )}
      {reason.kind === "interface_mismatch" && (
        <>
          <dl className={style.facts}>
            <dt>{aiText("应实现", "Expected")}</dt>
            <dd>
              <AiInterface value={r.expected} />
            </dd>
            <dt>{aiText("提交的程序", "Proposed")}</dt>
            <dd>
              {[
                ...(r.proposed?.main ? [aiText("自带 main()", "adds its own main()")] : []),
                ...(r.proposed?.missing?.length
                  ? [aiText(`缺少 ${r.proposed.missing.join("、")}`, `missing ${r.proposed.missing.join(", ")}`)]
                  : [])
              ].join(aiText("；", "; ")) || "—"}
            </dd>
          </dl>
          <p className={style.notes}>
            {aiText(
              "这个程序没有被采用：修复必须保留题目的函数接口、进程生命周期和信息边界。",
              "This program wasn't used: a repair must keep the task's interface, process lifetime and information boundaries."
            )}
          </p>
          {r.diagnostics && (
            <pre className={style.artifactCode} tabIndex={0}>
              {r.diagnostics}
            </pre>
          )}
        </>
      )}
      {reason.kind === "candidate_baseline" && (
        <>
          <p>
            {r.sample && <code>{r.sample}</code>} {r.reason}
          </p>
          <p className={style.notes}>
            {aiText(
              "这说明现有数据已能发现这个错误，它被记为基线目标，不能算作新增强度的目标。不会通过识别样例来“修复”它。",
              "Existing data already catches this defect, so it's kept as a baseline target and can't count as new strength. It won't be “fixed” by recognizing samples."
            )}
          </p>
        </>
      )}
      {reason.kind === "qualification_failed" && (
        <dl className={style.facts}>
          {r.profile?.timeLimitMs != null && (
            <>
              <dt>{aiText("限制", "Limits")}</dt>
              <dd>
                {r.profile.timeLimitMs} ms
                {r.profile.memoryLimitMiB != null && ` · ${r.profile.memoryLimitMiB} MiB`}
              </dd>
            </>
          )}
          {r.inputSize != null && (
            <>
              <dt>{aiText("输入大小", "Input size")}</dt>
              <dd>{formatFileSize(r.inputSize, 1)}</dd>
            </>
          )}
          <dt>{aiText("重放", "Replay")}</dt>
          <dd>{replayName(r.replay)}</dd>
        </dl>
      )}
      {reason.kind === "provenance_policy" && (
        <p>
          {r.status === "not_attempted"
            ? aiText("没有进行原题检索。", "No source search was made.")
            : aiText("原题检索没有得到可核实的结果。", "The source search found nothing verifiable.")}{" "}
          {aiText(
            "这是本站或你的配置要求的来源规则，不是评测或沙箱故障。",
            "This is a provenance rule set by the site or your configuration, not a judging or sandbox failure."
          )}
        </p>
      )}
    </Message>
  );
}
