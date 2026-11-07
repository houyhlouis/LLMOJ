import React, { useEffect, useState } from "react";
import { Header, Table } from "semantic-ui-react";
import { aiCall, aiText } from "./api";
import style from "./Ai.module.less";

interface DeploymentIdentity {
  backend: { sha256: string | null; status: string; capturedAt: string };
  frontend: { sha256: string | null; status: string };
  qualityPolicyVersion: number;
  receiptVersion: number;
  executionProtocolVersion: number;
  schema: { version: string; appliedAt: string } | { version: null; status: string };
  usageIdentityColumns: { purpose: boolean; generationId: boolean };
  workers: Array<{
    id: number;
    online: boolean;
    build: string | null;
    sandboxImage: string | null;
    protocolVersion: number | null;
    qualityPolicies: number[];
    receiptVersions: number[];
  }>;
  workersTruncated: boolean;
}

const short = (hash: string | null, status?: string) =>
  hash ? (
    <code>{hash.slice(0, 12)}</code>
  ) : status === "truncated" ? (
    aiText("不完整", "truncated")
  ) : (
    aiText("缺失", "missing")
  );

/**
 * What is actually running, for site administrators (review Part V, R6): build fingerprints, the AI policy versions, the
 * recorded schema migration and each judge's capabilities. None of this is read from a git checkout.
 */
export default function AiDeploymentIdentity() {
  const [identity, setIdentity] = useState<DeploymentIdentity>(null),
    [error, setError] = useState("");
  useEffect(() => {
    aiCall<DeploymentIdentity>("deploymentIdentity").then(setIdentity, e => setError(e.message));
  }, []);
  if (error) return <p className={style.notes}>{error}</p>;
  if (!identity) return null;
  const policy = identity.qualityPolicyVersion,
    receipt = identity.receiptVersion;
  return (
    <section className={style.detailSection}>
      <Header as="h3">{aiText("部署版本", "Deployment identity")}</Header>
      <dl className={style.facts}>
        <dt>{aiText("后端", "Backend")}</dt>
        <dd>{short(identity.backend.sha256, identity.backend.status)}</dd>
        <dt>{aiText("前端", "Frontend")}</dt>
        <dd>
          {short(identity.frontend.sha256, identity.frontend.status)}
          <span className={style.notes}>
            {aiText(
              "（服务器上部署的文件，不一定是此浏览器加载的版本）",
              " (deployed files; not necessarily what this browser loaded)"
            )}
          </span>
        </dd>
        <dt>{aiText("AI 规则", "AI policy")}</dt>
        <dd>
          {aiText(
            `执行协议 ${identity.executionProtocolVersion} · 质量规则 ${policy} · 结果凭据 ${receipt}`,
            `execution protocol ${identity.executionProtocolVersion} · quality policy ${policy} · receipts ${receipt}`
          )}
        </dd>
        <dt>{aiText("数据库结构", "Schema")}</dt>
        <dd>
          {identity.schema.version
            ? `${identity.schema.version}`
            : aiText("没有记录（尚未通过升级脚本迁移）", "not recorded (not migrated by the upgrader yet)")}
          {(!identity.usageIdentityColumns.purpose || !identity.usageIdentityColumns.generationId) &&
            aiText("；用量表缺少用途/生成 ID 列", "; the usage table lacks the purpose/generation ID columns")}
        </dd>
      </dl>
      {identity.workers.length > 0 && (
        <div className={style.tableScroll}>
          <Table compact="very" unstackable size="small">
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{aiText("评测机", "Judge")}</Table.HeaderCell>
                <Table.HeaderCell>{aiText("版本", "Build")}</Table.HeaderCell>
                <Table.HeaderCell>{aiText("协议", "Protocol")}</Table.HeaderCell>
                <Table.HeaderCell>{aiText("可执行新 AI 任务", "Takes new AI jobs")}</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {identity.workers.map(worker => {
                const capable =
                  worker.protocolVersion === identity.executionProtocolVersion &&
                  worker.qualityPolicies.includes(policy) &&
                  worker.receiptVersions.includes(receipt);
                return (
                  <Table.Row key={worker.id} disabled={!worker.online}>
                    <Table.Cell>
                      #{worker.id} {worker.online ? "" : aiText("（离线）", "(offline)")}
                    </Table.Cell>
                    <Table.Cell>{short(worker.build)}</Table.Cell>
                    <Table.Cell>{worker.protocolVersion ?? "—"}</Table.Cell>
                    <Table.Cell negative={!capable}>
                      {capable ? aiText("是", "yes") : aiText("否，需要升级", "no, needs an upgrade")}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </div>
      )}
      {identity.workersTruncated && (
        <p className={style.notes}>{aiText("只显示前 100 台评测机。", "Only the first 100 judges are shown.")}</p>
      )}
    </section>
  );
}
