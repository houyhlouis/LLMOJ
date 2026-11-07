import React, { useEffect, useRef, useState } from "react";
import { Button, Header, Message } from "semantic-ui-react";
import { observer } from "mobx-react";
import { Link } from "@/utils/hooks";
import {
  aiCall,
  aiText,
  actionName,
  attentionText,
  AiJobSection,
  AiJobSummary,
  AiJobSummaryResponse,
  stageKindName
} from "./api";
import { newestRevisions, useAiPoll } from "./useAiPoll";
import style from "./Ai.module.less";

const SECTIONS: AiJobSection[] = ["attention", "active", "history"];

export const elapsedText = (ms: number | null) => {
  if (ms == null || ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return aiText(`${seconds} 秒`, `${seconds}s`);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return aiText(`${minutes} 分 ${seconds % 60} 秒`, `${minutes}m ${seconds % 60}s`);
  return aiText(`${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`, `${Math.floor(minutes / 60)}h ${minutes % 60}m`);
};

export const stepText = (step: string) => step.split(".").map(actionName).join(" · ");

export function problemLabel(problem: AiJobSummary["problem"]) {
  if (!problem) return null;
  const href = problem.displayId != null ? `/p/${problem.displayId}` : `/p/id/${problem.id}`;
  const label =
    problem.displayId != null
      ? `#${problem.displayId}${problem.title ? ` ${problem.title}` : ""}`
      : `${aiText("题目", "Problem")} P${problem.id}${problem.title ? ` ${problem.title}` : ""}`;
  return <Link href={href}>{label}</Link>;
}

interface Section {
  jobs: AiJobSummary[];
  total: number;
  receivedAt: number;
}

const emptySection = (): Section => ({ jobs: [], total: 0, receivedAt: 0 });

/**
 * Compact AI job rows (review Part V, R7): jobs that need their owner and running jobs are asked for separately from
 * the job history, so a long history can't hide them. Each row links to its details page.
 */
export default observer(function AiJobs({
  problemId,
  refreshKey = 0,
  onCompleted,
  heading
}: {
  problemId?: number;
  refreshKey?: number;
  onCompleted?: () => void;
  heading?: string;
}) {
  const [sections, setSections] = useState<Record<AiJobSection, Section>>(() => ({
      attention: emptySection(),
      active: emptySection(),
      history: emptySection()
    })),
    [paused, setPaused] = useState(false),
    [error, setError] = useState(""),
    [historyLimit, setHistoryLimit] = useState(problemId ? 3 : 10),
    [onlyAttention, setOnlyAttention] = useState(false),
    [changing, setChanging] = useState<string>(null),
    [now, setNow] = useState(Date.now());
  const versions = useRef<Partial<Record<AiJobSection, string>>>({});
  const known = useRef(new Map<string, AiJobSummary>());
  const running = useRef(new Set<string>());
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;
  const scope = `${problemId}:${historyLimit}`;
  const scopeRef = useRef(scope);
  if (scopeRef.current !== scope) {
    // A new filter or page size starts again
    scopeRef.current = scope;
    versions.current = {};
    known.current = new Map();
  }

  const poll = useAiPoll(
    async signal => {
      try {
        const replies = await Promise.all(
          SECTIONS.map(section =>
            aiCall<AiJobSummaryResponse>(
              "jobsSummary",
              {
                section,
                limit: section === "history" ? historyLimit : 100,
                ...(problemId ? { problemId } : {}),
                ...(versions.current[section] ? { ifVersion: versions.current[section] } : {})
              },
              { signal }
            )
          )
        );
        if (signal.aborted) return;
        const receivedAt = Date.now();
        const changed: Partial<Record<AiJobSection, Section>> = {};
        replies.forEach((reply, i) => {
          versions.current[SECTIONS[i]] = reply.version;
          if (reply.unchanged === true) return;
          setPaused(reply.paused === true);
          changed[SECTIONS[i]] = { jobs: newestRevisions(known.current, reply.jobs), total: reply.total, receivedAt };
          for (const job of reply.jobs) {
            if (job.state === "queued" || job.state === "running") running.current.add(job.id);
            else if (job.state === "completed" && running.current.delete(job.id)) onCompletedRef.current?.();
          }
        });
        if (Object.keys(changed).length) setSections(previous => ({ ...previous, ...changed }));
        setError("");
      } catch (e) {
        if (!signal.aborted) setError(e.message);
      }
    },
    [problemId, refreshKey, historyLimit]
  );

  const active = sections.active.jobs,
    attention = sections.attention.jobs;
  const attentionTotal = Math.max(sections.attention.total, attention.length);
  // Elapsed stage time advances between unchanged replies
  useEffect(() => {
    if (!active.length) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active.length > 0]);

  const change = async (method: "cancel" | "retry", id: string) => {
    setChanging(id);
    setError("");
    try {
      await aiCall(method, { id });
      poll();
    } catch (e) {
      setError(e.message);
    } finally {
      setChanging(null);
    }
  };

  // A running job that also needs attention is listed once, with its reason
  const attentionIds = new Set(attention.map(job => job.id));
  const rows: Array<[AiJobSummary, number]> = [
    ...attention.map(job => [job, sections.attention.receivedAt] as [AiJobSummary, number]),
    ...(onlyAttention
      ? []
      : [
          ...active
            .filter(job => !attentionIds.has(job.id))
            .map(job => [job, sections.active.receivedAt] as [AiJobSummary, number]),
          ...sections.history.jobs
            .filter(job => !attentionIds.has(job.id))
            .map(job => [job, sections.history.receivedAt] as [AiJobSummary, number])
        ])
  ];
  const moreHistory = sections.history.total > sections.history.jobs.length;

  return (
    <>
      {error && <Message negative>{error}</Message>}
      {paused && active.length > 0 && (
        <Message warning>
          {aiText(
            "站点管理员已暂停 AI。排队中的任务会在恢复后从中断处继续。",
            "AI is paused by the site administrator. Queued jobs continue from where they stopped when it's resumed."
          )}
        </Message>
      )}
      {heading && rows.length > 0 && (
        <Header as="h2" className={style.jobsHeading}>
          {heading}
        </Header>
      )}
      {!problemId && attention.length > 0 && (
        <Message info size="small" className={style.inbox}>
          {aiText(
            `${attentionTotal} 个任务需要你处理。`,
            `${attentionTotal} ${attentionTotal === 1 ? "job needs" : "jobs need"} your attention.`
          )}{" "}
          <Button size="mini" type="button" basic onClick={() => setOnlyAttention(!onlyAttention)}>
            {onlyAttention ? aiText("显示全部任务", "Show all jobs") : aiText("只显示这些任务", "Show only these")}
          </Button>
        </Message>
      )}
      {rows.length > 0 && (
        <ul className={style.jobRows}>
          {rows.map(([job, receivedAt]) => {
            const isActive = job.state === "queued" || job.state === "running";
            const elapsed =
              job.stage.elapsedMs == null ? null : job.stage.elapsedMs + (isActive ? Math.max(0, now - receivedAt) : 0);
            return (
              <li className={style.jobRow} key={job.id}>
                <div className={style.jobRowMain}>
                  <Link href={`/ai/jobs/${job.id}`}>
                    <strong>{actionName(job.action)}</strong>
                  </Link>
                  {job.problem && <span className={style.jobRowProblem}>{problemLabel(job.problem)}</span>}
                  <span className={style.jobState} data-state={job.state}>
                    {actionName(job.state)}
                  </span>
                </div>
                {(isActive || job.state === "failed") && (
                  <div className={style.jobRowStage}>
                    {stageKindName(job.stage.kind)}
                    {job.stage.step && job.stage.step !== job.stage.kind && ` · ${stepText(job.stage.step)}`}
                    {elapsed != null && ` · ${elapsedText(elapsed)}`}
                  </div>
                )}
                {job.attention && (
                  <div className={style.jobRowAttention} role="status">
                    {attentionText(job.attention)}
                  </div>
                )}
                <div className={style.jobRowActions}>
                  {job.relevantAction.kind === "cancel" && (
                    <Button
                      size="mini"
                      type="button"
                      disabled={changing === job.id}
                      onClick={() => change("cancel", job.id)}
                    >
                      {aiText("取消", "Cancel")}
                    </Button>
                  )}
                  {job.relevantAction.kind === "retry" && (
                    <Button
                      size="mini"
                      type="button"
                      disabled={changing === job.id}
                      onClick={() => change("retry", job.id)}
                    >
                      {aiText("从失败步骤重试", "Retry failed step")}
                    </Button>
                  )}
                  <Link href={`/ai/jobs/${job.id}`} className={style.jobRowDetails}>
                    {job.attention || job.relevantAction.kind === "details"
                      ? aiText("查看原因与选项", "Reason and options")
                      : aiText("详情", "Details")}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!onlyAttention && moreHistory && historyLimit < 100 && (
        <Button
          size="mini"
          type="button"
          basic
          className={style.moreJobs}
          onClick={() => setHistoryLimit(Math.min(100, historyLimit + (problemId ? 10 : 20)))}
        >
          {aiText("显示更早的任务", "Show older jobs")}
        </Button>
      )}
    </>
  );
});
