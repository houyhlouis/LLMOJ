import { Injectable } from "@nestjs/common";

import { Redis } from "ioredis";

import { JudgeTaskMeta, JudgeTaskPayload, JudgeTaskType } from "@libreoj/judge-protocol";

import { JudgeTaskService } from "./judge-task-service.interface";

import { JudgeTaskProgress } from "./judge-task-progress.interface";

import { logger } from "../logger";
import { RedisService } from "../redis/redis.service";
import { MetricsService } from "../metrics/metrics.service";

// Smaller means higher priority
// With the same priority value, the smaller ID means higher priority
export enum JudgeTaskPriorityType {
  High = 1,
  Medium = 2,
  Low = 3,
  Lowest = 4
}

export interface QueuedJudgeTaskMeta extends JudgeTaskMeta {
  enqueueTime: number;
  // How many times preparing this task for a judge client has failed (absent for a new task)
  failures?: number;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface JudgeTaskExtraInfo {}

// Extra info is also send to judge client while ONLY meta is used to identity the task
export class JudgeTask<ExtraInfo extends JudgeTaskExtraInfo> implements JudgeTaskPayload<ExtraInfo> {
  constructor(
    public taskId: string, // Passed by the task creator, to indentify the task
    public type: JudgeTaskType,
    public priorityType: JudgeTaskPriorityType,
    public priority: number,
    public extraInfo: ExtraInfo
  ) {}

  getMeta(): JudgeTaskMeta {
    return {
      taskId: this.taskId,
      type: this.type
    };
  }
}

const REDIS_KEY_JUDGE_QUEUE = "judge-queue";
const REDIS_CONSUME_TIMEOUT = 10;

// A task whose preparation fails (e.g. the database is briefly unavailable) is put back to the queue,
// unless it keeps failing. Its consumer waits before consuming again to avoid spinning on the error.
const MAX_TASK_PREPARATION_FAILURES = 5;
const TASK_PREPARATION_RETRY_DELAY = 1000;

@Injectable()
export class JudgeQueueService {
  private readonly redisForPush: Redis;

  private readonly redisForConsume: Redis;

  private readonly taskServices: Map<JudgeTaskType, JudgeTaskService<JudgeTaskProgress, JudgeTaskExtraInfo>> =
    new Map();

  constructor(private readonly redisService: RedisService, private readonly metricsService: MetricsService) {
    this.redisForPush = this.redisService.getClient();
    this.redisForConsume = this.redisService.getClient();
  }

  private readonly metricJudgeTaskQueueTime = this.metricsService.histogram(
    "libreoj_judge_task_queue_time_seconds",
    this.metricsService.histogram.BUCKETS_TIME_10M_30,
    ["type", "priority_type"]
  );

  registerTaskType<TaskProgress>(
    taskType: JudgeTaskType,
    service: JudgeTaskService<TaskProgress, JudgeTaskExtraInfo>
  ): void {
    this.taskServices.set(taskType, service);
  }

  /**
   * @param retry Keeps the original enqueue time and counts failures when a task is put back after its
   * preparation failed.
   */
  async pushTask(
    taskId: string,
    type: JudgeTaskType,
    priority: number,
    repush = false,
    retry: { enqueueTime: number; failures: number } | null = null
  ): Promise<void> {
    if (repush) logger.verbose(`Repush judge task: { taskId: ${taskId}, type: ${type}, priority: ${priority} }`);
    else logger.verbose(`New judge task: { taskId: ${taskId}, type: ${type}, priority: ${priority} }`);
    const taskMeta: QueuedJudgeTaskMeta = {
      taskId,
      type,
      enqueueTime: retry?.enqueueTime ?? Date.now(),
      ...(retry ? { failures: retry.failures } : {})
    };
    await this.redisForPush.zadd(REDIS_KEY_JUDGE_QUEUE, priority, JSON.stringify(taskMeta));
  }

  async consumeTask(): Promise<JudgeTask<JudgeTaskExtraInfo>> {
    logger.verbose("Consuming task queue");

    // ioredis's definition doesn't have bzpopmin method
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redisResponse: [key: string, element: string, score: string] = await (this.redisForConsume as any).bzpopmin(
      REDIS_KEY_JUDGE_QUEUE,
      REDIS_CONSUME_TIMEOUT
    );
    if (!redisResponse) {
      logger.verbose("Consuming task queue - timeout or empty");
      return null;
    }

    const [, taskJson, priorityString] = redisResponse;
    const priority = Number(priorityString);
    let taskMeta: QueuedJudgeTaskMeta;
    try {
      taskMeta = JSON.parse(taskJson);
    } catch {
      logger.error(`Dropped malformed judge queue entry: ${taskJson}`);
      return null;
    }
    const dequeuedTime = Date.now();

    let task: JudgeTask<JudgeTaskExtraInfo>;
    try {
      const taskService = this.taskServices.get(taskMeta.type);
      if (!taskService) throw new Error(`Unknown judge task type ${taskMeta.type}`);
      task = await taskService.getTaskToBeSentToJudgeByTaskId(taskMeta.taskId, priority);
    } catch (e) {
      const failures = (taskMeta.failures || 0) + 1;
      const taskInfo = `{ taskId: ${taskMeta.taskId}, type: ${taskMeta.type} }`;
      if (failures >= MAX_TASK_PREPARATION_FAILURES) {
        logger.error(`Failed to prepare judge task ${taskInfo} ${failures} times, dropping it: ${e}`);
        return null;
      }

      logger.error(`Failed to prepare judge task ${taskInfo} (attempt ${failures}), putting it back: ${e}`);
      try {
        await this.pushTask(taskMeta.taskId, taskMeta.type, priority, true, {
          enqueueTime: taskMeta.enqueueTime,
          failures
        });
      } catch (pushError) {
        logger.error(`Failed to put judge task ${taskInfo} back to the queue, it is lost: ${pushError}`);
      }
      await new Promise(resolve => setTimeout(resolve, TASK_PREPARATION_RETRY_DELAY));
      return null;
    }

    if (!task) {
      logger.verbose(
        `Consumed judge task { taskId: ${taskMeta.taskId}, type: ${taskMeta.type} }, but taskId is invalid, maybe canceled?`
      );
      return null;
    }

    if (taskMeta.enqueueTime) {
      this.metricJudgeTaskQueueTime.observe(
        {
          type: task.type,
          priority_type: task.priorityType
        },
        (dequeuedTime - taskMeta.enqueueTime) / 1000
      );
    }

    logger.verbose(
      `Consumed judge task { taskId: ${task.taskId}, type: ${task.type}, priority: ${priority} (${
        JudgeTaskPriorityType[task.priorityType]
      }) }`
    );
    return task;
  }

  /**
   * @return `false` means the task is canceled.
   */
  async onTaskProgress(taskMeta: JudgeTaskMeta, progress: JudgeTaskProgress): Promise<boolean> {
    return await this.taskServices.get(taskMeta.type).onTaskProgress(taskMeta.taskId, progress);
  }
}
