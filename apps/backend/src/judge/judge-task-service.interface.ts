import { EntityManager } from "typeorm";

import { JudgeTaskProgress } from "./judge-task-progress.interface";
import { JudgeTaskExtraInfo, JudgeTask } from "./judge-queue.service";

/**
 * Passed with a task's final progress. The service calls `confirm` inside the transaction that stores the result,
 * so the result and the job's completion commit together.
 */
export interface JudgeTaskCompletion {
  /** Marks the job finished; `false` if the reporting connection no longer holds the job (store nothing). */
  confirm(manager: EntityManager): Promise<boolean>;
}

export interface JudgeTaskService<TaskProgress extends JudgeTaskProgress, ExtraInfo extends JudgeTaskExtraInfo> {
  /**
   * @param completion Present only with the task's final progress.
   * @return `false` if the task isn't active any more (e.g. canceled or rejudged).
   */
  onTaskProgress(taskId: string, progress: TaskProgress, completion?: JudgeTaskCompletion): Promise<boolean>;

  /**
   * Returns `null` if the task is no longer active. Other errors are retried later.
   *
   * @param priority We need to store the `priority` in judge task as we may repush the task back to queue
   */
  getTaskToBeSentToJudgeByTaskId(taskId: string, priority: number): Promise<JudgeTask<ExtraInfo>>;

  /** The task IDs this service's resources reference while active, with a priority to queue them again with. */
  listActiveTasks(): Promise<{ taskId: string; priority: number }[]>;

  /** The queue gave up on the task: if the resource still references it, give the resource a terminal error. */
  onTaskFailed(taskId: string, message: string): Promise<void>;
}
