import SocketIO, { Socket } from "socket.io-client";
import winston from "winston";
import lodashDebounce from "lodash.debounce";
import SocketIOParser from "socket.io-msgpack-parser";

import { JUDGE_PROTOCOL_VERSION, JudgeClientCapabilities } from "@libreoj/judge-protocol";

import config, { updateServerSideConfig } from "./config";
import taskHandler, { supportedTaskTypes, Task } from "./task";
import { executionScheduler } from "./taskQueue";

import getSystemInfo from "./systemInfo";
import { CanceledError } from "./error";

// Storing a result may first wait for the problem's and submission's locks (up to about 30 seconds).
const FINAL_PROGRESS_ACK_TIMEOUT = 120 * 1000;

// Sent by the server as the third argument of "ready" (see apps/backend/src/judge/judge.gateway.ts).
// Older servers send none, which means none of these are supported.
interface JudgeServerCapabilities {
  // A "progress" message is acknowledged once the server has processed (for a final result: stored) it.
  progressAck?: boolean;
}

export class RPC {
  // eslint-disable-next-line no-undef
  private socket: Socket;

  /**
   * For each task:
   * * Functions to stop all the sandboxes and reject sandbox promises with CanceledErrors
   *   if the task is running sandboxes
   * * Otherwise a empty set
   */
  private pendingTaskCancelCallback: Map<string, Set<() => void>> = new Map();

  private serverCapabilities: JudgeServerCapabilities = {};

  async connect() {
    winston.info("Trying to connect to the server...");

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
    }

    let { serverUrl } = config;
    while (serverUrl.endsWith("/")) serverUrl = serverUrl.slice(0, -1);
    this.socket = SocketIO(`${serverUrl}/judge`, {
      path: "/api/socket",
      transports: ["websocket"],
      query: {
        key: config.key
      },
      ...{
        maxHttpBufferSize: 1e9,
        parser: SocketIOParser
      }
    });

    this.socket.on("connect", () => {
      winston.info("Successfully connected to the server, awaiting authorization");
    });

    this.socket.on("disconnect", () => {
      this.restart();
    });

    this.socket.on("cancel", (taskId: string) => this.cancelTask(taskId));

    this.socket.on("authenticationFailed", () => {
      winston.error("Failed to authentication to server, please check your key");
      process.exit(1);
    });

    await this.withTimeout(
      new Promise<void>(resolve => {
        this.socket.on("ready", async (name: string, serverSideConfig: unknown, capabilities?: unknown) => {
          winston.info(`Successfully authorized as ${name}`);
          updateServerSideConfig(serverSideConfig);
          // Older servers don't send capabilities.
          this.serverCapabilities =
            capabilities && typeof capabilities === "object" ? (capabilities as JudgeServerCapabilities) : {};
          this.socket.emit("systemInfo", await getSystemInfo());
          // Older servers ignore it
          const announced: JudgeClientCapabilities = {
            protocolVersion: JUDGE_PROTOCOL_VERSION,
            taskTypes: supportedTaskTypes,
            consumerThreads: config.taskConsumingThreads,
            executionSlots: executionScheduler.slots,
            memoryBudget: executionScheduler.memoryBudget,
            aiExecutionSlots: executionScheduler.aiSlots
          };
          this.socket.emit("capabilities", announced);

          resolve();
        });
      })
    );
  }

  restart() {
    winston.error("Disconnected from server, restarting");
    this.cancelAllTasks();
    process.exit(100);
  }

  async withTimeout<T>(promise: Promise<T>, timeout = config.rpcTimeout): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        winston.error(`Timed out after ${timeout} milliseconds, assuming disconnected`);
        this.restart();
      }, timeout);

      function onPromiseReady(action: () => void) {
        clearTimeout(timer);
        action();
      }

      promise.then(result => onPromiseReady(() => resolve(result))).catch(error => onPromiseReady(() => reject(error)));
    });
  }

  onCancel(taskId: string, callback: () => void): () => void {
    const callbacks = this.pendingTaskCancelCallback.get(taskId);
    if (!callbacks) {
      // Already canceled
      callback();
      return () => null;
    }
    callbacks.add(callback);
    return () => callbacks.delete(callback);
  }

  private cancelTask(taskId: string) {
    winston.info(`Canceling task ${taskId}`);
    const callbacks = this.pendingTaskCancelCallback.get(taskId);
    if (callbacks) {
      // No such task or already canceled
      this.pendingTaskCancelCallback.delete(taskId);
      callbacks.forEach(f => f());
    }
  }

  private cancelAllTasks() {
    this.pendingTaskCancelCallback.forEach((callbacks, taskId) => {
      winston.info(`Canceling task ${taskId} since connection lost`);
      callbacks.forEach(f => f());
    });
  }

  isCanceled(taskId: string) {
    return !this.pendingTaskCancelCallback.has(taskId);
  }

  ensureNotCanceled(taskId: string) {
    if (this.isCanceled(taskId)) {
      winston.info(`Task ${taskId} canceled`);
      throw new CanceledError();
    }
  }

  async requestFiles(fileUuids: string[]) {
    winston.info(`Requesting for ${fileUuids.length} files from server`);

    const urls = await this.withTimeout(
      new Promise<string[]>(resolve => {
        winston.info(`Request sent for ${fileUuids.length} files`);
        this.socket.emit("requestFiles", fileUuids, (responseUrls: string[]) => {
          winston.info(`Got download URLs for ${fileUuids.length} files`);
          resolve(responseUrls);
        });
      })
    );

    return urls;
  }

  async startTaskConsumerThread(threadId: number) {
    for (;;) {
      this.socket.emit("consumeTask", threadId);
      winston.info(`[Thread ${threadId}] Consuming task`);

      const taskAndAck = await new Promise<{ task: Task<unknown, unknown>; ack: () => void }>(resolve => {
        const onTask = (threadIdOfTask: number, task: Task<unknown, unknown>, ack: () => void) => {
          if (threadIdOfTask !== threadId) return;
          this.socket.off("task", onTask);
          resolve({ task, ack });
        };

        this.socket.on("task", onTask);
      });

      const { task, ack } = taskAndAck;
      const taskInfo = `{ taskId: ${task.taskId}, type: ${task.type} }`;
      winston.info(`[Thread ${threadId}] Got task: ${taskInfo}`);

      let canceled = false;
      this.pendingTaskCancelCallback.set(
        task.taskId,
        new Set([
          () => {
            canceled = true;
          }
        ])
      );

      // Resolved when the server has processed the last progress sent (if it acknowledges progress)
      let lastProgressProcessed: Promise<void> = Promise.resolve();

      // Debounce the onProgress function so we won't send progress too fast to the server
      const reportProgress = lodashDebounce((progress: unknown) => {
        winston.verbose(`[Thread ${threadId}] Reporting progress for task ${taskInfo}`);
        const message = {
          taskMeta: {
            taskId: task.taskId,
            type: task.type
          },
          progress
        };
        if (this.serverCapabilities.progressAck)
          lastProgressProcessed = new Promise<void>(resolve => {
            this.socket.emit("progress", message, () => resolve());
          });
        else this.socket.emit("progress", message);
      }, 100);
      task.reportProgressRaw = (progress: unknown) => {
        if (canceled) throw new CanceledError();
        reportProgress(progress);
      };

      try {
        await taskHandler(task);
      } catch (e) {
        if (!(e instanceof CanceledError)) {
          winston.error(`Unexpected error caught from taskHandler: ${e}`);
        }
      }

      // The last progress is the task's result. Send it now rather than after the debounce delay, and make sure
      // the server has stored it before acknowledging the task: an acknowledged task is never judged again.
      // If the server doesn't confirm in time, we restart and the server puts the unacknowledged task back.
      reportProgress.flush();
      await this.withTimeout(lastProgressProcessed, Math.max(config.rpcTimeout, FINAL_PROGRESS_ACK_TIMEOUT));

      this.pendingTaskCancelCallback.delete(task.taskId);

      ack();
      winston.info(`[Thread ${threadId}] Sent ack for finished task ${taskInfo}`);
    }
  }
}

export default new RPC();
