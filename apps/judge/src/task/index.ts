import { JudgeTaskPayload, JudgeTaskType } from "@libreoj/judge-protocol";

import onSubmission from "./submission";
import onHack from "./hack";
import { onSelfEval, onSelfEvalPrepare } from "./self-eval";
import onAiExecution from "./ai-execution";

export type Task<TaskExtraInfo, Progress> = JudgeTaskPayload<TaskExtraInfo> & {
  reportProgressRaw: (progress: Progress) => void;
};

export type TaskHandler<T> = (task: Task<T, unknown>) => Promise<void>;

const taskHandlers: Record<JudgeTaskType, TaskHandler<unknown>> = {
  [JudgeTaskType.Submission]: onSubmission,
  [JudgeTaskType.Hack]: onHack,
  [JudgeTaskType.SelfEvalPrepare]: onSelfEvalPrepare,
  [JudgeTaskType.SelfEval]: onSelfEval,
  [JudgeTaskType.AiExecution]: onAiExecution
};

export const supportedTaskTypes = Object.keys(taskHandlers) as JudgeTaskType[];

export default async function taskHandler(task: Task<unknown, unknown>) {
  await taskHandlers[task.type](task);
}
