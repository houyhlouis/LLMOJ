import { Inject, forwardRef } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from "@nestjs/websockets";

import { Namespace, Socket } from "socket.io"; // eslint-disable-line import/no-extraneous-dependencies
import jwt from "jsonwebtoken";
import { diff } from "jsondiffpatch";
import SocketIOParser from "socket.io-msgpack-parser";

import { SubmissionStatus } from "@libreoj/judge-protocol";

import { SubmissionProgress, SubmissionProgressType } from "./submission-progress.interface";
import { withoutTestData } from "./submission-redaction";
import { SubmissionPermissionType, SubmissionService } from "./submission.service";
import { SubmissionEventType } from "./submission-progress.service";

import { SubmissionEntity } from "./submission.entity";

import { SubmissionBasicMetaDto } from "./dto";

import { AuthSessionService } from "../auth/auth-session.service";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";
import { ProblemService, ProblemPermissionType } from "../problem/problem.service";

import { MetricsService } from "../metrics/metrics.service";
import { ConfigService } from "../config/config.service";
import { logger } from "../logger";

export enum SubmissionProgressSubscriptionType {
  Meta,
  Detail,
  DetailWithoutTestData
}

export interface SubmissionProgressSubscription {
  type: SubmissionProgressSubscriptionType;
  submissionIds: number[];
  userId: number | null;
  sessionId: number | null;
  exp?: number;
}

interface SubmissionProgressMessage {
  // These properties exist if NOT finished
  // "progressMeta" always exists while "progressDetail" only exists when the client subscribes the detail
  // null if the task is still waiting in queue
  progressMeta?: {
    progressType: SubmissionProgressType;
    resultMeta?: SubmissionBasicMetaDto;
  };
  // status and score are not calculated to reduce server load
  progressDetail?: SubmissionProgress;
}

// TODO: This should be refactored if we add hack, custom judge, etc
//       Maybe refactor to a general "task progress"
@WebSocketGateway({
  maxHttpBufferSize: 1e9,
  namespace: "submission-progress",
  path: "/api/socket",
  transports: ["websocket"],
  parser: SocketIOParser
})
export class SubmissionProgressGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server: Namespace;

  private secret: string;

  private clientSubscriptions = new Map<string, SubmissionProgressSubscription>();

  // Authorization is asynchronous. Keep a submission's events in their arrival order.
  private eventQueues = new Map<number, Promise<void>>();

  // We don't use Socket.IO rooms since we push message additionally
  // rooms: each set is created on first joins and deleted on last leaves
  private rooms: Map<string, Set<string>> = new Map();

  // clientJoinedRooms: each set is created and deleted on the client connects and disconnects
  private clientJoinedRooms: Map<string, Set<string>> = new Map();

  // This map of arraies is used to store the last message sent to each client,
  // to help us calculate the delta with jsondiffpatch
  // clientId => (submissionId => message)
  private clientLastMessages: Map<string, Map<number, SubmissionProgressMessage>> = new Map();

  constructor(
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => SubmissionService))
    private readonly submissionService: SubmissionService,
    private readonly metricsService: MetricsService,
    @Inject(forwardRef(() => AuthSessionService))
    private readonly authSessionService: AuthSessionService,
    private readonly userPrivilegeService: UserPrivilegeService,
    @Inject(forwardRef(() => ProblemService))
    private readonly problemService: ProblemService
  ) {
    // Use a different key with session secret to prevent someone attempt to use the session key
    // as subscription key
    this.secret = `${this.configService.config.security.sessionSecret}SubmissionProgress`;
  }

  private readonly metricCurrentClientCount = this.metricsService.gauge(
    "libreoj_submission_progress_current_client_count"
  );

  private readonly metricTotalClientConnected = this.metricsService.gauge(
    "libreoj_submission_progress_total_client_connected"
  );

  private readonly metricTotalMessageDelivered = this.metricsService.counter(
    "libreoj_submission_progress_total_message_delivered"
  );

  // Limit replay lifetime and bind the capability to the issuing account/session.
  // Current authorization is still checked before every message, including reconnects.
  encodeSubscription(subscription: SubmissionProgressSubscription): string {
    return jwt.sign(subscription, this.secret, {
      algorithm: "HS256",
      issuer: "libreoj:submission-progress",
      expiresIn: "24h"
    });
  }

  decodeSubscription(subscriptionKey: string): SubmissionProgressSubscription {
    try {
      const subscription = jwt.verify(subscriptionKey, this.secret, {
        algorithms: ["HS256"],
        issuer: "libreoj:submission-progress"
      }) as SubmissionProgressSubscription;
      const validId = (id: number) => Number.isSafeInteger(id) && id > 0;
      if (
        ![
          SubmissionProgressSubscriptionType.Meta,
          SubmissionProgressSubscriptionType.Detail,
          SubmissionProgressSubscriptionType.DetailWithoutTestData
        ].includes(subscription.type) ||
        !Array.isArray(subscription.submissionIds) ||
        !subscription.submissionIds.length ||
        !subscription.submissionIds.every(validId) ||
        !Number.isFinite(subscription.exp) ||
        !(
          (subscription.userId === null && subscription.sessionId === null) ||
          (validId(subscription.userId) && validId(subscription.sessionId))
        )
      )
        return null;
      return subscription;
    } catch (e) {
      logger.log("Invalid submission progress subscription key");
      return null;
    }
  }

  private async isAuthorized(
    subscription: SubmissionProgressSubscription,
    submission: SubmissionEntity
  ): Promise<boolean> {
    if (!submission || subscription.exp * 1000 <= Date.now()) return false;
    const user =
      subscription.userId === null
        ? null
        : await this.authSessionService.accessSessionById(subscription.userId, subscription.sessionId);
    if (subscription.userId !== null && !user) return false;
    if (
      !(await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ViewSite)) ||
      !(await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ViewSubmission))
    )
      return false;

    if (subscription.type === SubmissionProgressSubscriptionType.Meta && !submission.contestId) {
      // List progress exposes metadata; keep its visibility rules independent of code access.
      if (
        !(
          submission.isPublic ||
          user?.id === submission.submitterId ||
          (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem)) ||
          (await this.problemService.userHasPermission(
            user,
            await this.problemService.findProblemById(submission.problemId),
            ProblemPermissionType.View
          ))
        )
      )
        return false;
    } else if (!(await this.submissionService.userHasPermission(user, submission, SubmissionPermissionType.View))) {
      return false;
    }

    // Disconnect a formerly detailed stream instead of diffing to a redacted object:
    // jsondiffpatch deletion deltas themselves contain the previous private values.
    return (
      subscription.type !== SubmissionProgressSubscriptionType.Detail ||
      (await this.userPrivilegeService.permissionDecision(user, UserPrivilegeType.ReadProblemData, true))
    );
  }

  private getRoom(subscriptionType: SubmissionProgressSubscriptionType, submissionId: number) {
    return `${subscriptionType}_${submissionId}`;
  }

  private joinRoom(client: Socket, room: string) {
    logger.log(`Joining client ${client.id} to room ${room}`);
    const joinedRooms = this.clientJoinedRooms.get(client.id);
    if (!joinedRooms) {
      // Already disconnected
      return;
    }

    joinedRooms.add(room);
    if (!this.rooms.has(room)) this.rooms.set(room, new Set());
    this.rooms.get(room).add(client.id);
  }

  private leaveRoom(client: Socket, room: string) {
    logger.log(`Leaving client ${client.id} from room ${room}`);
    const joinedRooms = this.clientJoinedRooms.get(client.id);
    if (!joinedRooms) {
      // Already disconnected
      return;
    }

    joinedRooms.delete(room);
    const roomClients = this.rooms.get(room);
    if (!roomClients) {
      // Already leaved and room became empty
      return;
    }
    roomClients.delete(client.id);
    if (roomClients.size === 0) this.rooms.delete(room);

    if (joinedRooms.size === 0) client.disconnect(true);
  }

  private clearRoom(room: string) {
    for (const clientId of [...(this.rooms.get(room) || [])]) {
      const client = this.server.sockets.get(clientId);
      if (client) this.leaveRoom(client, room);
    }
    this.rooms.delete(room);
  }

  private async sendMessage(to: Socket | string, submissionId: number, message: SubmissionProgressMessage) {
    const clientIds = typeof to === "string" ? [...(this.rooms.get(to) || [])] : [to.id];
    if (!clientIds.length) return;
    const submission = await this.submissionService.findSubmissionById(submissionId);
    await Promise.all(
      clientIds.map(async clientId => {
        const subscription = this.clientSubscriptions.get(clientId);
        const client = this.server.sockets.get(clientId);
        if (!subscription || !client) return;
        try {
          if (!(await this.isAuthorized(subscription, submission))) {
            client.disconnect(true);
            return;
          }
          // The socket may have disconnected while permission checks were in flight.
          const messages = this.clientLastMessages.get(clientId);
          if (!messages || !this.clientJoinedRooms.get(clientId)?.has(this.getRoom(subscription.type, submissionId)))
            return;
          const delta = diff(messages.get(submissionId), message);
          messages.set(submissionId, message);
          if (delta) {
            this.metricTotalMessageDelivered.inc();
            this.server.to(clientId).emit("message", submissionId, delta);
          }
        } catch (error) {
          // Authorization/storage failures must never leave an unchecked stream active.
          logger.error("Failed to authorize submission progress", error.stack);
          client.disconnect(true);
        }
      })
    );
  }

  handleDisconnect(client: Socket): void {
    const rooms = this.clientJoinedRooms.get(client.id);
    if (rooms) {
      this.metricCurrentClientCount.dec();
      this.clientJoinedRooms.delete(client.id);
      for (const room of rooms) {
        const members = this.rooms.get(room);
        members?.delete(client.id);
        if (members?.size === 0) this.rooms.delete(room);
      }
    }
    this.clientSubscriptions.delete(client.id);
    this.clientLastMessages.delete(client.id);
  }

  async handleConnection(client: Socket): Promise<void> {
    const subscription = this.decodeSubscription(client.handshake.query.subscriptionKey as string);
    if (!subscription) {
      client.disconnect(true);
      return;
    }

    try {
      const submissions = await Promise.all(
        subscription.submissionIds.map(id => this.submissionService.findSubmissionById(id))
      );
      const permissions = await Promise.all(submissions.map(submission => this.isAuthorized(subscription, submission)));
      if (!client.connected || permissions.some(allowed => !allowed)) {
        client.disconnect(true);
        return;
      }
    } catch (error) {
      logger.error("Failed to authorize submission progress connection", error.stack);
      client.disconnect(true);
      return;
    }

    this.clientSubscriptions.set(client.id, subscription);
    this.metricCurrentClientCount.inc();
    this.metricTotalClientConnected.inc();

    this.clientJoinedRooms.set(client.id, new Set());
    this.clientLastMessages.set(client.id, new Map());

    // Join the rooms first to prevent missing the finished message
    for (const submissionId of subscription.submissionIds) {
      this.joinRoom(client, this.getRoom(subscription.type, submissionId));
    }

    // Send messages for the already finished submissions
    await Promise.all(
      subscription.submissionIds.map(async submissionId => {
        const submission = await this.submissionService.findSubmissionById(submissionId);

        // Submission deleted?
        if (!submission) {
          this.leaveRoom(client, this.getRoom(subscription.type, submissionId));
          return;
        }

        if (submission.status === SubmissionStatus.Pending) return;

        // This submission has already finished

        const basicMeta = await this.submissionService.getSubmissionBasicMeta(submission);

        switch (subscription.type) {
          case SubmissionProgressSubscriptionType.Meta:
            await this.sendMessage(client, submissionId, {
              progressMeta: {
                progressType: SubmissionProgressType.Finished,
                resultMeta: basicMeta
              }
            });
            break;
          case SubmissionProgressSubscriptionType.Detail:
          case SubmissionProgressSubscriptionType.DetailWithoutTestData: {
            const submissionDetail = await this.submissionService.getSubmissionDetail(submission);
            await this.sendMessage(client, submissionId, {
              progressMeta: {
                progressType: SubmissionProgressType.Finished,
                resultMeta: basicMeta
              },
              progressDetail:
                subscription.type === SubmissionProgressSubscriptionType.DetailWithoutTestData
                  ? withoutTestData(submissionDetail.result)
                  : submissionDetail.result
            });
            break;
          }
          default:
        }

        this.leaveRoom(client, this.getRoom(subscription.type, submissionId));
      })
    ).catch(error => {
      logger.error("Failed to initialize submission progress connection", error.stack);
      client.disconnect(true);
    });
  }

  async onSubmissionEvent(
    submissionId: number,
    type: SubmissionEventType,
    progress?: SubmissionProgress
  ): Promise<void> {
    const previous = this.eventQueues.get(submissionId) || Promise.resolve();
    const next = previous
      .then(() => this.deliverSubmissionEvent(submissionId, type, progress))
      .catch(error => {
        logger.error("Failed to deliver submission progress", error.stack);
        for (const subscriptionType of [
          SubmissionProgressSubscriptionType.Meta,
          SubmissionProgressSubscriptionType.Detail,
          SubmissionProgressSubscriptionType.DetailWithoutTestData
        ]) {
          this.clearRoom(this.getRoom(subscriptionType, submissionId));
        }
      });
    this.eventQueues.set(submissionId, next);
    await next;
    if (this.eventQueues.get(submissionId) === next) this.eventQueues.delete(submissionId);
  }

  private async deliverSubmissionEvent(
    submissionId: number,
    type: SubmissionEventType,
    // progress == null only when type === SubmissionEventType.(Deleted or Canceled)
    progress?: SubmissionProgress
  ): Promise<void> {
    const isDeleted = type === SubmissionEventType.Deleted;
    const isCanceled = !isDeleted && !progress;

    const progressType = isDeleted || isCanceled ? SubmissionProgressType.Finished : progress.progressType;

    const isFinished = progressType === SubmissionProgressType.Finished;

    if (!isDeleted) {
      // If the progressType is "Finished", it's called after database updated
      const submission = isFinished && (await this.submissionService.findSubmissionById(submissionId));
      const basicMeta = isFinished && (await this.submissionService.getSubmissionBasicMeta(submission));

      await this.sendMessage(this.getRoom(SubmissionProgressSubscriptionType.Meta, submissionId), submissionId, {
        progressMeta: {
          progressType,
          resultMeta: basicMeta
        }
      });
      await this.sendMessage(
        this.getRoom(SubmissionProgressSubscriptionType.DetailWithoutTestData, submissionId),
        submissionId,
        {
          progressMeta: { progressType, resultMeta: basicMeta },
          progressDetail: withoutTestData(progress)
        }
      );
      await this.sendMessage(this.getRoom(SubmissionProgressSubscriptionType.Detail, submissionId), submissionId, {
        progressMeta: {
          progressType,
          resultMeta: basicMeta
        },
        progressDetail: progress
      });
    }

    if (isFinished) {
      this.clearRoom(this.getRoom(SubmissionProgressSubscriptionType.Meta, submissionId));
      this.clearRoom(this.getRoom(SubmissionProgressSubscriptionType.Detail, submissionId));
      this.clearRoom(this.getRoom(SubmissionProgressSubscriptionType.DetailWithoutTestData, submissionId));
    }
  }
}
