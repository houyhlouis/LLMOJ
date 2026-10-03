import React, { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { Button, Form, Header, Message, Table } from "semantic-ui-react";
import { appState } from "@/appState";
import { aiCall, aiText } from "./api";
import style from "./Ai.module.less";

interface UsageTotals {
  requests: number;
  succeeded: number;
  failed: number;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  searchCredits: number;
  unknownTokenRequests: number;
}
interface UsageProvider extends UsageTotals {
  target: "llm" | "search";
  provider: string;
  host: string;
  model: string;
}
interface UsageResponse {
  periodDays: number;
  totals: UsageTotals;
  byProvider: UsageProvider[];
  daily: Array<UsageTotals & { date: string }>;
  recent: Array<
    Partial<UsageTotals> & {
      id: number | string;
      createdAt: string;
      target: string;
      provider: string;
      host: string;
      model: string;
      operation: string;
      success: boolean;
      errorCode?: string;
      elapsedMs: number;
    }
  >;
}

export default observer(function AiUsage() {
  const [days, setDays] = useState(30),
    [usage, setUsage] = useState<UsageResponse>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const refresh = async () => {
    setPending(true);
    setError("");
    try {
      setUsage(await aiCall<UsageResponse>("usage", { days }));
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, [days]);
  const number = (value: number) => (value == null ? "—" : value.toLocaleString(appState.locale.replace("_", "-")));
  return (
    <>
      <Header as="h2">{aiText("用量", "Usage")}</Header>
      <Form onSubmit={e => e.preventDefault()} className={style.usageToolbar}>
        <Form.Select
          disabled={pending}
          inline
          label={aiText("统计周期", "Period")}
          value={days}
          options={[1, 7, 30, 90, 366].map(value => ({
            value,
            text: aiText(`最近 ${value} 天`, `Last ${value} days`)
          }))}
          onChange={(_e, { value }) => setDays(Number(value))}
        />
        <Button type="button" size="small" loading={pending} disabled={pending} onClick={refresh}>
          {aiText("刷新", "Refresh")}
        </Button>
      </Form>
      <p className={style.notes}>
        {aiText(
          "仅显示当前账号从启用用量记录起的调用。Token 和搜索点数以服务商返回为准；未返回的用量不推算，失败重试也计为调用。",
          "Shows this account's calls since usage tracking was enabled. Tokens and search credits use provider-reported values; missing usage is not estimated. Retries count as calls."
        )}
      </p>
      {error && <Message negative>{error}</Message>}
      {usage && (
        <>
          <p className={style.usageSummary}>
            {aiText("调用", "Calls")}: <strong>{number(usage.totals.requests)}</strong> · {aiText("成功", "Succeeded")}:{" "}
            {number(usage.totals.succeeded)} · {aiText("失败", "Failed")}: {number(usage.totals.failed)}
          </p>
          {usage.byProvider.length === 0 ? (
            <Message>{aiText("此周期内暂无调用记录。", "No calls in this period.")}</Message>
          ) : (
            <div className={style.usageTable}>
              <Table basic="very" unstackable>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>{aiText("服务 / 模型", "Service / model")}</Table.HeaderCell>
                    <Table.HeaderCell textAlign="right">{aiText("调用 / 失败", "Calls / failed")}</Table.HeaderCell>
                    <Table.HeaderCell textAlign="right">{aiText("输入 token", "Input tokens")}</Table.HeaderCell>
                    <Table.HeaderCell textAlign="right">{aiText("输出 token", "Output tokens")}</Table.HeaderCell>
                    <Table.HeaderCell textAlign="right">{aiText("缓存 token", "Cached tokens")}</Table.HeaderCell>
                    <Table.HeaderCell textAlign="right">{aiText("推理 token", "Reasoning tokens")}</Table.HeaderCell>
                    <Table.HeaderCell textAlign="right">{aiText("搜索点数", "Search credits")}</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {usage.byProvider.map((row, index) => (
                    <Table.Row key={index}>
                      <Table.Cell>
                        <strong>{row.model || row.provider}</strong>
                        <div className={style.notes}>{row.host}</div>
                      </Table.Cell>
                      <Table.Cell textAlign="right">
                        {number(row.requests)} / {number(row.failed)}
                      </Table.Cell>
                      <Table.Cell textAlign="right">{number(row.inputTokens)}</Table.Cell>
                      <Table.Cell textAlign="right">{number(row.outputTokens)}</Table.Cell>
                      <Table.Cell textAlign="right">{number(row.cachedTokens)}</Table.Cell>
                      <Table.Cell textAlign="right">{number(row.reasoningTokens)}</Table.Cell>
                      <Table.Cell textAlign="right">{number(row.searchCredits)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          )}
          {usage.totals.unknownTokenRequests > 0 && (
            <p className={style.notes}>
              {aiText(
                `${number(usage.totals.unknownTokenRequests)} 次语言模型调用未返回 token 用量。`,
                `${number(usage.totals.unknownTokenRequests)} language-model calls did not report token usage.`
              )}
            </p>
          )}
          {usage.recent.length > 0 && (
            <>
              <Header as="h3">{aiText("最近调用", "Recent calls")}</Header>
              <div className={style.usageTable}>
                <Table basic="very" unstackable>
                  <Table.Header>
                    <Table.Row>
                      <Table.HeaderCell>{aiText("时间", "Time")}</Table.HeaderCell>
                      <Table.HeaderCell>{aiText("服务 / 模型", "Service / model")}</Table.HeaderCell>
                      <Table.HeaderCell>{aiText("操作", "Operation")}</Table.HeaderCell>
                      <Table.HeaderCell>{aiText("结果", "Result")}</Table.HeaderCell>
                      <Table.HeaderCell textAlign="right">
                        {aiText("输入 / 输出 token", "Input / output tokens")}
                      </Table.HeaderCell>
                      <Table.HeaderCell textAlign="right">{aiText("搜索点数", "Search credits")}</Table.HeaderCell>
                      <Table.HeaderCell textAlign="right">{aiText("耗时", "Duration")}</Table.HeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {usage.recent.map(row => (
                      <Table.Row key={row.id}>
                        <Table.Cell>
                          {new Date(row.createdAt).toLocaleString(appState.locale.replace("_", "-"))}
                        </Table.Cell>
                        <Table.Cell>{row.model || row.provider}</Table.Cell>
                        <Table.Cell>{row.operation}</Table.Cell>
                        <Table.Cell>
                          {row.success ? aiText("成功", "Succeeded") : aiText("失败", "Failed")}
                          {row.errorCode && <div className={style.notes}>{row.errorCode}</div>}
                        </Table.Cell>
                        <Table.Cell textAlign="right">
                          {number(row.inputTokens)} / {number(row.outputTokens)}
                        </Table.Cell>
                        <Table.Cell textAlign="right">{number(row.searchCredits)}</Table.Cell>
                        <Table.Cell textAlign="right">{number(row.elapsedMs)} ms</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
});
