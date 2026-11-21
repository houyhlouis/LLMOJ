import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { summarizeMetrics } from "./metrics.mjs";
import { benchmarkProblemTitle } from "./seed.mjs";

const help = [
  "node deploy/benchmark/load.mjs --manifest DIR/benchmark.json [options]",
  "  --url URL          Override the backend base URL recorded in the seed manifest.",
  "  --rate NUMBER      Offered page opens per second (default 20).",
  "  --seconds NUMBER   Arrival window in seconds (default 120).",
  "  --signed-in SHARE  Fraction of page views made with the seeded owner's session (default 0.75).",
  "  --seed INTEGER     Workload RNG seed (defaults to the dataset seed).",
  "  --profile FILE     Page mix, sequential requests and weights (default capacity.json beside this script).",
  "  --metrics-url URL  Optional single backend process's Prometheus endpoint, e.g. http://127.0.0.1:28401/metrics.",
  "  --yes-this-is-disposable  Required for a non-loopback backend or metrics host.",
  "  --timeout-ms MS    Per-request timeout, including response body (default 30000).",
  "  --out PREFIX       Write PREFIX.json and PREFIX.txt (default load beside the manifest)."
].join("\n");

function httpUrl(value, base, yesThisIsDisposable) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.password || url.username || url.search || url.hash) {
    throw new Error("Expected an HTTP(S) URL with no credentials, query or fragment");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    (isIP(url.hostname) === 4 && url.hostname.startsWith("127."));
  if (!loopback && !yesThisIsDisposable) throw new Error("A non-loopback host requires --yes-this-is-disposable");
  if (base && !url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

function number(value, flag, min, max, integer = false) {
  const n = Number(value);
  if (String(value).trim() === "" || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error("Invalid " + flag);
  }
  return n;
}

function parseOptions(argv) {
  const args = parseArgs({
    args: argv,
    options: {
      manifest: { type: "string" },
      profile: { type: "string" },
      url: { type: "string" },
      rate: { type: "string", default: "20" },
      seconds: { type: "string", default: "120" },
      "signed-in": { type: "string", default: "0.75" },
      seed: { type: "string" },
      "metrics-url": { type: "string" },
      "yes-this-is-disposable": { type: "boolean" },
      "timeout-ms": { type: "string", default: "30000" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" }
    }
  }).values;
  if (args.help) return { help: true };
  if (!args.manifest) throw new Error("Pass --manifest DIR/benchmark.json from seed.mjs");
  const rate = number(args.rate, "--rate", Number.MIN_VALUE, Number.MAX_SAFE_INTEGER);
  const seconds = number(args.seconds, "--seconds", Number.MIN_VALUE, 0x7fffffff / 1000);
  if (!Number.isSafeInteger(Math.ceil(rate * seconds))) throw new Error("Too many scheduled page views");
  return {
    url: args.url,
    rate,
    seconds,
    signedIn: number(args["signed-in"], "--signed-in", 0, 1),
    seed: args.seed == null ? undefined : number(args.seed, "--seed", 0, 0xffffffff, true),
    timeoutMs: number(args["timeout-ms"], "--timeout-ms", 1, 0x7fffffff, true),
    metricsUrl: args["metrics-url"],
    yesThisIsDisposable: args["yes-this-is-disposable"] === true,
    manifest: args.manifest,
    profile: args.profile ?? new URL("./capacity.json", import.meta.url),
    out: args.out ?? path.join(path.dirname(args.manifest), "load")
  };
}

// Deterministic choices happen when a page starts, before any response arrives.
function randomGenerator(seed) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function variables({ counts, ids, asOf }, pagination, random) {
  const sample = (count, first = 1) => (count > 0 ? first + Math.floor(random() * count) : null);
  const submissionId = sample(counts.practiceSubmissions);
  const page = sample(Math.ceil(counts.publicProblems / pagination.problemSet));
  return {
    runningContest: ids.runningContest,
    endedContest: sample(counts.contests - 1, 2),
    problemId: sample(counts.publicProblems),
    submissionId,
    submissionIdString: submissionId && String(submissionId),
    userId: sample(counts.users, ids.firstUser),
    discussionId: sample(counts.discussions),
    studyListId: sample(counts.studyLists),
    longStudyList: ids.longStudyList,
    problemsPerPage: pagination.problemSet,
    problemSkipCount: ((page ?? 1) - 1) * pagination.problemSet,
    submissionsPerPage: pagination.submissions,
    discussionHead: pagination.discussionRepliesHead,
    discussionTail: pagination.discussionReplies - pagination.discussionRepliesHead,
    now: asOf + "T00:00:00.000Z"
  };
}

function bind(params, values) {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => {
      if (typeof value !== "string" || !value.startsWith("$")) return [key, value];
      const name = value.slice(1);
      if (!Object.hasOwn(values, name)) throw new Error("Unknown profile placeholder " + value);
      return [key, values[name]];
    })
  );
}

function prepareProfile(profile, manifest, pagination, signedIn) {
  const sample = variables(manifest, pagination, () => 0);
  const pages = [],
    omitted = [],
    seen = new Set();
  for (const page of profile.pages) {
    if (
      !page.name ||
      seen.has(page.name) ||
      !Number.isFinite(page.weight) ||
      page.weight <= 0 ||
      !page.requests?.length
    ) {
      throw new Error("Expected distinct named pages with positive weights and requests");
    }
    seen.add(page.name);
    let reason = page.ownerOnly && !signedIn ? "requires the signed-in owner" : null;
    for (const request of page.requests) {
      if (
        !/^[A-Za-z][A-Za-z0-9]*\/[A-Za-z][A-Za-z0-9]*$/.test(request.route) ||
        !["POST", "GET"].includes(request.method ?? "POST") ||
        ![undefined, "signedInAcceptedSubmission"].includes(request.when)
      ) {
        throw new Error("Invalid request in profile page " + page.name);
      }
      for (const [key, value] of Object.entries(bind(request.params ?? {}, sample))) {
        if (value == null) reason = "seed manifest has no " + request.params[key];
        else if (typeof value === "number" && !Number.isFinite(value))
          throw new Error("Invalid " + key + " for " + page.name);
      }
    }
    if (reason) omitted.push({ page: page.name, reason });
    else pages.push(page);
  }
  const total = pages.reduce((sum, page) => sum + page.weight, 0);
  if (!total) throw new Error("No page in the profile can be served by this dataset and sign-in share");
  const privateShare = pages.reduce((sum, page) => sum + (page.ownerOnly ? page.weight : 0), 0) / total;
  if (privateShare > signedIn) throw new Error("Owner-only pages exceed the requested --signed-in share");
  return { pages, omitted, total };
}

// Apportion a finite run by largest remainder, then sample those views without replacement. An
// owner's private views count toward the same signed-in budget as visits to public pages.
function planVisits({ pages, total }, count, signedInShare, random) {
  const signedInCount = Math.round(count * signedInShare);
  const rows = pages.map(page => {
    const quota = count * (page.weight / total);
    return { page, left: Math.floor(quota), remainder: quota % 1 };
  });
  let owners = rows.reduce((sum, row) => sum + (row.page.ownerOnly ? row.left : 0), 0);
  let unallocated = count - rows.reduce((sum, row) => sum + row.left, 0);
  for (const row of rows.toSorted((a, b) => b.remainder - a.remainder)) {
    if (!unallocated) break;
    if (row.page.ownerOnly && owners >= signedInCount) continue;
    row.left++;
    unallocated--;
    if (row.page.ownerOnly) owners++;
  }
  const plannedMix = Object.fromEntries(rows.map(({ page, left }) => [page.name, left]));
  let left = count,
    publicLeft = count - owners,
    signedInPublicLeft = signedInCount - owners;
  return {
    plannedMix,
    signedInCount,
    next() {
      const ticket = Math.floor(random() * left);
      let cumulative = 0;
      const row = rows.find(candidate => {
        cumulative += candidate.left;
        return ticket < cumulative;
      });
      left--;
      row.left--;
      if (row.page.ownerOnly) return { page: row.page, signedIn: true };
      const signedIn = random() * publicLeft < signedInPublicLeft;
      publicLeft--;
      if (signedIn) signedInPublicLeft--;
      return { page: row.page, signedIn };
    }
  };
}

function transportError(error) {
  return new Error(error.name === "TimeoutError" || error.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR");
}

function apiClient(options, fetchImpl) {
  return async (route, params, { method = "POST", token, proof } = {}) => {
    const url = new URL("api/" + route, options.url);
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    if (proof) headers["X-Proof-Of-Work"] = JSON.stringify(proof);
    if (method === "GET") url.search = new URLSearchParams(params);
    let response, text;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(params) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs),
        redirect: "error"
      });
      text = await response.text();
    } catch (error) {
      throw transportError(error);
    }
    if (!response.ok) throw new Error("HTTP_" + response.status);
    if (token && response.headers.get("X-Session-Ended")) throw new Error("SESSION_ENDED");
    if (!text && route === "auth/logout") return;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("INVALID_JSON");
    }
    if (!json || typeof json !== "object") throw new Error("INVALID_RESPONSE");
    if (json.error) throw new Error(/^[A-Z][A-Z0-9_]{0,63}$/.test(json.error) ? "API_" + json.error : "API_ERROR");
    return json;
  };
}

// Use the same challenge and password endpoints as the frontend. Sign-in is outside the measured window.
async function login(api, credentials, timeoutMs) {
  if (!credentials?.username || !credentials.password) throw new Error("Missing seed login in manifest");
  const { id, randomData, difficulty, expiresAt } = await api("proofOfWork/issueChallenge", { action: "login" });
  if (
    !id ||
    typeof randomData !== "string" ||
    !Number.isInteger(difficulty) ||
    difficulty < 1 ||
    difficulty > 8 ||
    !Number.isFinite(expiresAt)
  )
    throw new Error("Invalid login proof-of-work challenge");
  const prefix = "0".repeat(difficulty),
    deadline = Math.min(expiresAt, Date.now() + timeoutMs);
  for (let nonce = 0; Date.now() < deadline; nonce++) {
    const response = createHash("sha256")
      .update(randomData + nonce)
      .digest("hex");
    if (!response.startsWith(prefix)) continue;
    const result = await api(
      "auth/login",
      { username: credentials.username, password: credentials.password },
      {
        proof: { id, nonce, response }
      }
    );
    if (typeof result.token !== "string" || !result.token || result.token.startsWith("cookie:")) {
      throw new Error("Benchmark login did not return a bearer session");
    }
    return result.token;
  }
  throw new Error("Login proof-of-work expired or exceeded --timeout-ms");
}

function record(groups, key, ms, error) {
  if (!groups.has(key)) groups.set(key, { times: [], errors: new Map() });
  const row = groups.get(key);
  row.times.push(ms);
  if (error) row.errors.set(error, (row.errors.get(error) ?? 0) + 1);
}

function latency(times) {
  times.sort((a, b) => a - b);
  const at = p => times[Math.ceil(times.length * p) - 1] ?? null;
  return { count: times.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1) };
}

function summarize(groups) {
  const totals = [],
    byName = {};
  let errorCount = 0;
  for (const [name, { times, errors }] of groups) {
    const failed = [...errors.values()].reduce((sum, n) => sum + n, 0);
    errorCount += failed;
    for (const ms of times) totals.push(ms);
    byName[name] = { ...latency(times), errorCount: failed, errors: Object.fromEntries(errors) };
  }
  return { ...latency(totals), errorCount, byName };
}

// Absolute monotonic deadlines prevent a slow backend from reducing the offered rate. If the driver itself
// stalls for whole interarrival periods, report the missed slots instead of issuing a catch-up burst.
async function schedule(rate, seconds, visit, now, pause) {
  const start = now(),
    end = start + seconds * 1000,
    period = 1000 / rate,
    planned = Math.ceil(rate * seconds);
  const tasks = [],
    lags = [];
  let slot = 0;
  while (slot < planned) {
    const target = start + slot * period;
    const time = now();
    if (time >= end) break;
    if (time < target) {
      await pause(Math.ceil(target - time));
      continue;
    }
    slot = Math.max(slot, Math.min(planned - 1, Math.floor((time - start) / period)));
    lags.push(Math.max(0, time - (start + slot * period)));
    tasks.push(visit());
    slot++;
  }
  const remaining = end - now();
  if (remaining > 0) await pause(Math.ceil(remaining));
  await Promise.all(tasks);
  return {
    planned,
    started: tasks.length,
    missed: planned - tasks.length,
    startLag: latency(lags),
    startsPerSecond: tasks.length / seconds,
    elapsedSecondsIncludingDrain: (now() - start) / 1000
  };
}

async function scrape(url, timeoutMs, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!response.ok) throw new Error("Metrics HTTP_" + response.status);
  return response.text();
}

export async function runLoad(
  options,
  manifest,
  profile,
  { fetchImpl = fetch, now = () => performance.now(), pause = sleep } = {}
) {
  if (
    manifest.version !== 1 ||
    !manifest.counts ||
    !Number.isSafeInteger(manifest.ids?.firstUser) ||
    manifest.ids.firstUser < 1 ||
    !/^\d{4}-\d\d-\d\d$/.test(manifest.asOf)
  ) {
    throw new Error("Expected a version 1 seed manifest with counts, ids and asOf");
  }
  const baseUrl = options.url ?? manifest.apiUrl;
  if (!baseUrl) throw new Error("Seed manifest contains no API URL. Pass --url for its disposable backend.");
  options = {
    ...options,
    url: httpUrl(baseUrl, true, options.yesThisIsDisposable),
    metricsUrl: options.metricsUrl && httpUrl(options.metricsUrl, false, options.yesThisIsDisposable)
  };
  const seed = number(options.seed ?? manifest.seed, "workload seed", 0, 0xffffffff, true);
  const random = randomGenerator(seed);
  const api = apiClient(options, fetchImpl);
  // Verify a public fixture before sending credentials. Each seed issues a distinct password for the owner.
  // Also check this identity for guest-only runs; only the timed page requests follow --signed-in.
  let token;
  try {
    const marker = await api("problem/getProblem", {
      id: 1,
      localizedContentsOfLocale: "en_US",
      localizedContentsTitleOnly: true
    });
    if (
      marker.meta?.id !== 1 ||
      !marker.meta.isPublic ||
      marker.localizedContentsOfLocale?.locale !== "en_US" ||
      marker.localizedContentsOfLocale.title !== benchmarkProblemTitle(1)
    )
      throw new Error("seeded problem marker missing");
    token = await login(api, manifest.login, options.timeoutMs);
  } catch (error) {
    throw new Error(
      "Cannot verify the seeded backend for this manifest (" + error.message + "). Check --url and --manifest."
    );
  }
  let report;
  try {
    const session = await api("auth/getSessionInfo", {}, { method: "GET", token });
    if (session.userMeta?.id !== manifest.ids.firstUser || session.userMeta.username !== manifest.login.username)
      throw new Error("Session does not belong to the seeded study-list owner");
    const pagination = session.serverPreference.pagination;
    const mix = prepareProfile(profile, manifest, pagination, options.signedIn);
    const visits = planVisits(mix, Math.ceil(options.rate * options.seconds), options.signedIn, random);
    const pages = new Map(),
      routes = new Map();
    let signedInViews = 0,
      before,
      metricsError;
    if (options.metricsUrl) {
      try {
        before = await scrape(options.metricsUrl, options.timeoutMs, fetchImpl);
      } catch (error) {
        metricsError = "Before scrape failed: " + error.message;
      }
    }
    const startedAt = new Date().toISOString();
    const arrival = await schedule(
      options.rate,
      options.seconds,
      async () => {
        const { page, signedIn } = visits.next();
        if (signedIn) signedInViews++;
        const values = variables(manifest, pagination, random);
        const start = now();
        let lastResponse, failure;
        for (const request of page.requests) {
          if (
            request.when === "signedInAcceptedSubmission" &&
            !(
              signedIn &&
              lastResponse?.meta?.status === "Accepted" &&
              lastResponse.progress?.progressType === "Finished"
            )
          )
            continue;
          const since = now();
          try {
            lastResponse = await api(request.route, bind(request.params ?? {}, values), {
              method: request.method,
              token: signedIn && token
            });
          } catch (error) {
            failure = error.message;
          }
          record(routes, request.route, now() - since, failure);
          if (failure) break;
        }
        record(pages, page.name, now() - start, failure);
      },
      now,
      pause
    );
    let metrics = null;
    if (options.metricsUrl) {
      try {
        const after = await scrape(options.metricsUrl, options.timeoutMs, fetchImpl);
        if (!metricsError) metrics = summarizeMetrics(before, after, [...routes.keys()]);
      } catch (error) {
        metricsError ??= "After scrape or comparison failed: " + error.message;
      }
      if (metricsError) metrics = { error: metricsError };
    }
    const measuredPages = summarize(pages),
      requests = summarize(routes);
    report = {
      backendUrl: options.url,
      serverVersion: session.serverVersion,
      startedAt,
      dataset: { seed: manifest.seed, asOf: manifest.asOf, counts: manifest.counts },
      workload: {
        profile,
        seed,
        rate: options.rate,
        seconds: options.seconds,
        signedInShare: options.signedIn,
        timeoutMs: options.timeoutMs,
        plannedMix: visits.plannedMix,
        plannedSignedIn: visits.signedInCount,
        omittedPages: mix.omitted,
        pagination,
        metricsUrl: options.metricsUrl ?? null
      },
      arrival,
      signedInViews,
      actualSignedInShare: arrival.started ? signedInViews / arrival.started : null,
      completedPagesPerSecond: measuredPages.count / arrival.elapsedSecondsIncludingDrain,
      completedRequestsPerSecond: requests.count / arrival.elapsedSecondsIncludingDrain,
      pages: measuredPages,
      requests,
      metrics
    };
    return report;
  } finally {
    try {
      await api("auth/logout", {}, { token });
    } catch (error) {
      if (report) report.logoutError = error.message;
    }
  }
}

const fixed = n => (n == null ? "n/a" : n.toFixed(2));
export function formatSummary(report) {
  const { arrival, pages, requests, metrics } = report;
  const rows = [
    `Started ${arrival.started}/${arrival.planned} pages at ${fixed(arrival.startsPerSecond)}/s. Missed slots ${arrival.missed}. Signed-in pages ${report.signedInViews}.`,
    `Completed ${fixed(report.completedPagesPerSecond)} pages/s and ${fixed(report.completedRequestsPerSecond)} requests/s including drain. Page errors ${pages.errorCount}. API errors ${requests.errorCount}.`,
    "Page or API route | Count | Errors | p50 ms | p95 ms | max ms"
  ];
  for (const [key, row] of [
    ["All pages", pages],
    ...Object.entries(pages.byName),
    ["All API requests", requests],
    ...Object.entries(requests.byName)
  ]) {
    rows.push([key, row.count, row.errorCount, fixed(row.p50Ms), fixed(row.p95Ms), fixed(row.maxMs)].join(" | "));
  }
  if (metrics?.error) rows.push(metrics.error);
  else if (metrics) {
    const { processRssBytes, sql, judgeQueue } = metrics;
    rows.push(
      `SQL queries per recorded request ${fixed(sql.queriesPerRequest)}. Backend RSS in bytes ${processRssBytes.before} -> ${processRssBytes.after}.`,
      `Judge waits ${judgeQueue.waits}. Mean wait ${fixed(judgeQueue.meanWaitSeconds)} s. P95 bucket upper bound ${judgeQueue.p95BucketUpperSeconds ?? "n/a"} s.`,
      metrics.cache.reason
    );
  }
  for (const omitted of report.workload.omittedPages)
    rows.push("Omitted " + omitted.page + " (" + omitted.reason + ").");
  if (report.logoutError) rows.push("Benchmark session logout failed (" + report.logoutError + ").");
  return rows.join("\n") + "\n";
}

async function readJson(file, label) {
  const content = await readFile(file, "utf8");
  try {
    return JSON.parse(content);
  } catch {
    throw new Error("Invalid JSON in " + label);
  }
}

function ensureReportDestination(existing, inputs) {
  if (existing && inputs.some(input => input.dev === existing.dev && input.ino === existing.ino))
    throw new Error("Output would overwrite the seed manifest or workload profile. Choose another --out prefix.");
}

async function writeReportFile(pathname, content, inputs) {
  // Recheck the open file before truncating: its name could have been relinked during the run.
  const file = await open(pathname, "a");
  try {
    ensureReportDestination(await file.stat(), inputs);
    await file.truncate(0);
    await file.writeFile(content);
  } finally {
    await file.close();
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) return console.log(help);
  const manifest = await readJson(options.manifest, "seed manifest");
  const profile = await readJson(options.profile, "workload profile");
  const inputs = await Promise.all([stat(options.manifest), stat(options.profile)]);
  for (const file of [options.out + ".json", options.out + ".txt"]) {
    const existing = await stat(file).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    ensureReportDestination(existing, inputs);
  }
  const report = await runLoad(options, manifest, profile);
  const summary = formatSummary(report);
  await writeReportFile(options.out + ".json", JSON.stringify(report, null, 2) + "\n", inputs);
  await writeReportFile(options.out + ".txt", summary, inputs);
  process.stdout.write(summary);
  if (report.pages.errorCount || report.metrics?.error || report.arrival.missed || report.logoutError)
    process.exitCode = 1;
}

if (import.meta.main)
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
