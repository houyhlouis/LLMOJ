import React from "react";
import { Form } from "semantic-ui-react";
import { aiText } from "./api";
import style from "./Ai.module.less";

export type AiWorkflowOption = "default" | "qualify_first" | "metadata_only";
export type AiCorpusPolicy = "private" | "summaries" | "model_visible";

export interface AiStartOptionValues {
  workflow: AiWorkflowOption;
  corpusPolicy: AiCorpusPolicy;
}

export const defaultStartOptions: AiStartOptionValues = { workflow: "default", corpusPolicy: "private" };

/** The fields to send with `start`; defaults are left out so the server keeps its own defaults (review Part V, R3/R5). */
export function startOptionFields(values: AiStartOptionValues) {
  return {
    ...(values.workflow !== "default" ? { workflow: values.workflow } : {}),
    ...(values.corpusPolicy !== "private" ? { corpusPolicy: values.corpusPolicy } : {})
  };
}

const workflowNotes: Record<AiWorkflowOption, () => string> = {
  default: () =>
    aiText(
      "按原有顺序执行，但会先检查评测机是否支持此题的执行方式。",
      "Keeps the usual order, but first checks that the judge supports this task's execution model."
    ),
  qualify_first: () =>
    aiText(
      "先生成并验证测试数据，再检索原题、翻译、打标签、写题解和评难度，题解围绕已验证的程序完成。",
      "Makes and checks the test data first, then the source search, translation, tags, tutorial and difficulty; the tutorial is finished around the checked programs."
    ),
  metadata_only: () =>
    aiText(
      "只检索原题、翻译、打标签和评难度，不生成程序和测试数据。",
      "Only the source search, translation, tags and difficulty; no programs or test data."
    )
};

const corpusNotes: Record<AiCorpusPolicy, () => string> = {
  private: () =>
    aiText(
      "上传的验证样例只在本站评测机上使用，其内容和描述都不会发给模型。题面中的公开样例始终可见。",
      "Uploaded validation samples are used only on this site's judges; neither their bytes nor descriptions are sent to the model. The statement's public examples are always visible."
    ),
  summaries: () =>
    aiText(
      "可以把服务器算出的大小等摘要，以及“已有样例已经能拦截某个错误”的结论发给模型，不发送样例内容。",
      "Server-derived summaries such as sizes, and the fact that existing samples already catch a defect, may be sent to the model; sample contents are not."
    ),
  model_visible: () =>
    aiText(
      "修复程序时，还可以把验证样例上失败的预览和诊断信息发给模型（不会上传整个样例文件）。",
      "When repairing a program, failure previews and diagnostics on validation samples may also be sent to the model (whole sample files are not uploaded)."
    )
};

/** How a job orders its work and what of the author's samples the model may see (review Part V, R3/R5). */
export default function AiStartOptions({
  value,
  onChange,
  disabled,
  testdata = true
}: {
  value: AiStartOptionValues;
  onChange: (value: AiStartOptionValues) => void;
  disabled?: boolean;
  // Whether the job can make test data (the corpus policy only matters then)
  testdata?: boolean;
}) {
  const workflows: AiWorkflowOption[] = testdata
    ? ["default", "qualify_first", "metadata_only"]
    : ["default", "metadata_only"];
  return (
    <div className={style.startOptions}>
      <Form.Select
        label={aiText("执行顺序", "Order of work")}
        disabled={disabled}
        value={value.workflow}
        options={workflows.map(option => ({
          key: option,
          value: option,
          text:
            option === "default"
              ? aiText("默认", "Default")
              : option === "qualify_first"
                ? aiText("先验证数据", "Qualify first")
                : aiText("只补全题目信息", "Metadata only")
        }))}
        onChange={(_e, { value: workflow }) => onChange({ ...value, workflow: workflow as AiWorkflowOption })}
      />
      <p className={style.notes}>{workflowNotes[value.workflow]()}</p>
      {testdata && value.workflow !== "metadata_only" && (
        <>
          <Form.Select
            label={aiText("上传样例对模型的可见性", "What the model may learn from uploaded samples")}
            disabled={disabled}
            value={value.corpusPolicy}
            options={[
              { key: "private", value: "private", text: aiText("完全保密", "Keep private") },
              { key: "summaries", value: "summaries", text: aiText("只发送摘要", "Summaries only") },
              { key: "model_visible", value: "model_visible", text: aiText("允许失败预览", "Failure previews allowed") }
            ]}
            onChange={(_e, { value: corpusPolicy }) =>
              onChange({ ...value, corpusPolicy: corpusPolicy as AiCorpusPolicy })
            }
          />
          <p className={style.notes}>{corpusNotes[value.corpusPolicy]()}</p>
        </>
      )}
    </div>
  );
}
