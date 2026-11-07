import React, { useRef, useState } from "react";
import { Button, Header, Message, Table } from "semantic-ui-react";
import { observer } from "mobx-react";
import { appState } from "@/appState";
import { defineRoute } from "@/AppRouter";
import { Link } from "@/utils/hooks";
import formatDateTime from "@/utils/formatDateTime";
import formatFileSize from "@/utils/formatFileSize";
import {
  actionName,
  aiCall,
  aiError,
  aiText,
  attentionText,
  AiJob,
  AiJobDetail,
  AiTimelineEntry,
  AiRetryFrom,
  stageKindName
} from "./api";
import { useAiPoll } from "./useAiPoll";
import { elapsedText, problemLabel, stepText } from "./AiJobs";
import AiBlocking from "./AiBlocking";
import AiWorkflow from "./AiWorkflow";
import AiPlanIssues from "./AiPlanIssues";
import AiScoringReview, { AiJudgingSummary, AiRunSummary } from "./AiScoringReview";
import AiRepairs from "./AiRepairs";
import AiTutorialBinding from "./AiTutorialBinding";
import AiCoverage from "./AiCoverage";
import AiEvidence from "./AiEvidence";
import AiFailureDetails from "./AiFailureDetails";
import style from "./Ai.module.less";

const retryLabel = (option: AiRetryFrom) =>
  ({
    "replace-scoring": aiText("确认新的计分设置并继续", "Approve the new scoring and continue"),
    "validate-samples": aiText("重新校验样例（样例已修正）", "Retry sample validation (samples corrected)"),
    std: aiText("重新生成 std.cpp（标程错误）", "Regenerate std.cpp (incorrect solution)"),
    repair: aiText("用修复后的程序继续", "Continue with the repaired program"),
    regenerate: aiText("重新设计（新的方法与程序）", "Start over with a new method and programs")
  })[option] || option;

const cancellationName = (status: string) =>
  ({
    not_requested: aiText("未请求取消", "not requested"),
    requested: aiText("已向服务商请求取消", "cancel requested from the provider"),
    confirmed: aiText("服务商已确认取消", "cancelled by the provider"),
    failed: aiText("取消请求失败", "cancel request failed"),
    unsupported: aiText("服务商不支持取消", "provider can't cancel it"),
    not_needed: aiText("无需取消（已结束或未发出）", "not needed (finished or never sent)")
  })[status] || status;

const count = (value: number | null) => (value == null ? "—" : value.toLocaleString());
const dependency = (name: string) => name.replace(/[_-]/g, " ");

function AllocationReview({ detail, onApprove, busy }: { detail: AiJobDetail; onApprove: () => void; busy: boolean }) {
  const review = detail.allocationReview;
  return (
    <section className={style.detailSection}>
      <Header as="h3">{aiText("测试点数量的变化需要确认", "Test case counts need your approval")}</Header>
      <p className={style.notes}>
        {aiText(
          "已发布的部分分题目的测试点数量会改变，这会改变每个测试点的分值。确认后任务重新排队，发布前仍会再次检查权限和题目快照。",
          "The released partial-credit subtasks would get a different number of cases, which changes what each case is worth. Approving requeues the job; permissions and the problem snapshot are checked again before publishing."
        )}
      </p>
      <div className={style.tableScroll}>
        <Table compact="very" unstackable size="small">
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{aiText("子任务", "Subtask")}</Table.HeaderCell>
              <Table.HeaderCell>{aiText("计分", "Scoring")}</Table.HeaderCell>
              <Table.HeaderCell>{aiText("现在", "Now")}</Table.HeaderCell>
              <Table.HeaderCell>{aiText("之后", "Proposed")}</Table.HeaderCell>
              <Table.HeaderCell>{aiText("每个测试点的分值", "Points per case")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {review.changes.map(change => (
              <Table.Row key={change.subtask}>
                <Table.Cell>{change.subtask + 1}</Table.Cell>
                <Table.Cell>{change.scoringType}</Table.Cell>
                <Table.Cell>{change.previousCount}</Table.Cell>
                <Table.Cell>{change.proposedCount}</Table.Cell>
                <Table.Cell>
                  {change.proposedPointsPerCase == null
                    ? aiText("（按乘积计分，无单点分值）", "(product scoring: no per-case share)")
                    : `${[...new Set(change.previousPoints.map(p => (p == null ? "—" : String(p))))].join("/")} → ${
                        change.proposedPointsPerCase
                      }`}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
      <Button primary size="small" type="button" disabled={busy} onClick={onApprove}>
        {aiText("确认并继续", "Approve and continue")}
      </Button>
    </section>
  );
}

function Counters({ detail }: { detail: AiJobDetail }) {
  const { cases, ...c } = detail.counters;
  return (
    <section className={style.detailSection}>
      <Header as="h3">{aiText("计数", "Counts")}</Header>
      <dl className={style.facts}>
        <dt>{aiText("测试点", "Test cases")}</dt>
        <dd>
          {aiText(
            `请求 ${count(cases.requested)} · 计划 ${count(cases.planned)} · 已生成 ${count(cases.generated)} · 已验证 ${count(cases.qualified)} · 已启用 ${count(cases.activated)}`,
            `requested ${count(cases.requested)} · planned ${count(cases.planned)} · generated ${count(cases.generated)} · qualified ${count(cases.qualified)} · activated ${count(cases.activated)}`
          )}
        </dd>
        <dt>{aiText("模型", "Model")}</dt>
        <dd>
          {aiText(
            `${c.logicalGenerations} 次生成${c.legacyGenerationRequests ? `（另有 ${c.legacyGenerationRequests} 次旧记录无法关联）` : ""}，${c.responsePolls} 次获取后台结果的轮询（不是新的生成）`,
            `${c.logicalGenerations} ${c.logicalGenerations === 1 ? "generation" : "generations"}${c.legacyGenerationRequests ? ` (plus ${c.legacyGenerationRequests} older unlinked records)` : ""}, ${c.responsePolls} polls for background answers (not new generations)`
          )}
        </dd>
        <dt>{aiText("问题", "Problems")}</dt>
        <dd>
          {aiText(
            `${c.failedProviderRequests} 次服务请求失败 · ${c.rejectedPlans} 个方案被拒绝 · ${c.invalidCandidates} 个无效的待拦截算法 · ${c.failedQualifications} 次验证失败`,
            `${c.failedProviderRequests} failed provider requests · ${c.rejectedPlans} rejected plans · ${c.invalidCandidates} invalid candidates · ${c.failedQualifications} failed qualifications`
          )}
        </dd>
      </dl>
      {detail.usage.reported && (
        <p className={style.notes}>
          {aiText(
            `已报告 token：输入 ${count(detail.usage.reported.inputTokens)}，输出 ${count(detail.usage.reported.outputTokens)}。`,
            `Reported tokens: ${count(detail.usage.reported.inputTokens)} input, ${count(detail.usage.reported.outputTokens)} output.`
          )}{" "}
          {aiText(
            "服务商未报告的用量记为未知，不按 0 计算；保留的记录不能证明这是全部费用。",
            "Usage a provider didn't report is unknown, not zero; the retained records can't prove this is the whole bill."
          )}
        </p>
      )}
    </section>
  );
}

function Cancellation({ detail }: { detail: AiJobDetail }) {
  const { localCancelled, generations, truncated } = detail.providerCancellation;
  if (!localCancelled && !generations.some(g => g.status !== "not_requested")) return null;
  return (
    <section className={style.detailSection}>
      <Header as="h3">{aiText("取消", "Cancellation")}</Header>
      {localCancelled && (
        <p>
          {aiText(
            "已在本站取消。这不代表模型服务也已停止；各次生成的服务商状态如下。",
            "Cancel requested locally. That doesn't mean the provider stopped too; each generation's provider status is below."
          )}
        </p>
      )}
      <ul className={style.runList}>
        {generations.map((generation, i) => (
          <li key={generation.id || i}>
            {generation.purpose ? actionName(generation.purpose) : aiText("生成", "Generation")} ·{" "}
            {cancellationName(generation.status)}
            {generation.error && ` · ${generation.error}`}
            {generation.identityStatus === "legacy_unlinked" && aiText("（旧记录）", " (older record)")}
          </li>
        ))}
      </ul>
      {truncated && (
        <p className={style.notes}>{aiText("只显示最近的生成。", "Only the latest generations are shown.")}</p>
      )}
    </section>
  );
}

const outcomeName = (outcome: string) =>
  ({
    advanced: aiText("继续", "advanced"),
    completed: aiText("完成", "completed"),
    failed: aiText("失败", "failed"),
    cancelled: aiText("已取消", "cancelled"),
    interrupted: aiText("被中断（之后恢复）", "interrupted (recovered later)"),
    running: aiText("进行中", "running")
  })[outcome] || outcome;

function TimelineEntry({ entry, children }: { entry: AiTimelineEntry; children?: React.ReactNode }) {
  const duration =
    entry.durationMs ?? (entry.endedAt ? Date.parse(entry.endedAt) - Date.parse(entry.startedAt) : undefined);
  const outcome = entry.outcome || entry.status;
  const dispatch = entry.scope === "dispatch";
  return (
    <li data-outcome={outcome || "running"}>
      {dispatch ? (
        <>
          {entry.policy === "search" ? aiText("检索", "Search") : aiText("模型生成", "Model generation")}
          {entry.model && ` · ${entry.model}`}
          {entry.policy && entry.policy !== "search" && ` · ${entry.policy.replace(/_/g, " ")}`}
        </>
      ) : (
        <>
          <strong>{stageKindName(entry.stage)}</strong>
          {entry.step && entry.step !== entry.stage && ` · ${stepText(entry.step)}`}
        </>
      )}
      {(entry.workflowAttempt ?? entry.attempt) > 1 &&
        aiText(
          ` · 第 ${entry.workflowAttempt ?? entry.attempt} 次`,
          ` · attempt ${entry.workflowAttempt ?? entry.attempt}`
        )}
      <span className={style.notes}>
        {" · "}
        {formatDateTime(entry.startedAt)[1]}
        {duration != null && ` · ${elapsedText(duration)}`}
        {outcome && ` · ${outcomeName(outcome)}`}
        {entry.requests != null &&
          aiText(
            ` · ${entry.requests} 次请求${entry.responsePolls ? `、${entry.responsePolls} 次轮询` : ""}${
              entry.failedRequests ? `、${entry.failedRequests} 次失败` : ""
            }`,
            ` · ${entry.requests} ${entry.requests === 1 ? "request" : "requests"}${
              entry.responsePolls ? `, ${entry.responsePolls} polls` : ""
            }${entry.failedRequests ? `, ${entry.failedRequests} failed` : ""}`
          )}
        {entry.resumptions?.length > 0 &&
          aiText(
            ` · 恢复 ${entry.resumptions.length} 次（不是新的生成）`,
            ` · recovered ${entry.resumptions.length} ${entry.resumptions.length === 1 ? "time" : "times"} (not a new generation)`
          )}
      </span>
      {(entry.reuses?.length > 0 || entry.invalidates?.length > 0) && (
        <div className={style.notes}>
          {entry.reuses?.length > 0 &&
            aiText(
              `复用：${entry.reuses.map(dependency).join("、")}。`,
              `Reused ${entry.reuses.map(dependency).join(", ")}. `
            )}
          {entry.invalidates?.length > 0 &&
            aiText(
              `重新检查：${entry.invalidates.map(dependency).join("、")}。`,
              `Rechecked ${entry.invalidates.map(dependency).join(", ")}.`
            )}
        </div>
      )}
      {children}
    </li>
  );
}

/** One timeline: each step's attempts, with the model and search dispatches made in it (review Part V, §10.2). */
function Timeline({ detail }: { detail: AiJobDetail }) {
  const { entries, omitted, legacyHistoryUnavailable } = detail.timeline;
  if (!entries.length && !legacyHistoryUnavailable) return null;
  const steps = new Set(entries.filter(entry => entry.scope !== "dispatch").map(entry => entry.id));
  const children = new Map<string, AiTimelineEntry[]>();
  for (const entry of entries)
    if (entry.scope === "dispatch" && entry.parentId && steps.has(entry.parentId))
      children.set(entry.parentId, [...(children.get(entry.parentId) || []), entry]);
  const nested = new Set([...children.values()].flat().map(entry => entry.id));
  return (
    <section className={style.detailSection}>
      <Header as="h3">{aiText("执行记录", "Timeline")}</Header>
      {legacyHistoryUnavailable && (
        <p className={style.notes}>
          {aiText("这个任务较早的记录没有保留。", "This job's earlier history wasn't retained.")}
        </p>
      )}
      <ol className={style.timeline}>
        {entries
          .filter(entry => !nested.has(entry.id))
          .map(entry => (
            <TimelineEntry key={entry.id} entry={entry}>
              {children.has(entry.id) && (
                <ul className={style.timelineDispatches}>
                  {children.get(entry.id).map(dispatch => (
                    <TimelineEntry key={dispatch.id} entry={dispatch} />
                  ))}
                </ul>
              )}
            </TimelineEntry>
          ))}
      </ol>
      {omitted > 0 && (
        <p className={style.notes}>
          {aiText(`省略了 ${omitted} 条较早的记录。`, `${omitted} earlier entries omitted.`)}
        </p>
      )}
      <p className={style.notes}>
        {aiText(
          "用时是墙钟时间（含等待模型回答），不是 CPU 时间或计费。",
          "Times are wall-clock (including waiting for the model), not CPU time or billing."
        )}
      </p>
    </section>
  );
}

function Technical({ detail }: { detail: AiJobDetail }) {
  const t = detail.technical;
  const roles = t.profiles?.roles ? Object.entries(t.profiles.roles as Record<string, any>) : [];
  return (
    <details className={style.detailSection}>
      <summary>{aiText("技术信息", "Technical details")}</summary>
      <dl className={style.facts}>
        {t.problemType && (
          <>
            <dt>{aiText("题目类型", "Problem type")}</dt>
            <dd>
              {t.problemType}
              {t.protocolMode && ` · ${t.protocolMode}`}
            </dd>
          </>
        )}
        {t.executionMode && (
          <>
            <dt>{aiText("运行位置", "Runs on")}</dt>
            <dd>{t.executionMode === "local" ? aiText("本机", "this server") : aiText("评测机", "judges")}</dd>
          </>
        )}
        {t.limits && (
          <>
            <dt>{aiText("限制", "Limits")}</dt>
            <dd>
              {t.limits.timeLimitMs ?? "—"} ms · {t.limits.memoryLimitMiB ?? "—"} MiB
            </dd>
          </>
        )}
        {t.allocationMode && (
          <>
            <dt>{aiText("测试点分配", "Case allocation")}</dt>
            <dd>
              {t.allocationMode === "coverage"
                ? aiText("按覆盖需要", "by coverage")
                : aiText("按分值比例（旧方式）", "by score ratio (older jobs)")}
            </dd>
          </>
        )}
        {t.sourceRevision?.digest && (
          <>
            <dt>{aiText("程序版本", "Program revision")}</dt>
            <dd>
              <code>{String(t.sourceRevision.digest).slice(0, 16)}</code>
              {Array.isArray(t.sourceRevision.repairs)
                ? aiText(`，${t.sourceRevision.repairs.length} 次修复`, `, ${t.sourceRevision.repairs.length} repairs`)
                : typeof t.sourceRevision.repairs === "number" &&
                  aiText(`，${t.sourceRevision.repairs} 次修复`, `, ${t.sourceRevision.repairs} repairs`)}
            </dd>
          </>
        )}
        {t.execution?.runtime && (
          <>
            <dt>{aiText("执行环境", "Executed by")}</dt>
            <dd>
              {t.execution.origin === "local" ? aiText("本机", "this server") : aiText("评测机", "a judge")} ·{" "}
              {t.execution.runtime.arch}
              {t.execution.qualityPolicy != null &&
                aiText(` · 质量规则 v${t.execution.qualityPolicy}`, ` · quality policy v${t.execution.qualityPolicy}`)}
            </dd>
          </>
        )}
        {t.finalCorpus?.length > 0 && (
          <>
            <dt>{aiText("最终数据", "Final data")}</dt>
            <dd>
              {aiText(
                `${t.finalCorpus.length} 个测试点，共 ${formatFileSize(
                  t.finalCorpus.reduce((s, c) => s + c.input.size, 0),
                  1
                )} 输入`,
                `${t.finalCorpus.length} cases, ${formatFileSize(
                  t.finalCorpus.reduce((s, c) => s + c.input.size, 0),
                  1
                )} of input`
              )}
            </dd>
          </>
        )}
        {detail.ioProfile && (
          <>
            <dt>{aiText("保存数据", "Saving data")}</dt>
            <dd>
              {aiText(
                `校验 ${detail.ioProfile.verificationMs} ms，发布 ${detail.ioProfile.publicationMs} ms，${detail.ioProfile.files} 个文件，${formatFileSize(detail.ioProfile.bytes, 1)}`,
                `verified in ${detail.ioProfile.verificationMs} ms, published in ${detail.ioProfile.publicationMs} ms, ${detail.ioProfile.files} files, ${formatFileSize(detail.ioProfile.bytes, 1)}`
              )}
              {!detail.ioProfile.complete && aiText("（不完整）", " (incomplete)")}
            </dd>
          </>
        )}
      </dl>
      {roles.length > 0 && (
        <div className={style.tableScroll}>
          <Table compact="very" unstackable size="small">
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{aiText("程序", "Program")}</Table.HeaderCell>
                <Table.HeaderCell>{aiText("编译", "Compiler")}</Table.HeaderCell>
                <Table.HeaderCell>{aiText("时间", "Time")}</Table.HeaderCell>
                <Table.HeaderCell>{aiText("内存", "Memory")}</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {roles.map(([role, profile]) => (
                <Table.Row key={role}>
                  <Table.Cell>{role}</Table.Cell>
                  <Table.Cell>
                    {profile.compileAndRunOptions
                      ? `${profile.compileAndRunOptions.compiler} ${profile.compileAndRunOptions.std} -O${profile.compileAndRunOptions.O}`
                      : "—"}
                  </Table.Cell>
                  <Table.Cell>{profile.timeLimitMs} ms</Table.Cell>
                  <Table.Cell>{profile.memoryLimitMiB} MiB</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
      {detail.requestFailures.length > 0 && (
        <>
          <Header as="h4">{aiText("失败的服务请求", "Failed provider requests")}</Header>
          <ul className={style.runList}>
            {detail.requestFailures.map(failure => (
              <li key={failure.id}>
                {failure.target === "search" ? aiText("搜索", "Search") : aiText("模型", "Model")} · {failure.host}
                {failure.model && ` · ${failure.model}`}
                {failure.diagnostics?.httpStatus && ` · HTTP ${failure.diagnostics.httpStatus}`}
                {failure.diagnostics?.providerCode && ` · ${failure.diagnostics.providerCode}`}
                {failure.errorCode && ` · ${failure.errorCode}`}
                {failure.diagnostics?.requestId && (
                  <span className={style.notes}>
                    {aiText(" · 请求 ID ", " · request ID ")}
                    <code>{failure.diagnostics.requestId}</code>
                  </span>
                )}
                <span className={style.notes}> · {formatDateTime(failure.createdAt)[1]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {detail.usage.limitations.length > 0 && (
        <ul className={style.runList}>
          {detail.usage.limitations.map(limitation => (
            <li key={limitation} className={style.notes}>
              {limitation}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

// Warnings shown with a job's results
export const JOB_WARNINGS = [
  "GENERATED_DATA_REVIEW_RECOMMENDED",
  "REFERENCE_SAMPLES_UNAVAILABLE",
  "TUTORIAL_REFERENCE_REJECTED",
  "PROTOCOL_ATTACHMENT_SAMPLES_NOT_APPLICABLE",
  "TESTDATA_QUALITY_PROTOCOL_UNSUPPORTED",
  "CASE_CAPACITY_ADJUSTED",
  "DIFFERENTIAL_INPUTS_REPEATED",
  "FINAL_CASES_REPEATED",
  "source_unverified",
  "OPTIONAL_REFERENCE_SEARCH_UNAVAILABLE",
  "SOURCE_REVIEW_REQUIRED"
];

/** What the job made: its reference solution, tutorials, case count and warnings. */
function Results({ job, warnings }: { job: AiJob; warnings: string[] }) {
  const { result } = job;
  const requested = result.requestedCount != null && result.requestedCount !== result.generatedCount;
  return (
    <section className={style.detailSection}>
      {result.generatedCount != null && (
        <p className={style.jobDetail}>
          {aiText(
            `${result.generatedCount} 个测试点${requested ? `（请求 ${result.requestedCount} 个）` : ""}`,
            `${result.generatedCount} test ${result.generatedCount === 1 ? "case" : "cases"}${
              requested ? ` (${result.requestedCount} requested)` : ""
            }`
          )}
        </p>
      )}
      {result.referenceSource && (
        <p className={style.jobDetail}>
          {result.referenceSource.kind === "tutorial"
            ? aiText("标程来自题解", "Reference solution from a tutorial")
            : aiText("标程由 AI 独立生成", "Reference solution generated independently by AI")}
          {result.referenceSource.discussionId && (
            <>
              {" · "}
              <Link href={`/d/${result.referenceSource.discussionId}`}>{aiText("查看题解", "View tutorial")}</Link>
            </>
          )}
          {" · "}
          {result.referenceSource.validated
            ? aiText(
                `已通过 ${result.referenceSource.samplesPassed} 组样例校验`,
                `Passed ${result.referenceSource.samplesPassed} sample ${
                  result.referenceSource.samplesPassed === 1 ? "check" : "checks"
                }`
              )
            : aiText("尚未通过样例校验", "Not yet sample-validated")}
        </p>
      )}
      {result.discussionIds && !result.tutorials?.length && (
        <p className={style.jobDetail}>
          {Object.entries(result.discussionIds).map(([locale, discussionId], index) => (
            <React.Fragment key={locale}>
              {index > 0 && " · "}
              <Link href={`/d/${discussionId}`}>{locale === "zh_CN" ? "题解-AI" : "Tutorial-AI"}</Link>
            </React.Fragment>
          ))}
        </p>
      )}
      {(warnings || result.warnings || [])
        .filter(warning => JOB_WARNINGS.includes(warning))
        .map(warning => (
          <p className={style.notes} key={warning}>
            {aiError(warning)}
          </p>
        ))}
    </section>
  );
}

/** One AI job: what blocks it first, then its options, counts, timeline and evidence (review Part V, R7). */
const AiJobPage = observer(function AiJobPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<AiJobDetail>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const poll = useAiPoll(
    async signal => {
      try {
        const reply = await aiCall<AiJobDetail | { unchanged: true; id: string; revision: number }>(
          "jobDetail",
          { id, ...(revision.current ? { ifRevision: revision.current } : {}) },
          { signal }
        );
        // An older reply never replaces a newer one
        if (signal.aborted || reply.unchanged === true || reply.revision < revision.current) return;
        revision.current = reply.revision;
        setDetail(reply as AiJobDetail);
        setError("");
      } catch (e) {
        if (!signal.aborted) setError(e.message);
      }
    },
    [id],
    3000
  );
  const act = async (method: string, body: object) => {
    setBusy(true);
    setError("");
    try {
      await aiCall(method, { id, ...body });
      poll();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const exportDiagnostic = async () => {
    setBusy(true);
    setError("");
    try {
      const data = await aiCall("exportDiagnostic", { id });
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `ai-job-${id}-diagnostics.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const job = detail?.job,
    summary = detail?.summary;
  const isActive = summary && (summary.state === "queued" || summary.state === "running");
  const blocking = detail?.blockingReason?.data;
  // A stopped job may still have a provider answer running in the background
  const remoteWork =
    !isActive &&
    detail?.providerCancellation.generations.some(
      g =>
        (g.lifecycle === "pending" || g.lifecycle === "dispatching") &&
        !["confirmed", "not_needed", "unsupported"].includes(g.status)
    );
  return (
    <div className={style.jobPage}>
      <p>
        <Link href="/ai/import">{aiText("← 我的 AI 任务", "← My AI jobs")}</Link>
      </p>
      {error && <Message negative>{error}</Message>}
      {!detail && !error && <p>{aiText("正在读取…", "Loading…")}</p>}
      {detail && (
        <>
          <Header as="h1" size="large">
            {actionName(summary.action)}
            <Header.Subheader>
              {summary.problem && <>{problemLabel(summary.problem)} · </>}
              <span className={style.jobState} data-state={summary.state}>
                {actionName(summary.state)}
              </span>
              {isActive &&
                ` · ${stageKindName(summary.stage.kind)} · ${stepText(summary.stage.step)}${
                  summary.stage.elapsedMs != null ? ` · ${elapsedText(summary.stage.elapsedMs)}` : ""
                }`}
            </Header.Subheader>
          </Header>
          {blocking ? (
            <AiBlocking reason={blocking} />
          ) : (
            detail.blockingReason && (
              <Message warning role="status">
                <Message.Header>{attentionText(detail.blockingReason)}</Message.Header>
                {detail.blockingReason.message !== attentionText(detail.blockingReason) && (
                  <p>{detail.blockingReason.message}</p>
                )}
              </Message>
            )
          )}
          {summary.state === "failed" && detail.errorCode && !blocking && (
            <p className={style.jobError} role="alert">
              {aiError(detail.errorCode)}
            </p>
          )}
          <div className={style.jobPageActions}>
            {(isActive || remoteWork) && (
              <Button size="small" type="button" disabled={busy} onClick={() => act("cancel", {})}>
                {isActive
                  ? aiText("取消", "Cancel")
                  : summary.state === "cancelled"
                    ? aiText("再次请求服务商取消", "Ask the provider to cancel again")
                    : aiText("取消服务商仍在进行的回答", "Cancel the provider's unfinished answer")}
              </Button>
            )}
            {summary.state === "failed" && !detail.allocationReview && (
              <>
                {detail.retry.options.length === 0 && (
                  <Button size="small" type="button" disabled={busy} onClick={() => act("retry", {})}>
                    {aiText("从失败步骤重试", "Retry failed step")}
                  </Button>
                )}
                {detail.retry.options
                  .filter(option => option !== "repair")
                  .map(option => (
                    <Button
                      key={option}
                      size="small"
                      type="button"
                      primary={option === "replace-scoring"}
                      disabled={busy}
                      onClick={() => act("retry", { retryFrom: option })}
                    >
                      {retryLabel(option)}
                    </Button>
                  ))}
                {detail.retry.options.includes("replace-scoring") && (
                  <Button size="small" type="button" disabled={busy} onClick={() => act("retry", {})}>
                    {aiText("重试（已修改子任务）", "Retry (subtasks changed)")}
                  </Button>
                )}
              </>
            )}
            {appState.currentUser?.isAdmin && (
              <Button size="small" type="button" basic disabled={busy} onClick={exportDiagnostic}>
                {aiText("导出诊断信息", "Export diagnostics")}
              </Button>
            )}
          </div>
          {summary.state === "failed" && (detail.retry.reuses.length > 0 || detail.retry.invalidates.length > 0) && (
            <div className={style.notes}>
              {detail.retry.reuses.length > 0 && (
                <>
                  {aiText("重试会复用：", "A retry reuses:")}
                  <ul className={style.runList}>
                    {detail.retry.reuses.map(item => (
                      <li key={item}>{dependency(item)}</li>
                    ))}
                  </ul>
                </>
              )}
              {detail.retry.invalidates.length > 0 && (
                <>
                  {aiText("会重新检查：", "It checks again:")}
                  <ul className={style.runList}>
                    {detail.retry.invalidates.map(item => (
                      <li key={item}>{dependency(item)}</li>
                    ))}
                  </ul>
                </>
              )}
              {detail.retry.newProviderGeneration &&
                aiText("可能需要新的模型生成。", "It may need a new model generation.")}
            </div>
          )}
          {detail.allocationReview && (
            <AllocationReview
              detail={detail}
              busy={busy}
              onApprove={() => act("approveAllocation", { digest: detail.allocationReview.digest })}
            />
          )}
          {job?.result.scoringReview && summary.state === "failed" && (
            <AiScoringReview review={job.result.scoringReview} />
          )}
          {detail.planIssues.length > 0 && !blocking && (
            <AiPlanIssues issues={detail.planIssues} rejections={detail.counters.rejectedPlans} />
          )}
          {job && <AiRepairs job={job} busy={busy} onRetry={(retryFrom, role) => act("retry", { retryFrom, role })} />}
          <Counters detail={detail} />
          <Cancellation detail={detail} />
          {job && <Results job={job} warnings={detail.warnings} />}
          {job && (
            <section className={style.detailSection}>
              <AiCoverage result={job.result} />
              <AiJudgingSummary result={job.result} />
              <AiRunSummary result={job.result} />
              <AiTutorialBinding job={job} busy={busy} onCorrect={() => act("correctTutorial", {})} />
            </section>
          )}
          <AiWorkflow technical={detail.technical} />
          <Timeline detail={detail} />
          {job && <AiEvidence job={job} />}
          {job && <AiFailureDetails job={job} />}
          <Technical detail={detail} />
          <p className={style.notes}>
            {aiText(`版本 ${detail.revision} · 更新于 `, `Revision ${detail.revision} · updated `)}
            {formatDateTime(summary.updatedAt)[1]}
          </p>
        </>
      )}
    </div>
  );
});

export default defineRoute(async request => <AiJobPage id={String(request.params.id)} />);
