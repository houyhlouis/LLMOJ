import React from "react";
import { Button, Icon, Label, Message, Segment } from "semantic-ui-react";

import { CodeBox } from "@/components/CodeBox";
import StatusText from "@/components/StatusText";
import formatFileSize from "@/utils/formatFileSize";
import { useLocalizer } from "@/utils/hooks";
import { HackRecord, statusText, tr } from "./api";
import style from "./HackTestcase.module.less";

function downloadInput(record: HackRecord) {
  const url = URL.createObjectURL(new Blob([record.inputData], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `hack-${record.id}.in`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A hack contains exactly one input, so its judging details stay expanded. */
export default function HackTestcase({ record }: { record: HackRecord }) {
  const _ = useLocalizer("submission");
  const result = record.testcaseResult;
  const time = result?.timeUsed ?? record.timeUsed;
  const memory = result?.memoryUsed ?? record.memoryUsed;
  const targetNotRun = result?.executed === false || record.status === "InvalidInput";
  const targetStatus =
    result?.status || (record.status === "Pending" || record.status === "Running" ? record.status : null);
  const targetVerdict = targetStatus ? (
    <StatusText status={targetStatus} />
  ) : targetNotRun ? (
    <span>{tr("未运行", "Not run")}</span>
  ) : (
    <div className={style.unknownVerdict}>
      <Label>{statusText(record.status)}</Label>
      <span>{tr("未记录目标判定", "Target verdict not recorded")}</span>
    </div>
  );

  return (
    <Segment.Group className={style.testcase}>
      <Segment className={style.summary}>
        <strong>{_(".testcase.title")} #1</strong>
        <div>{targetVerdict}</div>
        <span title={_(".testcase.score")}>
          <Icon name="clipboard check" />
          {result?.score == null ? "—" : `${Number(result.score.toFixed(2))} pts`}
        </span>
        <span
          title={
            record.testcaseInfo?.timeLimit
              ? `${tr("时间限制", "Time limit")}: ${record.testcaseInfo.timeLimit} ms`
              : tr("运行时间", "Runtime")
          }
        >
          <Icon name="clock" />
          {time == null ? "—" : `${Math.round(time)} ms`}
        </span>
        <span
          title={
            record.testcaseInfo?.memoryLimit
              ? `${tr("内存限制", "Memory limit")}: ${record.testcaseInfo.memoryLimit} MiB`
              : tr("运行内存", "Memory")
          }
        >
          <Icon name="microchip" />
          {memory == null ? "—" : formatFileSize(memory * 1024, 1)}
        </span>
      </Segment>
      <Segment className={style.details}>
        {record.inputData != null ? (
          <CodeBox
            title={
              <span className={style.inputTitle}>
                <strong>{_(".testcase.input")}</strong>
                <Button
                  basic
                  size="mini"
                  icon="download"
                  content={`hack-${record.id}.in`}
                  title={tr("下载输入", "Download input")}
                  onClick={() => downloadInput(record)}
                />
              </span>
            }
            content={record.inputData || "\n"}
            wrap
          />
        ) : (
          <Message
            info
            content={tr(
              "当前没有查看 Hack 输入数据的权限，或比赛尚未允许公开。",
              "You do not have access to the hack input, or the contest has not made it available yet."
            )}
          />
        )}
        {record.message && <CodeBox title={tr("评测信息", "Judging message")} content={record.message} wrap />}
      </Segment>
    </Segment.Group>
  );
}
