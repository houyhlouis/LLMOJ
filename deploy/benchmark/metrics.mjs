// Read the series emitted by one backend's MetricsService (Prometheus text format).
// A previously unobserved histogram label has no series until its first observation.
const sql = "libreoj_request_sql_queries";
const queue = "libreoj_judge_task_queue_time_seconds";
const oldest = "libreoj_judge_oldest_queued_job_seconds";
const rss = "process_resident_memory_bytes";
const startTime = "process_start_time_seconds";

function samples(text) {
  const result = new Map();
  for (const line of text.split("\n")) {
    const match = /^(\w+)(\{.*\})?\s+(\S+)$/.exec(line.trim());
    if (!match) continue;
    const [, name, labels = "", raw] = match;
    if (![rss, startTime, oldest].includes(name) && !name.startsWith(sql + "_") && !name.startsWith(queue + "_")) {
      continue;
    }
    const value = Number(raw);
    if (Number.isFinite(value)) result.set(name + labels, { name, labels, value });
  }
  return result;
}

const gauge = (sample, name) => sample.get(name)?.value ?? null;
const average = (sum, count) => (count ? sum / count : null);

export function summarizeMetrics(beforeText, afterText, routes) {
  const before = samples(beforeText);
  const after = samples(afterText);
  if (gauge(before, rss) === null || gauge(after, rss) === null) throw new Error("Missing backend process RSS metric");
  if (gauge(before, startTime) !== gauge(after, startTime)) throw new Error("Backend process changed between scrapes");

  const byRoute = new Map(routes.map(route => [route, { queries: 0, requests: 0 }]));
  const buckets = new Map();
  let queries = 0,
    requests = 0,
    waits = 0,
    waitSeconds = 0;
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const { name, labels } = after.get(key) ?? before.get(key);
    if (!name.startsWith(sql + "_") && !name.startsWith(queue + "_")) continue;
    if (name === sql + "_bucket") continue;
    const delta = (after.get(key)?.value ?? -Infinity) - (before.get(key)?.value ?? 0);
    if (delta < 0) throw new Error("Backend counters reset between scrapes");
    if (name.startsWith(sql + "_")) {
      // The middleware labels successful HTTP responses by pathname, without their query strings.
      const route = /[,{]api="\/api\/([^"\\]*)"/.exec(labels)?.[1];
      const row = byRoute.get(route);
      if (!row) continue;
      if (name === sql + "_sum") {
        row.queries += delta;
        queries += delta;
      } else if (name === sql + "_count") {
        row.requests += delta;
        requests += delta;
      }
    } else if (name === queue + "_count") {
      waits += delta;
    } else if (name === queue + "_sum") {
      waitSeconds += delta;
    } else if (name === queue + "_bucket") {
      const le = /[,{]le="([^"]+)"/.exec(labels)?.[1];
      const bound = le === "+Inf" ? Infinity : Number(le);
      if (!Number.isNaN(bound)) buckets.set(bound, (buckets.get(bound) ?? 0) + delta);
    }
  }

  const p95 = waits && [...buckets].sort(([a], [b]) => a - b).find(([, count]) => count >= waits * 0.95);
  return {
    processRssBytes: { before: gauge(before, rss), after: gauge(after, rss) },
    sql: {
      requests,
      queries,
      queriesPerRequest: average(queries, requests),
      byRoute: Object.fromEntries(
        [...byRoute].map(([route, row]) => [route, { ...row, queriesPerRequest: average(row.queries, row.requests) }])
      )
    },
    cache: { available: false, reason: "The backend exports no cache hit, miss or stale-reject series." },
    judgeQueue: {
      waits,
      meanWaitSeconds: average(waitSeconds, waits),
      p95BucketUpperSeconds: p95 ? (p95[0] === Infinity ? "+Inf" : p95[0]) : null,
      oldestQueuedSeconds: { before: gauge(before, oldest), after: gauge(after, oldest) }
    }
  };
}
