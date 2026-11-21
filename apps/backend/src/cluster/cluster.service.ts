import { cpus } from "os";
import cluster, { Worker } from "cluster";

import { Injectable, Inject, forwardRef, Logger, OnModuleDestroy } from "@nestjs/common";

import { ConfigService } from "../config/config.service";

interface IpcMessage {
  channel: string;
  data: unknown;
}

interface WorkerSlot {
  number: number;
  retryDelay: number;
  worker?: Worker;
  replacement?: ReturnType<typeof setTimeout>;
}

const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 4000;
const CRASH_WINDOW_MS = 60000;
const MAX_CRASHES_PER_WINDOW = 8;

@Injectable()
export class ClusterService implements OnModuleDestroy {
  readonly enabled: boolean;

  readonly isMaster: boolean;

  readonly isWorker: boolean;

  private readonly messageListeners = new Map<string, Array<(data: unknown) => void>>();

  private readonly logger = new Logger(ClusterService.name);

  private readonly slots: WorkerSlot[] = [];

  private recentCrashes: number[] = [];

  private stopping = false;

  constructor(
    @Inject(forwardRef(() => ConfigService))
    private readonly configService: ConfigService
  ) {
    this.enabled = this.configService.config.server.clusters != null;
    this.isMaster = cluster.isPrimary;
    this.isWorker = cluster.isWorker || !this.enabled;
  }

  async initialization(workerCallback: () => Promise<void>) {
    if (this.isWorker) {
      await workerCallback();
      return;
    }

    cluster.on("message", this.onWorkerMessage);
    process.prependOnceListener("SIGTERM", this.onShutdownSignal);
    process.prependOnceListener("SIGINT", this.onShutdownSignal);
    const count = this.configService.config.server.clusters || cpus().length;
    for (let number = 1; number <= count; number++) {
      const slot = { number, retryDelay: FIRST_RETRY_MS };
      this.slots.push(slot);
      this.startWorker(slot);
    }
  }

  private startWorker(slot: WorkerSlot) {
    slot.replacement = undefined;
    const startedAt = Date.now();
    try {
      slot.worker = cluster.fork({ LLMOJ_WORKER_SLOT: String(slot.number) });
    } catch {
      this.scheduleReplacement(slot, "could not be forked");
      return;
    }
    const { worker } = slot;
    const replace = (reason: string) => {
      if (slot.worker !== worker) return;
      slot.worker = undefined;
      // A failed spawn can emit only 'error'. Release its entry in Node's cluster registry.
      if (!worker.process.pid) worker.disconnect();
      else if (Date.now() - startedAt >= CRASH_WINDOW_MS) slot.retryDelay = FIRST_RETRY_MS;
      this.scheduleReplacement(slot, reason);
    };
    worker.on("error", () => {
      if (!worker.process.pid) replace("could not be forked");
      else if (slot.worker === worker && !this.stopping) this.logger.warn(`Worker slot ${slot.number} process error.`);
    });
    worker.once("exit", (code, signal) => replace(`exited (${signal || code})`));
  }

  private scheduleReplacement(slot: WorkerSlot, reason: string) {
    if (this.stopping) return;
    const now = Date.now();
    this.recentCrashes = this.recentCrashes.filter(time => time > now - CRASH_WINDOW_MS);
    this.recentCrashes.push(now);
    if (this.recentCrashes.length > MAX_CRASHES_PER_WINDOW) {
      this.logger.error(
        `Worker slot ${slot.number} ${reason}. Too many worker failures in ${CRASH_WINDOW_MS} ms. Exiting.`
      );
      this.onModuleDestroy();
      process.exit(1);
      return;
    }

    const delay = slot.retryDelay;
    this.logger.warn(`Worker slot ${slot.number} ${reason}. Replacing in ${delay} ms.`);
    slot.retryDelay = Math.min(delay * 2, MAX_RETRY_MS);
    slot.replacement = setTimeout(() => this.startWorker(slot), delay);
  }

  private readonly onShutdownSignal = (signal: "SIGTERM" | "SIGINT") => {
    this.onModuleDestroy();
    // Other shutdown handlers (e.g. Nest) own termination when present. Otherwise restore Node's signal exit.
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };

  onModuleDestroy() {
    if (this.stopping || this.isWorker) return;
    this.stopping = true;
    process.removeListener("SIGTERM", this.onShutdownSignal);
    process.removeListener("SIGINT", this.onShutdownSignal);
    cluster.removeListener("message", this.onWorkerMessage);
    for (const slot of this.slots) {
      clearTimeout(slot.replacement);
      slot.worker?.kill();
    }
  }

  private readonly onWorkerMessage = (worker: Worker, message: IpcMessage) => this.callMessageListeners(message);

  private callMessageListeners(message: IpcMessage) {
    (this.messageListeners.get(message.channel) || []).forEach(callback => callback(message.data));
  }

  /**
   * If cluster is not enabled, the channel's callback will be called directly.
   */
  postMessageToMaster<T>(channel: string, data: T, callback?: (error: Error | null) => void) {
    const message = {
      channel,
      data
    };

    if (this.isMaster) this.callMessageListeners(message);
    else process.send(message, callback);
  }

  onMessageFromWorker<T>(channel: string, callback: (data: T) => void) {
    if (!this.messageListeners.has(channel)) this.messageListeners.set(channel, []);
    this.messageListeners.get(channel).push(callback);
  }
}
