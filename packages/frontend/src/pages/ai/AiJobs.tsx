import React, { useEffect, useRef, useState } from "react";
import { Button, Header, Message, Progress } from "semantic-ui-react";
import { observer } from "mobx-react";
import { Link } from "@/utils/hooks";
import { aiCall, aiText, aiError, actionName, AiJob } from "./api";
import style from "./Ai.module.less";

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
  const [jobs, setJobs] = useState<AiJob[]>([]),
    [error, setError] = useState("");
  const running = useRef(new Set<string>());
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const result = await aiCall<{ jobs: AiJob[] }>("jobs", problemId ? { problemId } : {});
        if (!mounted) return;
        setJobs(result.jobs);
        setError("");
        for (const job of result.jobs) {
          if (["queued", "running"].includes(job.status)) running.current.add(job.id);
          else if (job.status === "completed" && running.current.delete(job.id)) onCompleted?.();
        }
      } catch (e) {
        if (mounted) setError(e.message);
      }
    };
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [problemId, refreshKey]);
  const [changing, setChanging] = useState<string>(null);
  const change = async (method: string, id: string, retryFrom?: "validate-samples" | "std") => {
    setChanging(id);
    setError("");
    try {
      await aiCall(method, { id, ...(retryFrom ? { retryFrom } : {}) });
      const result = await aiCall<{ jobs: AiJob[] }>("jobs", problemId ? { problemId } : {});
      setJobs(result.jobs);
    } catch (e) {
      setError(e.message);
    } finally {
      setChanging(null);
    }
  };
  return (
    <>
      {error && <Message negative>{error}</Message>}
      {heading && jobs.length > 0 && (
        <Header as="h2" className={style.jobsHeading}>
          {heading}
        </Header>
      )}
      {jobs.length > 0 && (
        <div className={style.jobs}>
          {jobs.slice(0, problemId ? 3 : 20).map(job => {
            const active = ["queued", "running"].includes(job.status);
            return (
              <div className={style.job} key={job.id}>
                <div className={style.jobHeading}>
                  <div>
                    <strong>{actionName(job.action)}</strong>
                    {job.problemId && (
                      <span>
                        {" "}
                        ·{" "}
                        <Link href={`/p/id/${job.problemId}`}>
                          {aiText("题目", "Problem")} P{job.problemId}
                        </Link>
                      </span>
                    )}
                    <span className={style.jobStatus}> · {actionName(job.status)}</span>
                    {job.result.sourceSearch && (
                      <span className={style.jobStatus}>
                        {" · "}
                        {job.result.sourceSearch.status === "verified"
                          ? aiText("原题已核实", "Source verified")
                          : job.result.sourceSearch.status === "not_found"
                          ? aiText("未找到可核实原题", "No verified source found")
                          : job.result.sourceSearch.status === "not_configured"
                          ? aiText("未配置搜索服务", "Search not configured")
                          : aiText("原题检索", "Source search")}
                        {job.result.sourceSearch.searchCount > 0 &&
                          aiText(
                            `（${job.result.sourceSearch.searchCount} 次检索）`,
                            ` (${job.result.sourceSearch.searchCount} ${
                              job.result.sourceSearch.searchCount === 1 ? "search" : "searches"
                            })`
                          )}
                      </span>
                    )}
                    {job.result.generatedCount != null && (
                      <span className={style.jobStatus}>
                        {" "}
                        ·{" "}
                        {aiText(
                          `${job.result.generatedCount} 个测试点${
                            job.result.requestedCount != null && job.result.requestedCount !== job.result.generatedCount
                              ? `（请求 ${job.result.requestedCount} 个）`
                              : ""
                          }`,
                          `${job.result.generatedCount} test ${job.result.generatedCount === 1 ? "case" : "cases"}${
                            job.result.requestedCount != null && job.result.requestedCount !== job.result.generatedCount
                              ? ` (${job.result.requestedCount} requested)`
                              : ""
                          }`
                        )}
                      </span>
                    )}
                  </div>
                  {active && (
                    <Button
                      size="mini"
                      type="button"
                      disabled={changing === job.id}
                      onClick={() => change("cancel", job.id)}
                    >
                      {aiText("取消", "Cancel")}
                    </Button>
                  )}
                  {job.status === "failed" &&
                    (job.retryOptions?.length ? (
                      job.retryOptions.map(retryFrom => (
                        <Button
                          key={retryFrom}
                          size="mini"
                          type="button"
                          disabled={changing === job.id}
                          onClick={() => change("retry", job.id, retryFrom)}
                        >
                          {retryFrom === "validate-samples"
                            ? aiText("重新校验样例（样例已修正）", "Retry sample validation (samples corrected)")
                            : aiText("重新生成 std.cpp（标程错误）", "Regenerate std.cpp (incorrect solution)")}
                        </Button>
                      ))
                    ) : (
                      <Button
                        size="mini"
                        type="button"
                        disabled={changing === job.id}
                        onClick={() => change("retry", job.id)}
                      >
                        {aiText("从失败步骤重试", "Retry failed step")}
                      </Button>
                    ))}
                </div>
                {active && (
                  <Progress
                    percent={job.progress}
                    progress
                    active
                    size="small"
                    className={style.jobProgress}
                    label={job.step.split(".").map(actionName).join(" · ")}
                  />
                )}
                {job.result.referenceSource && (
                  <p className={style.jobDetail}>
                    {job.result.referenceSource.kind === "tutorial"
                      ? aiText("标程来自题解", "Reference solution from a tutorial")
                      : aiText("标程由 AI 独立生成", "Reference solution generated independently by AI")}
                    {job.result.referenceSource.discussionId && (
                      <>
                        {" "}
                        ·{" "}
                        <Link href={`/d/${job.result.referenceSource.discussionId}`}>
                          {aiText("查看题解", "View tutorial")}
                        </Link>
                      </>
                    )}
                    {" · "}
                    {job.result.referenceSource.validated
                      ? aiText(
                          `已通过 ${job.result.referenceSource.samplesPassed} 组样例校验`,
                          `Passed ${job.result.referenceSource.samplesPassed} sample ${
                            job.result.referenceSource.samplesPassed === 1 ? "check" : "checks"
                          }`
                        )
                      : aiText("尚未通过样例校验", "Not yet sample-validated")}
                  </p>
                )}
                {(job.result.warnings || [])
                  .filter(warning =>
                    [
                      "GENERATED_DATA_REVIEW_RECOMMENDED",
                      "REFERENCE_SAMPLES_UNAVAILABLE",
                      "TUTORIAL_REFERENCE_REJECTED",
                      "PROTOCOL_ATTACHMENT_SAMPLES_NOT_APPLICABLE"
                    ].includes(warning)
                  )
                  .map(warning => (
                    <p className={style.notes} key={warning}>
                      {aiError(warning)}
                    </p>
                  ))}
                {job.result.discussionIds && (
                  <p className={style.jobDetail}>
                    {Object.entries(job.result.discussionIds).map(([locale, id], index) => (
                      <React.Fragment key={locale}>
                        {index > 0 && " · "}
                        <Link href={`/d/${id}`}>{locale === "zh_CN" ? "题解-AI" : "Tutorial-AI"}</Link>
                      </React.Fragment>
                    ))}
                  </p>
                )}
                {job.status === "failed" && (
                  <p className={style.jobError} role="alert">
                    {aiError(job.error || "INTERNAL_ERROR")}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
});
