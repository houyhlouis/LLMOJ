import React, { useEffect, useState } from "react";
import { Button, Message } from "semantic-ui-react";
import { Link } from "@/utils/hooks";
import formatDateTime from "@/utils/formatDateTime";
import { aiCall, aiText, AiJob, AiTutorialView } from "./api";
import style from "./Ai.module.less";

type Status = AiTutorialView["status"];

// What a tutorial's code passed, for the job's owner
const ownerText = (view: AiTutorialView) => {
  const why = [view.subject, view.reason].filter(Boolean).join(": ");
  const detail = why ? ` (${why})` : "";
  return (
    {
      "no-code": aiText("题解中没有可运行的 C++ 程序", "it shows no C++ program the job could run"),
      unchecked: aiText("题解中的代码尚未检查", "its code hasn't been checked"),
      "passed-samples": aiText(
        `题解中的代码通过了全部 ${view.samplesPassed || 0} 组官方样例；尚未发布测试数据`,
        `its code passed the ${view.samplesPassed || 0} official ${
          view.samplesPassed === 1 ? "sample" : "samples"
        }; no test data is published yet`
      ),
      rejected: aiText(
        `题解中的代码未通过官方样例${detail}，测试数据没有使用它（见失败详情）`,
        `its code failed an official sample check${detail}, so the test data doesn't use it (see Failure details)`
      ),
      qualified: aiText(
        "题解中的代码就是生成并检验已发布测试数据的标程",
        "its code is the reference solution the published test data was made and checked with"
      ),
      superseded: aiText(
        "已发布的测试数据使用了另一份标程，题解中的代码没有作为标程检验",
        "the published test data was made with another reference solution; its code wasn't checked as the reference"
      )
    }[view.status] || view.status
  );
};

/**
 * The job's AI tutorials and what their code passed (review Part III, H08), and the correction its owner can ask for:
 * the tutorials' code replaced by the reference solution the test data was made with.
 */
export default function AiTutorialBinding({
  job,
  busy,
  onCorrect
}: {
  job: AiJob;
  busy: boolean;
  onCorrect: () => void;
}) {
  const tutorials = job.result.tutorials || [];
  if (!tutorials.length) return null;
  const correction = job.result.tutorialCorrection;
  return (
    <div className={style.tutorialBinding}>
      {tutorials.map(view => (
        <p className={style.jobDetail} key={view.discussionId}>
          <Link href={`/d/${view.discussionId}`}>{view.locale === "zh_CN" ? "题解-AI" : "Tutorial-AI"}</Link>
          {` · ${ownerText(view)}`}
          {view.corrected &&
            aiText(
              ` · 代码已于 ${formatDateTime(view.corrected)[1]} 替换为标程`,
              ` · code replaced by the reference solution on ${formatDateTime(view.corrected)[1]}`
            )}
        </p>
      ))}
      {correction === "available" && (
        <Button size="mini" type="button" disabled={busy} onClick={onCorrect}>
          {aiText("在题解中改用标程的代码", "Use the reference solution's code in the tutorials")}
        </Button>
      )}
      {correction === "pending" && (
        <p className={style.notes}>
          {aiText("正在用标程的代码改写题解……", "Rewriting the tutorials with the reference solution's code…")}
        </p>
      )}
      {correction === "FILE_IO" && (
        <p className={style.notes}>
          {aiText(
            "题目要求读写指定文件，而标程使用标准输入输出，因此不能直接作为题解代码。",
            "The problem reads and writes named files, and the reference solution uses standard input and output, so it can't be the tutorials' code as it is."
          )}
        </p>
      )}
    </div>
  );
}

// What an AI tutorial's code passed, for its readers. The explanation and proof are never claimed verified.
const readerText = (status: Status) =>
  ({
    qualified: aiText(
      "这篇 AI 题解中的代码是本题的标程：它通过了官方样例和测试数据的全部检查。题解的思路与证明未经验证。",
      "This AI-written tutorial's code is the problem's reference solution: it passed the official samples and every check of the test data. The explanation and proof aren't verified."
    ),
    "passed-samples": aiText(
      "这篇 AI 题解中的代码通过了官方样例。题解的思路与证明未经验证。",
      "This AI-written tutorial's code passed the official samples. The explanation and proof aren't verified."
    ),
    rejected: aiText(
      "这篇 AI 题解中的代码未通过官方样例，因此不是本题的标程。",
      "This AI-written tutorial's code failed an official sample check, so it isn't the problem's reference solution."
    ),
    superseded: aiText(
      "这篇 AI 题解中的代码没有用于生成本题的测试数据，测试数据由另一份标程检验。",
      "This AI-written tutorial's code wasn't used to make the problem's test data, which were checked with a different reference solution."
    ),
    unchecked: aiText("这篇 AI 题解中的代码尚未检查。", "This AI-written tutorial's code hasn't been checked.")
  })[status as string] || null;

/** Shown with a tutorial discussion an AI job published: what its code passed. Nothing for any other discussion. */
export function AiTutorialStatus({ discussionId }: { discussionId: number }) {
  const [status, setStatus] = useState<Status>(null);
  useEffect(() => {
    let mounted = true;
    aiCall<{ tutorial?: { status: Status } }>("tutorialStatus", { discussionId })
      .then(result => mounted && setStatus(result.tutorial?.status || null))
      .catch(() => mounted && setStatus(null));
    return () => {
      mounted = false;
    };
  }, [discussionId]);
  const text = status && readerText(status);
  if (!text) return null;
  return (
    <Message
      size="small"
      info={["qualified", "passed-samples"].includes(status)}
      warning={!["qualified", "passed-samples"].includes(status)}
      className={style.tutorialStatus}
      content={text}
    />
  );
}
