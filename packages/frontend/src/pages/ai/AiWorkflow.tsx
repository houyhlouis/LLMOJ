import React from "react";
import { Header } from "semantic-ui-react";
import formatFileSize from "@/utils/formatFileSize";
import { aiText, AiJobDetail } from "./api";
import { AiInterface, modeName } from "./AiBlocking";
import { programName } from "./AiFailureDetails";
import style from "./Ai.module.less";

export const provenanceName = (status: string) =>
  ({
    verified: aiText("原题已核实", "Source verified"),
    unverified: aiText("原题未核实", "Source unverified"),
    not_attempted: aiText("未检索原题", "Source not searched")
  })[status] || status;

const corpusClassName = (value: string) =>
  ({
    public_example: aiText("题面样例", "Public example"),
    author_validation: aiText("作者上传的验证样例", "Author validation sample"),
    sealed_final: aiText("最终数据（封存）", "Final data (sealed)")
  })[value] || value;

const accessName = (value: string) =>
  ({
    private: aiText("不发给模型", "not sent to the model"),
    summaries: aiText("只发送摘要", "summaries only"),
    model_visible: aiText("可发送失败预览", "failure previews allowed")
  })[value] || value;

const roleName = (role: string) =>
  ({
    baseline: aiText("基线（现有数据已能拦截）", "Baseline (already caught)"),
    novel: aiText("新增强度目标", "Novel strengthening target"),
    unqualified: aiText("尚未预检", "Not yet checked")
  })[role] || role;

const searchCategoryName = (category: string) =>
  ({
    invalid_request: aiText("请求无效", "invalid request"),
    authentication: aiText("身份验证失败", "authentication failed"),
    permission: aiText("没有权限", "no permission"),
    rate_limit: aiText("请求过于频繁", "rate limited"),
    quota: aiText("额度已用完", "quota used up"),
    transient: aiText("临时故障", "temporary failure"),
    configuration: aiText("配置问题", "configuration problem")
  })[category] || category;

/**
 * A job's execution model, challenge candidates, kept failures, corpus and source status (review Part V, R1–R5),
 * from the details' technical panel.
 */
export default function AiWorkflow({ technical }: { technical: AiJobDetail["technical"] }) {
  const contract = technical.taskContract,
    admission = technical.contractAdmission,
    candidates = technical.candidates || [],
    regressions = technical.regressions || [],
    corpus = technical.corpusMembership || [],
    receipts = technical.receipts,
    diagnostics = technical.searchDiagnostics || [];
  return (
    <div className={style.workflow}>
      {(contract || admission) && (
        <section>
          <Header as="h4">{aiText("执行方式", "Execution model")}</Header>
          {contract ? (
            <>
              <p className={style.jobDetail}>
                {modeName(contract.mode)}
                {" · "}
                {admission?.status === "verified"
                  ? aiText("已与评测机能力核对", "checked against the judges' capabilities")
                  : aiText("未核对（旧任务的文字描述）", "unverified (an older job's prose description)")}
              </p>
              {contract.interface.functions.length > 0 && <AiInterface value={contract.interface} />}
              {contract.roles.length > 0 && (
                <ul className={style.runList}>
                  {contract.roles.map(role => (
                    <li key={role.name}>
                      {role.name}
                      {role.permittedInformation.length > 0 &&
                        aiText(
                          `：可获得 ${role.permittedInformation.join("、")}`,
                          `: may receive ${role.permittedInformation.join(", ")}`
                        )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className={style.jobDetail}>{aiText("未提取", "Not extracted")}</p>
          )}
        </section>
      )}
      {receipts && (
        <p className={style.jobDetail}>
          {aiText(
            `最近一次运行：${receipts.fresh} 项新执行，复用 ${receipts.executions} 次执行、${receipts.comparisons} 次比较、${receipts.legality} 次合法性检查；${receipts.reusedTiming} 个用时来自复用的结果，不是新测得的。`,
            `Latest run: ${receipts.fresh} fresh, reused ${receipts.executions} executions, ${receipts.comparisons} comparisons and ${receipts.legality} legality checks; ${receipts.reusedTiming} timings come from reused results, not new measurements.`
          )}
        </p>
      )}
      {candidates.length > 0 && (
        <section>
          <Header as="h4">{aiText("待拦截的错误算法", "Challenge candidates")}</Header>
          <ul className={style.runList}>
            {candidates.map(candidate => (
              <li key={candidate.id}>
                <strong>{candidate.id}</strong> · {roleName(candidate.role)} ·{" "}
                {candidate.status === "rejected"
                  ? aiText("未采用", "rejected")
                  : candidate.status === "qualified"
                    ? aiText("已预检", "pre-checked")
                    : aiText("已编译", "compiled")}
                {candidate.claim && <div className={style.notes}>{candidate.claim}</div>}
                {candidate.reason && <div className={style.notes}>{candidate.reason}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {regressions.length > 0 && (
        <section>
          <Header as="h4">{aiText("保留的失败（回归检查）", "Kept failures (regression checks)")}</Header>
          <ul className={style.runList}>
            {regressions.map(regression => (
              <li key={regression.observationId}>
                {programName(regression.role) || regression.role} · {regression.kind} ·{" "}
                {{
                  pending: aiText("待重放", "pending"),
                  passed: aiText("重放通过", "passed"),
                  failed: aiText("仍失败", "still fails"),
                  unstable: aiText("不稳定", "unstable"),
                  untested: aiText("未重放", "not replayed")
                }[regression.replay] || regression.replay}
              </li>
            ))}
          </ul>
        </section>
      )}
      {corpus.length > 0 && (
        <section>
          <Header as="h4">{aiText("样例与数据集", "Samples and data sets")}</Header>
          <ul className={style.runList}>
            {corpus.map(item => (
              <li key={item.id}>
                {item.id} · {corpusClassName(item.class)} · {accessName(item.modelAccess)}
                {item.inputBytes != null && ` · ${formatFileSize(item.inputBytes, 1)}`}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className={style.jobDetail}>
        {provenanceName(technical.provenance?.status)}
        {technical.provenance?.reason === "existing_author_source" &&
          aiText("（保留作者填写的来源）", " (the author's source is kept)")}
        {technical.workflowOption &&
          technical.workflowOption !== "default" &&
          ` · ${
            technical.workflowOption === "qualify_first"
              ? aiText("先验证数据", "Qualify first")
              : aiText("只补全题目信息", "Metadata only")
          }`}
      </p>
      {diagnostics.length > 0 && (
        <section>
          <Header as="h4">{aiText("检索失败", "Search failures")}</Header>
          <ul className={style.runList}>
            {diagnostics.map((diagnostic, i) => (
              <li key={i}>
                {diagnostic.provider && `${diagnostic.provider} · `}
                {searchCategoryName(diagnostic.category)}
                {diagnostic.httpStatus != null && ` · HTTP ${diagnostic.httpStatus}`}
                {diagnostic.code && ` · ${diagnostic.code}`}
                {diagnostic.requestId && (
                  <span className={style.notes}>
                    {aiText(" · 请求 ID ", " · request ID ")}
                    <code>{diagnostic.requestId}</code>
                  </span>
                )}
                {diagnostic.retryable === false && aiText("（不会原样重试）", " (not retried unchanged)")}
              </li>
            ))}
          </ul>
          {technical.searchDiagnosticsOmitted > 0 && (
            <p className={style.notes}>
              {aiText(
                `省略了 ${technical.searchDiagnosticsOmitted} 条较早的记录。`,
                `${technical.searchDiagnosticsOmitted} earlier entries omitted.`
              )}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
