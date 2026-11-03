import React, { useState } from "react";
import { Button, Message } from "semantic-ui-react";
import formatFileSize from "@/utils/formatFileSize";
import formatDateTime from "@/utils/formatDateTime";
import { aiCall, aiText, actionName, AiArtifact, AiJob, AiObservation } from "./api";
import style from "./Ai.module.less";

// A part of an artifact shown at a time, and at most this much of it
const SHOWN_LIMIT = 1024 * 1024;
// Characters of a failure's message shown
const SUMMARY_LIMIT = 400;

export const failureKindName = (kind: string) =>
  ({
    compile_error: aiText("编译失败", "Compilation failed"),
    validator_rejection: aiText("输入校验器拒绝了输入", "The input validator rejected an input"),
    solver_disagreement: aiText("输出不一致", "Outputs differ"),
    runtime_error: aiText("运行时错误", "Runtime error"),
    time_limit: aiText("超出时间限制", "Time limit exceeded"),
    memory_limit: aiText("超出内存限制", "Memory limit exceeded"),
    output_limit: aiText("输出过多", "Too much output"),
    checker_failure: aiText("SPJ（评测器）失败", "The checker failed"),
    invalid_challenge: aiText("对抗程序无效", "An invalid challenge program"),
    challenge_survived: aiText("错误或低效算法未被拦截", "A wrong or slow algorithm wasn't rejected"),
    insufficient_case_capacity: aiText("没有可替换的测试点", "No test case could be replaced"),
    budget_exhausted: aiText("超出执行时间预算", "The execution budget ran out"),
    infrastructure_error: aiText("评测环境故障（非程序问题）", "Infrastructure failure (not the programs)"),
    canceled: aiText("已取消", "Canceled"),
    unclassified: aiText("未分类的失败", "Unclassified failure")
  })[kind] || kind;

export const programName = (role?: string, candidate?: string) => {
  if (!role) return "";
  const names: Record<string, string> = {
    make: "make.cpp",
    std: "std.cpp",
    checker: aiText("SPJ", "checker"),
    validator: aiText("输入校验器", "input validator"),
    interactor: aiText("交互程序", "interactor"),
    manager: aiText("通信管理程序", "communication manager"),
    grader: "grader",
    "quality-small-make": aiText("小规模数据生成器", "small-case generator"),
    "quality-oracle": aiText("独立暴力解", "brute-force oracle")
  };
  if (names[role]) return names[role];
  if (role.startsWith("quality-alt-")) return aiText(`另一种正解 ${candidate || ""}`, `alternative ${candidate || ""}`);
  if (role.startsWith("quality-challenge-"))
    return aiText(`对抗程序 ${candidate || ""}`, `challenge ${candidate || ""}`);
  return role;
};

const artifactName = (role: string) =>
  ({
    input: aiText("输入", "Input"),
    actual: aiText("程序输出", "Program output"),
    expected: aiText("对照输出", "Compared with"),
    diagnostics: aiText("诊断信息", "Diagnostics")
  })[role] || role;

const basisName = (basis: string) =>
  ({
    official_sample: aiText("官方样例的输出", "the official sample's output"),
    candidate_oracle: aiText(
      "暴力解的输出（同为 AI 生成，未必正确）",
      "the oracle's output (also AI-written; not proof)"
    ),
    reference_output: aiText("标程的输出", "the reference solution's output")
  })[basis] || basis;

const classificationName = (classification: string) =>
  ({
    public: aiText("公开样例", "public sample"),
    "author-private": aiText("仅出题人可见", "author only"),
    "hidden-test": aiText("隐藏测试数据", "hidden test data")
  })[classification] || classification;

const size = (bytes: number) => formatFileSize(bytes, 1);

export function ArtifactView({
  job,
  observation,
  artifact
}: {
  job: AiJob;
  observation: AiObservation;
  artifact: AiArtifact;
}) {
  const [text, setText] = useState(artifact.preview),
    [shown, setShown] = useState<number>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const available = artifact.stored && observation.evidence !== "expired";
  const more = async () => {
    setBusy(true);
    setError("");
    try {
      const part = await aiCall<{ offset: number; bytes: number; size: number; text: string; binary: boolean }>(
        "failureArtifact",
        { jobId: job.id, id: observation.id, role: artifact.role, offset: shown ?? 0 }
      );
      setText(shown == null ? part.text : text + part.text);
      setShown((shown ?? 0) + part.bytes);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    setError("");
    try {
      const { url } = await aiCall<{ url: string }>("downloadFailureArtifact", {
        jobId: job.id,
        id: observation.id,
        role: artifact.role
      });
      window.open(url, "_blank", "noopener");
    } catch (e) {
      setError(e.message);
    }
  };
  const loaded = shown ?? Math.min(artifact.size, 2048);
  return (
    <div className={style.artifact}>
      <div className={style.artifactHeading}>
        <strong>{artifactName(artifact.role)}</strong>
        <span title={`SHA-256 ${artifact.sha256}`}>
          {" · "}
          {size(artifact.size)}
          {artifact.originalSize > artifact.size &&
            aiText(
              `（原为 ${size(artifact.originalSize)}，仅保留开头）`,
              ` (of ${size(artifact.originalSize)}: only the start was kept)`
            )}
          {" · "}
          {classificationName(artifact.classification)}
        </span>
        {available && !artifact.binary && shown == null && artifact.size > 2048 && (
          <Button size="mini" type="button" basic disabled={busy} onClick={more}>
            {aiText("显示更多", "Show more")}
          </Button>
        )}
        {available && !artifact.binary && shown != null && shown < artifact.size && shown < SHOWN_LIMIT && (
          <Button size="mini" type="button" basic disabled={busy} onClick={more}>
            {aiText("继续显示", "Show more")}
          </Button>
        )}
        {available && (
          <Button size="mini" type="button" basic onClick={download}>
            {aiText("下载", "Download")}
          </Button>
        )}
      </div>
      {!artifact.stored && artifact.missing && (
        <p className={style.notes}>
          {aiText("未保存：", "Not kept: ")}
          {artifact.missing}
        </p>
      )}
      {text && (
        <pre className={style.evidence} tabIndex={0}>
          {text}
          {loaded < artifact.size && !artifact.binary && "\n…"}
        </pre>
      )}
      {error && <Message negative size="small" content={error} />}
    </div>
  );
}

// Whether and until when the evidence is kept
function evidenceNote(observation: AiObservation) {
  const reason = observation.evidenceError ? `: ${observation.evidenceError}` : "";
  const until = formatDateTime(observation.expiresAt)[1];
  switch (observation.evidence) {
    case "stored":
      return aiText(`证据保留至 ${until}。`, `Evidence kept until ${until}.`);
    case "partial":
      return aiText(
        `证据保留至 ${until}，部分未能保存${reason}。`,
        `Evidence kept until ${until}; some of it couldn't be kept${reason}.`
      );
    case "unavailable":
      return aiText(`证据未能保存${reason}。`, `The evidence couldn't be kept${reason}.`);
    case "expired":
      return aiText("证据已过期删除。", "The evidence has expired and was deleted.");
    default:
      return "";
  }
}

export function ObservationView({ job, observation }: { job: AiJob; observation: AiObservation }) {
  const { execution, difference, search } = observation;
  const program = programName(observation.role, observation.candidate);
  return (
    <div className={style.observation}>
      <p className={style.observationHeading}>
        <strong>{failureKindName(observation.kind)}</strong>
        {program && ` · ${program}`}
        {` · ${actionName(observation.phase)}`}
        {observation.current && ` · ${aiText("使本次运行失败的原因", "ended the latest run")}`}
        {observation.context === "tutorial-reference" &&
          ` · ${aiText("题解中的代码；任务改用 AI 独立生成的标程继续", "the tutorial's code; the job went on with a model-written reference solution")}`}
        {observation.relation === "small_counterexample" &&
          ` · ${aiText("相关证据：小规模反例（未导出，不计为拦截）", "related: a small counterexample (not exported, so it rejects nothing)")}`}
      </p>
      {observation.subject && (
        <p className={style.jobDetail}>
          {observation.subject}
          {observation.subtask != null &&
            aiText(` · 子任务 ${observation.subtask}`, ` · subtask ${observation.subtask}`)}
          {observation.scenarioIndex != null &&
            aiText(
              ` · 用例编号 ${observation.scenarioIndex}（不是随机种子：生成器每次都使用新的随机数，只有保存的输入能复现）`,
              ` · case index ${observation.scenarioIndex} (not a seed: generators draw fresh randomness, so only the kept input reproduces it)`
            )}
        </p>
      )}
      {(observation.verdict || execution) && (
        <p className={style.jobDetail}>
          {[
            observation.verdict,
            execution?.status,
            execution?.exitCode != null && aiText(`退出码 ${execution.exitCode}`, `exit code ${execution.exitCode}`),
            execution?.timeMs != null &&
              `${Math.round(execution.timeMs)} ms${execution.timeLimitMs ? ` / ${execution.timeLimitMs} ms` : ""}`,
            execution?.memoryBytes != null &&
              `${size(execution.memoryBytes)}${execution.memoryLimitBytes ? ` / ${size(execution.memoryLimitBytes)}` : ""}`
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {observation.expectedBasis && (
        <p className={style.jobDetail}>
          {aiText("对照：", "Compared with ")}
          {basisName(observation.expectedBasis)}
        </p>
      )}
      {difference && (
        <p className={style.jobDetail}>
          {difference.unit === "byte"
            ? aiText(`第一处不同在字节 ${difference.index}`, `First difference at byte ${difference.index}`)
            : difference.unit === "line"
              ? aiText(`第一处不同在第 ${difference.index} 行`, `First difference at line ${difference.index}`)
              : aiText(
                  `第一处不同在第 ${difference.index} 个记号（第 ${difference.actualLine ?? difference.expectedLine} 行）`,
                  `First difference at token ${difference.index} (line ${difference.actualLine ?? difference.expectedLine})`
                )}
          {aiText("：应为 ", ": expected ")}
          <code>{difference.expected || aiText("（输出已结束）", "(end of output)")}</code>
          {aiText("，实际为 ", ", found ")}
          <code>{difference.actual || aiText("（输出已结束）", "(end of output)")}</code>
        </p>
      )}
      {search && (
        <p className={style.jobDetail}>
          {search.stoppedBy === "capacity"
            ? aiText(
                `针对性反例搜索在 ${search.attempts}/${search.budget} 次尝试后停止：没有可替换的测试点，因此无法继续（并非找不到反例）`,
                `The extra search for counterexamples stopped after ${search.attempts} of ${search.budget} attempts: no test case could be replaced, so it couldn't go on (it didn't fail to find one)`
              )
            : aiText(
                `针对性反例搜索已用完全部 ${search.budget} 次尝试，仍未拦截`,
                `The extra search for counterexamples used all ${search.budget} of its attempts without rejecting it`
              )}
        </p>
      )}
      <p className={style.observationSummary}>
        {/* A compiler's message is long: all of it is in the diagnostics */}
        {observation.summary.length > SUMMARY_LIMIT
          ? `${observation.summary.slice(0, SUMMARY_LIMIT)}…`
          : observation.summary}
      </p>
      {evidenceNote(observation) && <p className={style.notes}>{evidenceNote(observation)}</p>}
      {observation.artifacts.map(artifact => (
        <ArtifactView key={artifact.role} job={job} observation={observation} artifact={artifact} />
      ))}
    </div>
  );
}

/** The failed runs of a job, kept with their evidence: for its owner to see what failed and why. */
export default function AiFailureDetails({ job }: { job: AiJob }) {
  const [open, setOpen] = useState(false),
    [failures, setFailures] = useState<AiObservation[]>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const count = job.result.observationCount || 0;
  if (!count) return null;
  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setLoading(true);
    setError("");
    try {
      const result = await aiCall<{ failures: AiObservation[] }>("failures", { jobId: job.id });
      setFailures(result.failures);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className={style.failures}>
      <Button size="mini" type="button" basic aria-expanded={open} disabled={loading} onClick={toggle}>
        {open
          ? aiText("隐藏失败详情", "Hide failure details")
          : aiText(`失败详情（${count}）`, `Failure details (${count})`)}
      </Button>
      {open && error && <Message negative size="small" content={error} />}
      {open &&
        failures &&
        failures.map(observation => <ObservationView key={observation.id} job={job} observation={observation} />)}
    </div>
  );
}
