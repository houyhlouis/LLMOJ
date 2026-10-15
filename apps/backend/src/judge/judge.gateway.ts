import { forwardRef, Inject } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect
} from "@nestjs/websockets";

import { Server, Socket } from "socket.io"; // eslint-disable-line import/no-extraneous-dependencies
import SocketIOParser from "socket.io-msgpack-parser";
import { Redis } from "ioredis";
import proxyAddr from "proxy-addr";

import { JudgeClientSystemInfo, JudgeTaskMeta, JudgeTaskType } from "@libreoj/judge-protocol";

import { JudgeClientService } from "./judge-client.service";

import { JudgeClientEntity } from "./judge-client.entity";

import { JudgeQueueService, JudgeTask, JudgeTaskExtraInfo } from "./judge-queue.service";

import { logger } from "../logger";
import { MinioSignFor, FileService, JUDGE_FILE_DOWNLOAD_EXPIRE_TIME } from "../file/file.service";
import { SubmissionProgress } from "../submission/submission-progress.interface";
import { ConfigService } from "../config/config.service";
import { EventReportService, EventReportType } from "../event-report/event-report.service";
import { RedisService } from "../redis/redis.service";
import { LockService } from "../redis/lock.service";
import { SOCKET_IO_MAX_MESSAGE_SIZE } from "../socket-io.constants";

interface JudgeClientState {
  judgeClient: JudgeClientEntity;
  pendingTasks: Set<JudgeTask<JudgeTaskExtraInfo>>;
  // Tasks sent to this client, by task ID: pending ones and those acknowledged within the grace time.
  // A client may only report progress for, and download files of, its own assigned tasks.
  assignedTasks: Map<string, JudgeTask<JudgeTaskExtraInfo>>;
}

interface SubmissionProgressMessage {
  taskMeta: JudgeTaskMeta;
  progress: SubmissionProgress;
}

// If a judge client is disconnected temporarily (within 1 minute), don't report it with event reporter
const REDIS_KEY_JUDGE_CLIENT_TEMPORARILY_DISCONNENTED = "judge-client-temporarily-disconnected:%d";
const JUDGE_CLIENT_TEMPORARILY_DISCONNENTED_MAX_TIME = 60;

const REDIS_LOCK_JUDGE_CLIENT_CONNECT_DISCONNECT = "judge-client-connect-disconnect:%d";

const REDIS_CHANNEL_CANCEL_TASK = "cancel-task";

// Judge clients without progress acknowledgement may send their last (debounced) progress just after
// acknowledging the task, so an acknowledged task stays assigned to its client for a short while.
const ACKNOWLEDGED_TASK_GRACE_TIME = 60 * 1000;

const MAX_FILES_PER_REQUEST = 10000;

const CONSUME_TASK_RETRY_DELAY = 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sent as the third argument of "ready"; judge clients that predate it ignore it (see apps/judge/src/rpc.ts).
// progressAck: a "progress" message is acknowledged once processed (for a final result: stored).
const SERVER_CAPABILITIES = {
  progressAck: true
};

function isJudgeTaskMeta(value: unknown): value is JudgeTaskMeta {
  const taskMeta = value as JudgeTaskMeta;
  return (
    !!taskMeta &&
    typeof taskMeta.taskId === "string" &&
    (Object.values(JudgeTaskType) as unknown[]).includes(taskMeta.type)
  );
}

// Every file a judge client needs for a task is referenced by its UUID somewhere in the task's payload.
function collectFileUuids(value: unknown, result: Set<string>): void {
  if (typeof value === "string") {
    if (UUID_PATTERN.test(value)) result.add(value);
  } else if (Array.isArray(value)) value.forEach(item => collectFileUuids(item, result));
  else if (value && typeof value === "object") Object.values(value).forEach(item => collectFileUuids(item, result));
}

@WebSocketGateway({
  maxHttpBufferSize: SOCKET_IO_MAX_MESSAGE_SIZE,
  namespace: "judge",
  path: "/api/socket",
  transports: ["websocket"],
  parser: SocketIOParser
})
export class JudgeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server: Server;

  private mapSessionIdToJudgeClient: Map<string, JudgeClientState> = new Map();

  private mapTaskIdToSocket: Map<string, Socket> = new Map();

  private redis: Redis;

  // To subscribe the "cancel task" event
  private redisForSubscribe: Redis;

  constructor(
    private readonly judgeClientService: JudgeClientService,
    private readonly judgeQueueService: JudgeQueueService,
    private readonly fileService: FileService,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => EventReportService))
    private readonly eventReportService: EventReportService,
    private readonly redisService: RedisService,
    private readonly lockService: LockService
  ) {
    this.redis = this.redisService.getClient();

    this.redisForSubscribe = this.redisService.getClient();

    this.redisForSubscribe.on("message", (channel: string, message: string) => {
      this.onCancelTask(message);
    });
    this.redisForSubscribe.subscribe(REDIS_CHANNEL_CANCEL_TASK);
  }

  // Send the cancel task operation to ALL nodes
  cancelTask(taskId: string) {
    this.redis.publish(REDIS_CHANNEL_CANCEL_TASK, taskId);
  }

  onCancelTask(taskId: string): void {
    const client = this.mapTaskIdToSocket.get(taskId);
    if (!client) return;

    client.emit("cancel", taskId);
  }

  private async checkConnection(client: Socket): Promise<boolean> {
    if (!client.connected) return false;

    const { judgeClient } = this.mapSessionIdToJudgeClient.get(client.id);
    if (!(await this.judgeClientService.checkJudgeClientSession(judgeClient, client.id))) {
      client.disconnect(true);
      return false;
    }
    return true;
  }

  async handleConnection(client: Socket): Promise<void> {
    const key = (client.handshake.query.key as string).split(" ").pop();
    const judgeClient = await this.judgeClientService.findJudgeClientByKey(key);

    if (!judgeClient) {
      logger.verbose(`Client ${client.id} connected with invalid key`);
      client.emit("authenticationFailed");
      // Delay the disconnection to make the authenticationFailed event able to be sent to the client
      setImmediate(() => client.disconnect(true));
      return;
    }

    // Maybe the socket "disconnect" event is emitted before the query finished
    if (!client.connected) return;

    await this.lockService.lock(REDIS_LOCK_JUDGE_CLIENT_CONNECT_DISCONNECT.format(judgeClient.id), async () => {
      await this.judgeClientService.setJudgeClientOnlineSessionId(judgeClient, client.id);

      if (!client.connected) {
        await this.judgeClientService.disconnectJudgeClient(judgeClient);
      }

      this.mapSessionIdToJudgeClient.set(client.id, {
        judgeClient,
        pendingTasks: new Set(),
        assignedTasks: new Map()
      });
    });

    if (!client.connected) {
      return;
    }

    // Now we are ready for consuming task
    client.emit("ready", judgeClient.name, this.configService.config.judge, SERVER_CAPABILITIES);

    const message = `Judge client ${client.id} (${judgeClient.name}) connected from ${proxyAddr(
      client.request,
      this.configService.config.server.trustProxy
    )}.`;
    logger.log(message);
    if ((await this.redis.del(REDIS_KEY_JUDGE_CLIENT_TEMPORARILY_DISCONNENTED.format(judgeClient.id))) === 0) {
      // If the judge client is NOT temporarily disconnected, report it with event-reporter
      this.eventReportService.report({
        type: EventReportType.Success,
        message
      });
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const state = this.mapSessionIdToJudgeClient.get(client.id);
    if (!state) {
      logger.log(`Judge client ${client.id} disconnected before initialized, ignoring`);
      return; // Initialization has not been complated
    }

    const message = `Judge client ${client.id} (${state.judgeClient.name}) disconnected.`;
    logger.log(message);

    this.mapSessionIdToJudgeClient.delete(client.id);

    // Another "connect" may be fired before the disconnect event
    // So directly call "disconnectJudgeClient" will disconnect the newly connected client
    await this.lockService.lock(REDIS_LOCK_JUDGE_CLIENT_CONNECT_DISCONNECT.format(state.judgeClient.id), async () => {
      // Ensure if this session holds the client
      if (await this.judgeClientService.checkJudgeClientSession(state.judgeClient, client.id))
        await this.judgeClientService.disconnectJudgeClient(state.judgeClient);
    });

    if (state.pendingTasks.size !== 0) {
      logger.log(
        `Repushing ${state.pendingTasks.size} tasks consumed by judge client ${client.id} (${state.judgeClient.name}).`
      );
      // Push the pending tasks back to the queue
      await Promise.all(
        Array.from(state.pendingTasks.values()).map(async task => {
          this.mapTaskIdToSocket.delete(task.taskId);
          await this.judgeQueueService.pushTask(task.taskId, task.type, task.priority, true);
        })
      );
    }

    // Report event
    await this.redis.setex(
      REDIS_KEY_JUDGE_CLIENT_TEMPORARILY_DISCONNENTED.format(state.judgeClient.id),
      JUDGE_CLIENT_TEMPORARILY_DISCONNENTED_MAX_TIME,
      "1"
    );
    setTimeout(async () => {
      if (!(await this.judgeClientService.isJudgeClientOnline(state.judgeClient))) {
        this.eventReportService.report({
          type: EventReportType.Warning,
          message
        });
      }
    }, JUDGE_CLIENT_TEMPORARILY_DISCONNENTED_MAX_TIME * 1000);
  }

  @SubscribeMessage("systemInfo")
  async onSystemInfo(
    @ConnectedSocket() client: Socket,
    @MessageBody() systemInfo: JudgeClientSystemInfo
  ): Promise<void> {
    const state = this.mapSessionIdToJudgeClient.get(client.id);
    if (!state) {
      logger.warn(`"systemInfo" emitted from an unknown client ${client.id}, ignoring`);
      return;
    }

    await this.judgeClientService.updateJudgeClientSystemInfo(state.judgeClient, systemInfo);
  }

  @SubscribeMessage("requestFiles")
  async onRequestFiles(@ConnectedSocket() client: Socket, @MessageBody() fileUuids: string[]): Promise<string[]> {
    const state = this.mapSessionIdToJudgeClient.get(client.id);
    if (!state) {
      logger.warn(`"requestFiles" emitted from an unknown client ${client.id}, ignoring`);
      return [];
    }

    if (
      !Array.isArray(fileUuids) ||
      fileUuids.length > MAX_FILES_PER_REQUEST ||
      !fileUuids.every(fileUuid => typeof fileUuid === "string")
    ) {
      logger.warn(`Invalid "requestFiles" from judge client ${client.id} (${state.judgeClient.name}), ignoring`);
      return [];
    }

    const allowedFileUuids = new Set<string>();
    state.assignedTasks.forEach(task => collectFileUuids(task.extraInfo, allowedFileUuids));
    const deniedCount = fileUuids.filter(fileUuid => !allowedFileUuids.has(fileUuid)).length;
    if (deniedCount > 0) {
      logger.warn(
        `Judge client ${client.id} (${state.judgeClient.name}) requested ${deniedCount} files not referenced by its assigned tasks, refusing`
      );
      return [];
    }

    logger.log(`Judge client ${client.id} (${state.judgeClient.name}) requested ${fileUuids.length} files`);
    return await Promise.all(
      fileUuids.map(
        async fileUuid =>
          await this.fileService.signDownloadLink({
            uuid: fileUuid,
            downloadFilename: null,
            expiresSeconds: JUDGE_FILE_DOWNLOAD_EXPIRE_TIME,
            signFor: MinioSignFor.Judge
          })
      )
    );
  }

  @SubscribeMessage("consumeTask")
  async onConsumeTask(@ConnectedSocket() client: Socket, @MessageBody() threadId: number): Promise<void> {
    const state = this.mapSessionIdToJudgeClient.get(client.id);
    if (!state) {
      logger.warn(`"consumeTask" emitted from an unknown client ${client.id}, ignoring`);
      return;
    }

    /* eslint-disable no-await-in-loop */
    while (await this.checkConnection(client)) {
      let task: JudgeTask<JudgeTaskExtraInfo>;
      try {
        task = await this.judgeQueueService.consumeTask();
      } catch (e) {
        // The client waits for a task for this thread until it reconnects, so never give up on its request.
        logger.error(`Failed to consume judge queue for client ${client.id} (${state.judgeClient.name}): ${e}`);
        await new Promise(resolve => setTimeout(resolve, CONSUME_TASK_RETRY_DELAY));
        continue;
      }
      if (!task) continue;

      if (!(await this.checkConnection(client))) {
        logger.verbose(
          `Consumed task for client ${client.id} (${state.judgeClient.name}), but connection became invalid, repushing task back to queue`
        );
        await this.judgeQueueService.pushTask(task.taskId, task.type, task.priority, true);
        return;
      }

      state.pendingTasks.add(task);
      state.assignedTasks.set(task.taskId, task);
      this.mapTaskIdToSocket.set(task.taskId, client);
      client.emit("task", threadId, task, () => {
        logger.verbose(
          `Judge client ${client.id} (${state.judgeClient.name}) acknowledged task { taskId: ${task.taskId}, type: ${task.type} }`
        );
        state.pendingTasks.delete(task);
        this.mapTaskIdToSocket.delete(task.taskId);
        setTimeout(() => {
          if (state.assignedTasks.get(task.taskId) === task) state.assignedTasks.delete(task.taskId);
        }, ACKNOWLEDGED_TASK_GRACE_TIME).unref();
      });

      return;
    }
    /* eslint-enable no-await-in-loop */
  }

  /**
   * The returned value is sent as the message's acknowledgement after the progress has been processed
   * (see `SERVER_CAPABILITIES.progressAck`). If processing throws, no acknowledgement is sent.
   */
  @SubscribeMessage("progress")
  async onProgress(
    @ConnectedSocket() client: Socket,
    @MessageBody() message: SubmissionProgressMessage
  ): Promise<boolean> {
    const state = this.mapSessionIdToJudgeClient.get(client.id);
    if (!state) {
      logger.warn(`"progress" emitted from an unknown client ${client.id}, ignoring`);
      return false;
    }

    if (!isJudgeTaskMeta(message?.taskMeta)) {
      logger.warn(`Invalid "progress" from judge client ${client.id} (${state.judgeClient.name}), ignoring`);
      return false;
    }

    const assignedTask = state.assignedTasks.get(message.taskMeta.taskId);
    if (!assignedTask || assignedTask.type !== message.taskMeta.type) {
      logger.warn(
        `Judge client ${client.id} (${state.judgeClient.name}) reported progress for task ${message.taskMeta.taskId} not assigned to it, ignoring`
      );
      return false;
    }

    const notCanceled = await this.judgeQueueService.onTaskProgress(message.taskMeta, message.progress);
    if (!notCanceled) {
      logger.log(`Emitting cancel event for task ${message.taskMeta.taskId}`);
      client.emit("cancel", message.taskMeta.taskId);
    }
    return notCanceled;
  }
}
