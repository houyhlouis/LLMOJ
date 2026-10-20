import cluster from "cluster";
import http from "http";

import { Injectable, Logger } from "@nestjs/common";

import PromClient from "@prometheus-io/client";

import { ConfigService } from "../config/config.service";

/** A reading shared by the metrics that use it: read at most once per `milliseconds`. */
export function sharedReading<T>(read: () => Promise<T>, milliseconds = 1000): () => Promise<T> {
  let last: { at: number; value: Promise<T> } = null;
  return () => {
    if (!last || Date.now() - last.at >= milliseconds) {
      const reading = { at: Date.now(), value: read() };
      last = reading;
      // A failed reading is retried by the next metric
      reading.value.catch(() => {
        if (last === reading) last = null;
      });
    }
    return last.value;
  };
}

@Injectable()
export class MetricsService {
  private readonly registry = new PromClient.Registry();

  private readonly processName = cluster.isPrimary ? "Master" : `Worker #${cluster.worker.id}`;

  private readonly logger = new Logger(`${MetricsService.name}/${this.processName}`);

  constructor(private readonly configService: ConfigService) {
    const config = this.configService.config.metrics;
    if (!config) {
      this.logger.warn("Metrics not configured");
      return;
    }

    PromClient.collectDefaultMetrics({ register: this.registry });

    const processName = cluster.isPrimary ? "Master" : `Worker #${cluster.worker.id}`;
    const port = config.basePort + (cluster.isPrimary ? 0 : cluster.worker.id);
    http
      .createServer(async (req, res) => {
        try {
          if (config.allowedIps?.length > 0 && !config.allowedIps.includes(req.socket.remoteAddress!)) {
            res.writeHead(403).end();
            return;
          }
          res.writeHead(200, {
            "Content-Type": this.registry.contentType
          });
          res.write(await this.registry.metrics());
          res.end();
        } catch (e) {
          this.logger.error(`Failed to serve metrics request: ${e instanceof Error ? e.stack : String(e)}`);
          try {
            res.writeHead(500).end();
          } catch {
            res.end();
          }
        }
      })
      .listen(port, config.hostname, () => {
        this.logger.log(`Metrics server is listening on ${config.hostname}:${port} (${processName})`);
      });
  }

  counter = <T extends string>(name: string, labelNames: readonly T[] = []) =>
    new PromClient.Counter({
      name,
      help: name,
      labelNames,
      registers: [this.registry]
    });

  /**
   * @param collect Sets the gauge's values when the metrics are read (only then). If it fails, the gauge is unknown in
   * that reading (no values, or NaN without labels), and the failure is logged at most once a minute.
   */
  gauge = <T extends string>(
    name: string,
    labelNames: readonly T[] = [],
    collect: (gauge: PromClient.Gauge<T>) => void | Promise<void> = null
  ) =>
    new PromClient.Gauge({
      name,
      help: name,
      labelNames,
      registers: [this.registry],
      ...(collect ? { collect: this.collector(name, collect) } : {})
    });

  private collectionFailureLoggedAt = new Map<string, number>();

  private collector<T extends string>(name: string, collect: (gauge: PromClient.Gauge<T>) => void | Promise<void>) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- prom-client calls `collect` with the gauge as `this`
    const service = this;
    return async function collectGauge(this: PromClient.Gauge<T>) {
      try {
        await collect(this);
      } catch (e) {
        // Unknown: no values, or NaN for a gauge without labels (which would otherwise read 0)
        this.reset();
        if (!(this as unknown as { labelNames: string[] }).labelNames.length) this.set(NaN);
        if (Date.now() - (service.collectionFailureLoggedAt.get(name) ?? -Infinity) >= 60 * 1000) {
          service.collectionFailureLoggedAt.set(name, Date.now());
          service.logger.warn(`Failed to read metric ${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    };
  }

  histogram = Object.assign(
    <T extends string>(name: string, buckets: number[], labelNames: readonly T[] = []) =>
      new PromClient.Histogram({
        name,
        help: name,
        buckets,
        labelNames,
        registers: [this.registry]
      }),
    {
      linearBuckets: PromClient.linearBuckets,
      exponentialBuckets: PromClient.exponentialBuckets,
      BUCKETS_TIME_10M_30: PromClient.exponentialBuckets(0.05, 1.368, 30),
      BUCKETS_TIME_5S_10: PromClient.exponentialBuckets(0.03, 1.79, 10)
    }
  );
}
