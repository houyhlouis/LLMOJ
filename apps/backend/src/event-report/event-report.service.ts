import { setTimeout as delay } from "timers/promises";

import { Injectable, Logger } from "@nestjs/common";

import moment from "moment";
import { ProxyAgent } from "proxy-agent";
import { Telegram } from "telegraf";
import randomstring from "randomstring";

import { createReportContext, redactReportText, reportErrorClass } from "./report-redaction";

import { ConfigService } from "../config/config.service";
import { ClusterService } from "../cluster/cluster.service";
import { RequestWithSession } from "../auth/auth.middleware";
import { requestContext } from "../common/request-context";

const logger = new Logger("EventReporter");

export enum EventReportType {
  Error = "Error",
  Warning = "Warning",
  Info = "Info",
  Success = "Success"
}

const emoji: Record<EventReportType, string> = {
  [EventReportType.Error]: "❌",
  [EventReportType.Warning]: "⚠️",
  [EventReportType.Info]: "ℹ️",
  [EventReportType.Success]: "✅"
};

interface EventMessage {
  message: string;
  filename: string;
  fileContent: string;
}

const IPC_CHANNEL = "event-report";
const QUEUE_LIMIT = 64;
const SEND_TIMEOUT_MS = 10_000;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export function escapeTelegramHtml(text: string) {
  return text.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;");
}

@Injectable()
export class EventReportService {
  readonly enabled: boolean;

  private readonly telegram: Telegram;
  private readonly queue: EventMessage[] = [];
  private draining = false;
  private dropped = 0;
  private failures = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly clusterService: ClusterService
  ) {
    const { telegramBotToken, proxyUrl, telegramApiRoot } = this.configService.config.eventReport ?? {};
    this.enabled = !!telegramBotToken;
    if (!this.enabled || !this.clusterService.isMaster) return;

    try {
      // Outbound reports only need the Bot API client. Polling for incoming updates would start another network task.
      this.telegram = new Telegram(telegramBotToken, {
        agent: proxyUrl ? new ProxyAgent({ getProxyForUrl: () => proxyUrl }) : null,
        apiRoot: telegramApiRoot || undefined
      });
      this.clusterService.onMessageFromWorker<EventMessage>(IPC_CHANNEL, message => this.enqueue(message));
    } catch (error) {
      this.enabled = false;
      this.logFailure(error);
    }
  }

  async report({
    type,
    error,
    request,
    requestId,
    message
  }: {
    type: EventReportType;
    error?: unknown;
    request?: RequestWithSession;
    requestId?: string;
    message?: string;
  }) {
    if (!this.enabled) return;

    try {
      const { siteName } = this.configService.config.preference;
      const now = moment().format("YYYY-MM-DD HH:mm:ss");
      const eventId = randomstring.generate({ length: 8, charset: "numeric" });
      const context = createReportContext({ eventId, requestId, request, error, message });
      const fileContent = JSON.stringify(context, null, 2);
      // Even if every character becomes a six-character HTML entity, the preview fits Telegram's 4096 limit.
      // The attachment carries the complete, bounded safe context.
      const finalMessage =
        `[${redactReportText(siteName).slice(0, 80)}] ${emoji[type]} Event #${eventId} (${type}) at ${now}\n${fileContent}`.slice(
          0,
          600
        );

      // A local listener and its timers would otherwise inherit the entire HTTP request through AsyncLocalStorage.
      requestContext.run(undefined, () =>
        this.clusterService.postMessageToMaster<EventMessage>(
          IPC_CHANNEL,
          { message: finalMessage, filename: `Event_${eventId}.json`, fileContent },
          ipcError => {
            if (ipcError) this.logFailure(ipcError);
          }
        )
      );
    } catch (reportError) {
      this.logFailure(reportError);
    }
  }

  private logFailure(error: unknown) {
    this.failures++;
    // Sender errors may contain the bot token and the rejected attachment.
    requestContext.run(undefined, () =>
      logger.warn(`Event report failed (${reportErrorClass(error)}) failures=${this.failures} dropped=${this.dropped}`)
    );
  }

  private enqueue(message: EventMessage) {
    if (this.queue.length === QUEUE_LIMIT) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push(message);
    if (!this.draining) this.drainQueue().catch(error => this.logFailure(error));
  }

  private async drainQueue() {
    this.draining = true;
    let backoffMs = 0;
    let loggedDrops = this.dropped;
    try {
      while (this.queue.length) {
        try {
          // eslint-disable-next-line no-await-in-loop -- One report at a time, including its attachment.
          await this.doReport(this.queue.shift());
          backoffMs = 0;
        } catch (error) {
          this.logFailure(error);
          loggedDrops = this.dropped;
          backoffMs = backoffMs ? Math.min(backoffMs * 2, MAX_BACKOFF_MS) : INITIAL_BACKOFF_MS;
        }
        if (loggedDrops !== this.dropped) {
          logger.warn(`Event report queue overflow dropped=${this.dropped}`);
          loggedDrops = this.dropped;
        }
        if (backoffMs) {
          // Never retry a report. Telegram may already have accepted its preview or attachment.
          // eslint-disable-next-line no-await-in-loop -- Hold off subsequent sends during an outage.
          await delay(backoffMs, undefined, { ref: false });
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async doReport(message: EventMessage) {
    const chatId = this.configService.config.eventReport.sentTo;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS).unref();
    // Telegraf types callApi against the abort-controller shim. Its node-fetch transport accepts native signals.
    const options = { signal: controller.signal } as Parameters<Telegram["callApi"]>[2];
    try {
      await this.telegram.callApi(
        "sendMessage",
        { chat_id: chatId, text: `<pre>${escapeTelegramHtml(message.message.trim())}</pre>`, parse_mode: "HTML" },
        options
      );
      if (message.filename)
        await this.telegram.callApi(
          "sendDocument",
          { chat_id: chatId, document: { filename: message.filename, source: Buffer.from(message.fileContent) } },
          options
        );
    } finally {
      clearTimeout(timeout);
    }
  }
}
