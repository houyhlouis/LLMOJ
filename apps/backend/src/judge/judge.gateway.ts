import { forwardRef, Inject, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
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

import { JudgeClientCapabilities, JudgeClientSystemInfo, JudgeTaskMeta, JudgeTaskType } from "@libreoj/judge-protocol";

import { JudgeClientChange, JudgeClientService, REDIS_CHANNEL_JUDGE_CLIENT_CHANGED } from "./judge-client.service";

import { JudgeClientEntity } from "./judge-client.entity";

import {
  JudgeQueueService,
  JudgeTask,
  JudgeTaskExtraInfo,
  LEASE_RENEW_INTERVAL,
  LeasedJudgeTask
} from "./judge-queue.service";
import { JudgeJobAttemptOutcome } from "./judge-job.entity";
import { JudgeRuntimeService, parseJudgeRuntime } from "./judge-runtime.service";

import { logger } from "../logger";
import { MinioSignFor, FileService, JUDGE_FILE_DOWNLOAD_EXPIRE_TIME } from "../file/file.service";
import { SubmissionProgress } from "../submission/submission-progress.interface";
import { ConfigService } from "../config/config.service";
import { EventReportService, EventReportType } from "../event-report/event-report.service";
import { RedisService } from "../redis/redis.service";
import { LockService } from "../redis/lock.service";
import { MetricsService } from "../metrics/metrics.service";
import { SOCKET_IO_MAX_MESSAGE_SIZE } from "../socket-io.constants";

// A task sent to a judge client connection, under the lease with this fence.
interface JudgeTaskAssignment {
  task: JudgeTask<JudgeTaskExtraInfo>;
  fence: number;
  // What it's judged with, recorded with its result
  judgeRuntimeId: number;
}

interface JudgeClientState {
  socket: Socket;
  judgeClient: JudgeClientEntity;
  // As announced by the judge client; null for one that announces nothing (protocol version 1)
  capabilities: JudgeClientCapabilities;
  // The record of the runtime it announced (protocol version 3), once recorded; null for none
  judgeRuntimeId: Promise<number>;
  // Tasks sent to this client, by task ID: until it acknowledges them, plus a grace time.
  // A client may only report progress for, and download files of, its own assigned tasks.
  assignedTasks: Map<string, JudgeTaskAssignment>;
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

// Judge clients send a task's result before acknowledging the task. Older ones (without progress acknowledgement)
// may send it a moment after, so an acknowledged task stays assigned to its client for a short while. A lease still
// held after that ended without a result, and its job is queued again.
const ACKNOWLEDGED_TASK_GRACE_TIME = 10 * 1000;

const MAX_FILES_PER_REQUEST = 10000;

const CONSUME_TASK_RETRY_DELAY = 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sent as the third argument of "ready"; judge clients that predate it ignore it (see apps/judge/src/rpc.ts).
// progressAck: a "progress" message is acknowledged once processed (for a final result: stored).
const SERVER_CAPABILITIES = {
  progressAck: true
};

// Judge clients older than protocol version 2 announce nothing and are sent only submissions.
const LEGACY_TASK_TYPES = [JudgeTaskType.Submission];

const isCount = (value: unknown, maximum: number) =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;

// The announced capabilities, or null if they aren't valid. An invalid runtime is left out.
function parseCapabilities(value: unknown): JudgeClientCapabilities {
  const capabilities = value as JudgeClientCapabilities;
  const runtime = capabilities && typeof capabilities === "object" ? parseJudgeRuntime(capabilities.runtime) : null;
  const taskTypes = Object.values(JudgeTaskType) as unknown[];
  if (
    !capabilities ||
    typeof capabilities !== "object" ||
    !isCount(capabilities.protocolVersion, 1000) ||
    capabilities.protocolVersion < 2 ||
    !Array.isArray(capabilities.taskTypes) ||
    capabilities.taskTypes.length > 100 ||
    !isCount(capabilities.consumerThreads, 1024) ||
    !isCount(capabilities.executionSlots, 1024) ||
    !isCount(capabilities.memoryBudget, 1024 * 1024 * 1024) ||
    !isCount(capabilities.aiExecutionSlots, 1024)
  )
    return null;
  return {
    protocolVersion: capabilities.protocolVersion,
    // Unknown types are newer than this backend
    taskTypes: [...new Set(capabilities.taskTypes.filter(type => taskTypes.includes(type)))],
    consumerThreads: capabilities.consumerThreads,
    executionSlots: capabilities.executionSlots,
    memoryBudget: capabilities.memoryBudget,
    aiExecutionSlots: capabilities.aiExecutionSlots,
    ...(runtime ? { runtime } : {})
  };
}

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
export class JudgeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  private server: Server;

  private mapSessionIdToJudgeClient: Map<string, JudgeClientState> = new Map();

  private mapTaskIdToSocket: Map<string, Socket> = new Map();

  private redis: Redis;

  // To subscribe the "cancel task" event
  private redisForSubscribe: Redis;

  private leaseRenewalTimer: ReturnType<typeof setInterval>;

  @Optional() @Inject(MetricsService) private readonly metricsService: MetricsService;

  @Optional() @Inject(JudgeRuntimeService) private readonly judgeRuntimeService: JudgeRuntimeService;

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
      if (channel === REDIS_CHANNEL_JUDGE_CLIENT_CHANGED)
        this.onJudgeClientChanged(message).catch(e => logger.error(`Failed to apply a judge client change: ${e}`));
      else this.onCancelTask(message);
    });
    this.redisForSubscribe.subscribe(REDIS_CHANNEL_CANCEL_TASK, REDIS_CHANNEL_JUDGE_CLIENT_CHANGED);
  }

  onModuleInit(): void {
    // Judge clients connected to this process
    this.metricsService?.gauge("libreoj_judge_clients", ["state"], gauge => {
      const states = [...this.mapSessionIdToJudgeClient.values()];
      gauge.set({ state: "accepting" }, states.filter(state => !state.judgeClient.draining).length);
      gauge.set({ state: "draining" }, states.filter(state => state.judgeClient.draining).length);
    });
    this.leaseRenewalTimer = setInterval(() => {
      this.renewLeases().catch(e => logger.error(`Failed to renew judge task leases: ${e}`));
    }, LEASE_RENEW_INTERVAL);
    this.leaseRenewalTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.leaseRenewalTimer);
  }

  // The leases of the tasks sent to connected judge clients don't expire while they stay connected.
  private async renewLeases(): Promise<void> {
    const leases = [...this.mapSessionIdToJudgeClient].flatMap(([connectionId, state]) =>
      [...state.assignedTasks.keys()].map(taskId => ({ taskId, connectionId }))
    );
    await this.judgeQueueService.renewLeases(leases);
  }

  // Send the cancel task operation to ALL nodes
  cancelTask(taskId: string) {
    this.redis.publish(REDIS_CHANNEL_CANCEL_TASK, taskId);
    this.judgeQueueService.cancel(taskId).catch(e => logger.error(`Failed to cancel the job of task ${taskId}: ${e}`));
  }

  // A revoked judge client (its key was reset, or it was deleted) is disconnected at once, in every backend process;
  // its unfinished tasks are queued again. A drained or resumed one gets its new state.
  async onJudgeClientChanged(message: string): Promise<void> {
    let change: JudgeClientChange;
    try {
      change = JSON.parse(message);
    } catch {
      return;
    }
    const states = [...this.mapSessionIdToJudgeClient.values()].filter(state => state.judgeClient.id === change.id);
    if (states.length === 0) return;
    const judgeClient = change.revoked ? null : await this.judgeClientService.findJudgeClientById(change.id);
    for (const state of states) {
      if (!judgeClient) {
        logger.log(`Disconnecting judge client ${state.socket.id} (${state.judgeClient.name}): its key was revoked`);
        state.socket.disconnect(true);
      } else {
        state.judgeClient = judgeClient;
        logger.log(
          `Judge client ${state.socket.id} (${judgeClient.name}) ${judgeClient.draining ? "drains" : "resumes"}`
        );
      }
    }
    if (judgeClient && !judgeClient.draining) this.judgeQueueService.notifyJobsAvailable();
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
      // Until it announces them again
      await this.judgeClientService.updateJudgeClientCapabilities(judgeClient, null);

      if (!client.connected) {
        await this.judgeClientService.disconnectJudgeClient(judgeClient);
      }

      this.mapSessionIdToJudgeClient.set(client.id, {
        socket: client,
        judgeClient,
        capabilities: null,
        judgeRuntimeId: Promise.resolve(null),
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

    if (state.assignedTasks.size !== 0) {
      logger.log(
        `Releasing ${state.assignedTasks.size} tasks of judge client ${client.id} (${state.judgeClient.name}).`
      );
      // Queue unfinished tasks again (a finished task's lease is no longer current, so it's left alone)
      await Promise.all(
        Array.from(state.assignedTasks.values()).map(async ({ task, fence }) => {
          if (this.mapTaskIdToSocket.get(task.taskId) === client) this.mapTaskIdToSocket.delete(task.taskId);
          try {
            await this.judgeQueueService.release(task.taskId, fence, client.id, JudgeJobAttemptOutcome.Disconnected);
          } catch (e) {
            // The lease is no longer renewed, so it expires and is reclaimed
            logger.error(`Failed to release judge task ${task.taskId}: ${e}`);
          }
        })
      );
      state.assignedTasks.clear();
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

  @SubscribeMessage("capabilities")
  async onCapabilities(@ConnectedSocket() client: Socket, @MessageBody() message: unknown): Promise<void> {
    const state = this.mapSessionIdToJudgeClient.get(client.id);
    if (!state) {
      logger.warn(`"capabilities" emitted from an unknown client ${client.id}, ignoring`);
      return;
    }
    const capabilities = parseCapabilities(message);
    if (!capabilities) {
      logger.warn(`Invalid "capabilities" from judge client ${client.id} (${state.judgeClient.name}), ignoring`);
      return;
    }
    state.capabilities = capabilities;
    // Before anything is awaited, so that the tasks this connection is sent next are recorded with it
    if (capabilities.runtime) state.judgeRuntimeId = this.recordRuntime(state, capabilities.runtime);
    logger.log(
      `Judge client ${client.id} (${state.judgeClient.name}) judges ${capabilities.taskTypes.join(", ")} (protocol ${
        capabilities.protocolVersion
      })`
    );
    await this.judgeClientService.updateJudgeClientCapabilities(state.judgeClient, capabilities);
    await state.judgeRuntimeId;
  }

  private async recordRuntime(state: JudgeClientState, runtime: JudgeClientCapabilities["runtime"]): Promise<number> {
    if (!this.judgeRuntimeService) return null;
    try {
      return await this.judgeRuntimeService.record(state.judgeClient.id, runtime);
    } catch (e) {
      // Its results are then recorded without their runtime
      logger.error(`Failed to record the runtime of judge client ${state.socket.id} (${state.judgeClient.name}): ${e}`);
      return null;
    }
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
    state.assignedTasks.forEach(({ task }) => collectFileUuids(task.extraInfo, allowedFileUuids));
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
      // A draining judge client is sent no new tasks until it's resumed
      if (state.judgeClient.draining) {
        await this.judgeQueueService.waitForJobs();
        continue;
      }
      let leased: LeasedJudgeTask;
      const judgeRuntimeId = await state.judgeRuntimeId;
      try {
        leased = await this.judgeQueueService.claim(
          { connectionId: client.id, judgeClientId: state.judgeClient.id, judgeRuntimeId },
          state.capabilities?.taskTypes ?? LEGACY_TASK_TYPES
        );
      } catch (e) {
        // The client waits for a task for this thread until it reconnects, so never give up on its request.
        logger.error(`Failed to consume judge queue for client ${client.id} (${state.judgeClient.name}): ${e}`);
        await new Promise(resolve => setTimeout(resolve, CONSUME_TASK_RETRY_DELAY));
        continue;
      }
      if (!leased) {
        await this.judgeQueueService.waitForJobs();
        continue;
      }

      const { task, fence } = leased;
      if (!(await this.checkConnection(client))) {
        logger.verbose(
          `Leased task for client ${client.id} (${state.judgeClient.name}), but connection became invalid, releasing it`
        );
        await this.judgeQueueService.release(task.taskId, fence, client.id, JudgeJobAttemptOutcome.Disconnected);
        return;
      }

      const assignment: JudgeTaskAssignment = { task, fence, judgeRuntimeId };
      state.assignedTasks.set(task.taskId, assignment);
      this.mapTaskIdToSocket.set(task.taskId, client);
      client.emit("task", threadId, task, () => this.onTaskAcknowledged(client, state, assignment));

      return;
    }
    /* eslint-enable no-await-in-loop */
  }

  private onTaskAcknowledged(client: Socket, state: JudgeClientState, assignment: JudgeTaskAssignment): void {
    const { task, fence } = assignment;
    logger.verbose(
      `Judge client ${client.id} (${state.judgeClient.name}) acknowledged task { taskId: ${task.taskId}, type: ${task.type} }`
    );
    if (this.mapTaskIdToSocket.get(task.taskId) === client) this.mapTaskIdToSocket.delete(task.taskId);
    setTimeout(async () => {
      if (state.assignedTasks.get(task.taskId) !== assignment) return;
      state.assignedTasks.delete(task.taskId);
      try {
        // A no-op once the result has been stored
        await this.judgeQueueService.release(task.taskId, fence, client.id, JudgeJobAttemptOutcome.Abandoned);
      } catch (e) {
        logger.error(`Failed to release judge task ${task.taskId}: ${e}`);
      }
    }, ACKNOWLEDGED_TASK_GRACE_TIME).unref();
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

    const assignment = state.assignedTasks.get(message.taskMeta.taskId);
    if (!assignment || assignment.task.type !== message.taskMeta.type) {
      logger.warn(
        `Judge client ${client.id} (${state.judgeClient.name}) reported progress for task ${message.taskMeta.taskId} not assigned to it, ignoring`
      );
      return false;
    }

    const notCanceled = await this.judgeQueueService.onTaskProgress(
      message.taskMeta,
      { fence: assignment.fence, connectionId: client.id, judgeRuntimeId: assignment.judgeRuntimeId },
      message.progress
    );
    if (!notCanceled) {
      logger.log(`Emitting cancel event for task ${message.taskMeta.taskId}`);
      client.emit("cancel", message.taskMeta.taskId);
    }
    return notCanceled;
  }
}
