import React from "react";

import { aiText, AiPlanIssue } from "./api";
import style from "./Ai.module.less";

/*
 * Why the AI's testing plan was rejected (review Part IV, W01): each field that broke a rule, in words. The answer was
 * complete JSON; a rule of the plan failed. No program had run.
 */

const FIELDS: Record<string, [string, string]> = {
  version: ["版本号", "version"],
  correctAlgorithms: ["正确解法列表", "correct methods"],
  oracleMethod: ["暴力对拍方法", "oracle method"],
  smallInputStrategy: ["小数据策略", "small-input strategy"],
  targets: ["对抗目标列表", "targets"],
  id: ["标识", "ID"],
  kind: ["类型", "kind"],
  algorithm: ["算法", "algorithm"],
  reason: ["原因", "reason"],
  construction: ["构造方法", "construction"],
  subtasks: ["子任务", "subtasks"]
};

/** "targets[1].reason" as "Target 2 · reason" */
export function planFieldName(path: string) {
  if (!path) return aiText("整个方案", "the whole plan");
  return path
    .split(".")
    .map(part => {
      const match = /^([A-Za-z]+)(?:\[(\d+)\])?$/.exec(part);
      if (!match) return part;
      const [, name, index] = match;
      const label = FIELDS[name] ? aiText(...FIELDS[name]) : name;
      if (index == null) return label;
      const position = Number(index) + 1;
      if (name === "targets") return aiText(`对抗目标 ${position}`, `target ${position}`);
      if (name === "correctAlgorithms") return aiText(`正确解法 ${position}`, `correct method ${position}`);
      if (name === "subtasks") return aiText(`第 ${position} 个子任务`, `subtask ${position}`);
      return `${label} ${position}`;
    })
    .join(" · ");
}

const number = (value: unknown) => (typeof value === "number" ? value.toLocaleString() : String(value));

export function planIssueText(issue: AiPlanIssue) {
  const { expected, actual } = issue;
  switch (issue.rule) {
    case "required":
      return aiText("缺少", "missing");
    case "type":
      return aiText(`应为 ${expected}，实际为 ${actual}`, `should be ${expected}, was ${actual}`);
    case "const":
      return aiText(`应为 ${expected}，实际为 ${actual}`, `should be ${expected}, was ${actual}`);
    case "enum":
      return aiText(`只能是 ${expected}，实际为 ${actual}`, `must be one of ${expected}, was ${actual}`);
    case "nonEmpty":
      return aiText("为空", "empty");
    case "maxLength":
      return aiText(
        `${number(actual)} 个字符，最多 ${number(expected)} 个`,
        `${number(actual)} characters, at most ${number(expected)}`
      );
    case "pattern":
      return aiText(
        `${actual} 不是合法标识（小写字母开头，只含小写字母、数字、_ 和 -）`,
        `${actual} isn't a valid identifier (a lowercase letter, then lowercase letters, digits, _ or -)`
      );
    case "minItems":
      return aiText(`${actual} 项，至少 ${expected} 项`, `${actual} items, at least ${expected}`);
    case "maxItems":
      return aiText(`${actual} 项，最多 ${expected} 项`, `${actual} items, at most ${expected}`);
    case "unique":
      return aiText(
        actual != null ? `${actual} 重复` : "有重复项",
        actual != null ? `${actual} is repeated` : "has repeated items"
      );
    case "reserved":
      return aiText(`${actual} 是保留标识`, `${actual} is reserved`);
    case "reference":
      return aiText(
        `子任务 ${actual} 不存在（可用：${expected}）`,
        `subtask ${actual} doesn't exist (there are ${expected})`
      );
    case "wrongTarget":
      return aiText("至少需要一个类型为 wrong 的目标", "needs at least one target of kind wrong");
    default:
      return issue.rule;
  }
}

export default function AiPlanIssues({ issues, rejections }: { issues: AiPlanIssue[]; rejections?: number }) {
  if (!issues?.length) return null;
  return (
    <div className={style.planIssues}>
      <p className={style.jobDetail}>
        {aiText(
          `AI 返回了完整的方案，但其中 ${issues.length} 处不符合方案规则${rejections > 1 ? `（本任务已有 ${rejections} 个方案被拒绝）` : ""}：`,
          `The AI returned a complete plan, but ${issues.length} ${issues.length === 1 ? "field breaks" : "fields break"} the plan's rules${rejections > 1 ? ` (${rejections} plans of this job were rejected)` : ""}:`
        )}
      </p>
      <ul>
        {issues.map((issue, index) => (
          <li key={index}>
            <strong>{planFieldName(issue.path)}</strong>
            {aiText("：", ": ")}
            {planIssueText(issue)}
          </li>
        ))}
      </ul>
    </div>
  );
}
