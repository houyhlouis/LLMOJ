import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runLoad, formatSummary } from '../benchmark/load.mjs';
import { summarizeMetrics } from '../benchmark/metrics.mjs';
import { benchmarkProblemTitle, seedManifest, seedPlan } from '../benchmark/seed.mjs';

const capacity = JSON.parse(await readFile(new URL('../benchmark/capacity.json', import.meta.url), 'utf8'));
const only = name => ({ pages: capacity.pages.filter(page => page.name === name) });
const manifest = seedManifest(seedPlan({ scale: '0.01', contests: '3' }),
  { hostname: '127.0.0.1', port: 28400 }, 'fixture-pass');
const pagination = { problemSet: 8, submissions: 5, discussionReplies: 9, discussionRepliesHead: 4 };
const fakeToken = 'fixture-bearer';
const asJson = body => Response.json(body);

// Both ends of the request use this clock. Advance to the next timer only after the previous instant's
// promises have settled, so pending slow responses don't drive or block the next scheduled page start.
function clock() {
  let time = 0;
  const events = [];
  const pause = ms => new Promise(resolve => events.push({ at: time + ms, resolve }));
  return { now: () => time, pause, stall(ms) { time += ms; }, async drain(promise) {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    while (!done) {
      await setImmediate();
      if (done) break;
      events.sort((a, b) => a.at - b.at);
      assert.ok(events.length, 'pending operation must have a scheduled event');
      time = Math.max(time, events[0].at);
      while (events.length && events[0].at <= time) events.shift().resolve();
    }
    return promise;
  } };
}

async function workload(profile, settings, handle, setup = {}) {
  const time = clock(), calls = [];
  const options = { rate: 10, seconds: 0.5, signedIn: 0, timeoutMs: 30000, ...settings };
  const fetchImpl = async (target, init) => {
    const url = new URL(target), path = url.pathname.replace(/^\/api\//, '');
    const params = init.body ? JSON.parse(init.body) : Object.fromEntries(url.searchParams);
    const member = init.headers?.Authorization === 'Bearer ' + fakeToken;
    if (path === 'problem/getProblem' && params.localizedContentsTitleOnly) {
      assert.deepEqual(params, { id: 1, localizedContentsOfLocale: 'en_US', localizedContentsTitleOnly: true });
      assert.equal(member, false);
      return asJson({ meta: { id: 1, isPublic: true }, localizedContentsOfLocale: {
        locale: 'en_US', title: setup.markerTitle ?? benchmarkProblemTitle(1)
      } });
    }
    if (path === 'proofOfWork/issueChallenge') {
      assert.deepEqual(params, { action: 'login' });
      return asJson({ id: 'test', randomData: 'fixture-random', difficulty: 1, expiresAt: Date.now() + 60000 });
    }
    if (path === 'auth/login') {
      assert.deepEqual(params, manifest.login);
      const proof = JSON.parse(init.headers['X-Proof-Of-Work']);
      assert.equal(proof.id, 'test');
      assert.equal(proof.response, createHash('sha256').update('fixture-random' + proof.nonce).digest('hex'));
      assert.match(proof.response, /^0/);
      return asJson(setup.loginResult ?? { token: fakeToken });
    }
    if (path === 'auth/getSessionInfo') return asJson({
      ...(member && { userMeta: { id: manifest.ids.firstUser, username: setup.sessionUser ?? manifest.login.username } }),
      serverVersion: { hash: 'fixture' }, serverPreference: { pagination }
    });
    if (path === 'auth/logout') {
      assert.ok(member);
      return asJson({});
    }
    const call = { path, method: init.method, member, params, at: time.now() };
    calls.push(call);
    return handle(call, time, calls);
  };
  const report = await time.drain(runLoad(options, manifest, profile, { ...time, fetchImpl }));
  return { calls, report };
}

test('absolute page arrivals overlap slow responses; dependent API calls and drain finish in order', async () => {
  const { calls, report } = await workload(only('standings'), {}, async ({ path }, time) => {
    await time.pause(path === 'contest/detail' ? 250 : 45);
    return asJson({});
  });
  assert.deepEqual(calls.filter(c => c.path === 'contest/detail').map(c => c.at), [0, 100, 200, 300, 400]);
  assert.deepEqual(calls.filter(c => c.path === 'contest/ranklist').map(c => c.at), [250, 350, 450, 550, 650]);
  assert.deepEqual(calls[0].params, { id: manifest.ids.runningContest });
  assert.deepEqual(calls.find(c => c.path === 'contest/ranklist').params, { id: manifest.ids.runningContest, page: 1, data: {} });
  assert.equal(report.arrival.startsPerSecond, 10);
  assert.equal(report.arrival.missed, 0);
  assert.equal(report.arrival.elapsedSecondsIncludingDrain, 0.695);
  assert.equal(report.pages.byName.standings.p95Ms, 295);
  assert.equal(report.requests.byName['contest/detail'].p50Ms, 250);
  assert.equal(report.requests.byName['contest/ranklist'].maxMs, 45);
  assert.equal(report.completedRequestsPerSecond, 10 / 0.695);
});

test('a stalled driver records its missed slots without a burst after the pause', async () => {
  const { calls, report } = await workload(only('home'), {}, async (_, time, allCalls) => {
    if (allCalls.length === 1) time.stall(275);
    return asJson({});
  });
  assert.deepEqual(calls.map(c => c.at), [0, 275, 300, 400]);
  assert.equal(report.arrival.started, 4);
  assert.equal(report.arrival.missed, 1);
  assert.equal(report.arrival.startLag.maxMs, 75);
  assert.equal(report.arrival.startsPerSecond, 8);
});

test('nearest-rank latency includes failed attempts; HTTP, JSON/DTO errors and timeouts count the failed pages', async () => {
  let index = 0;
  const { report, calls } = await workload(only('standings'), { seconds: 2 }, async ({ path }, time) => {
    if (path !== 'contest/detail') return asJson({});
    const i = index++;
    await time.pause(20 - i);
    switch (i) {
      case 0: return new Response('Oops', { status: 503 });
      case 1: return asJson({ error: 'NO_SUCH_CONTEST' });
      case 2: return new Response('invalid');
      case 3: throw new DOMException('timeout', 'TimeoutError');
      default: return asJson({});
    }
  });
  assert.deepEqual(report.requests.byName['contest/detail'], {
    count: 20, p50Ms: 10, p95Ms: 19, maxMs: 20, errorCount: 4,
    errors: { HTTP_503: 1, API_NO_SUCH_CONTEST: 1, INVALID_JSON: 1, TIMEOUT: 1 }
  });
  assert.equal(calls.filter(c => c.path === 'contest/ranklist').length, 16);
  assert.equal(report.pages.errorCount, 4);
  assert.equal(report.requests.errorCount, 4);
  assert.equal(report.pages.count, 20);
  assert.match(formatSummary(report), /Page errors 4/);
});

test('the capacity mix uses the owner session for private lists, preserves both quotas and varies real seed IDs', async () => {
  const respond = async ({ path, params }) => asJson(path === 'submission/getSubmissionDetail' ? {
    meta: { id: Number(params.submissionId), status: 'Accepted' }, progress: { progressType: 'Finished' }
  } : {});
  const settings = { signedIn: 0.75, seconds: 2, rate: 100 };
  const { report, calls } = await workload(capacity, settings, respond);
  assert.deepEqual((await workload(capacity, settings, respond)).calls, calls);
  assert.equal(report.actualSignedInShare, 0.75);
  assert.deepEqual(capacity.pages.map(p => [p.name, p.weight]), [
    ['running contest', 20], ['standings', 10], ['problem', 20], ['submission list', 12], ['submission', 8],
    ['problem set', 8], ['home', 6], ['other contest', 4], ['discussion', 4], ['user', 4], ['study list', 4]
  ]);
  for (const page of capacity.pages) assert.equal(report.pages.byName[page.name].count, page.weight * 2);
  const route = name => calls.filter(c => c.path === name);
  assert.ok(route('studyList/get').every(c => c.member && c.params.id >= 1 && c.params.id <= manifest.counts.studyLists));
  assert.ok(new Set(route('problem/getProblem').map(c => c.params.id)).size > 1);
  assert.ok(route('problem/getProblem').every(c => c.params.id <= manifest.counts.publicProblems && c.params.statistics));
  assert.ok(route('discussion/getDiscussionAndReplies').every(c =>
    c.params.headTakeCount === 4 && c.params.tailTakeCount === 5 && c.params.queryRepliesType === 'HeadTail'));
  assert.ok(route('submission/getSubmissionDetail').every(c => typeof c.params.submissionId === 'string'));
  assert.equal(route('hack/eligibility').length, route('submission/getSubmissionDetail').filter(c => c.member).length);
  assert.ok(route('hack/eligibility').every(c => c.member && Number.isInteger(c.params.submissionId)));
  assert.ok(route('homepage/getHomepage').every(c => c.method === 'GET' && c.params.locale === 'en_US'));
  assert.ok(route('user/getUserDetail').every(c => c.params.now === manifest.asOf + 'T00:00:00.000Z'));
  assert.ok(route('contest/detail').some(c => c.params.id > 1 && c.params.id <= manifest.counts.contests));
  assert.doesNotMatch(JSON.stringify(report) + formatSummary(report), /fixture-pass|fixture-bearer/);
});

test('the guest profile omits the owner-only page, and an impossible positive owner share fails explicitly', async () => {
  const { report } = await workload(capacity, { signedIn: 0 }, async () => asJson({}));
  assert.deepEqual(report.workload.omittedPages, [{ page: 'study list', reason: 'requires the signed-in owner' }]);
  assert.equal(report.signedInViews, 0);
  await assert.rejects(workload(capacity, { signedIn: 0.02 }, async () => asJson({})), /Owner-only pages exceed/);
});

test('both destinations require explicit opt-in for remote hosts; all workloads must prove the seeded stack', async () => {
  let visited = false;
  const visit = async () => { visited = true; return asJson({}); };
  const remoteUrl = 'https://benchmark.example.invalid/';
  const forbiddenFetch = async () => assert.fail('HTTP must not be attempted before validating both hosts');
  for (const targets of [{ url: remoteUrl }, { metricsUrl: remoteUrl }]) {
    await assert.rejects(runLoad({ ...targets, signedIn: 0 }, manifest, only('home'), { fetchImpl: forbiddenFetch }),
      /non-loopback host requires --yes-this-is-disposable/);
  }
  await assert.rejects(workload(only('home'), { url: remoteUrl, yesThisIsDisposable: true }, visit,
    { markerTitle: 'different deployment' }), /seeded problem marker missing/);
  await assert.rejects(workload(only('home'), {}, visit, { loginResult: { error: 'WRONG_PASSWORD' } }),
    /Cannot verify the seeded backend/);
  await assert.rejects(workload(only('home'), {}, visit, { sessionUser: 'someone-else' }), /does not belong/);
  assert.equal(visited, false);
  const { report, calls } = await workload(only('home'), { url: remoteUrl, yesThisIsDisposable: true }, visit);
  assert.equal(report.backendUrl, remoteUrl);
  assert.ok(calls.every(call => !call.member), 'preflight sign-in must not authenticate guest reads');
});

test('report outputs preserve the manifest and the supplied profile, including an alias of either file', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'benchmark-load-options-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifestFile = path.join(dir, 'manifest.json'), profileFile = path.join(dir, 'requests.json');
  // A missing URL prevents network access even if the output checks regress.
  const inputs = [JSON.stringify({ ...manifest, apiUrl: null }), JSON.stringify(capacity)];
  await writeFile(manifestFile, inputs[0]);
  await writeFile(profileFile, inputs[1]);
  await link(profileFile, path.join(dir, 'alias.txt'));
  const script = fileURLToPath(new URL('../benchmark/load.mjs', import.meta.url));
  for (const name of ['manifest', 'requests', 'alias']) {
    const log = path.join(dir, 'output.log'), output = await open(log, 'w');
    let result;
    try {
      result = spawnSync(process.execPath, [script, '--manifest', manifestFile, '--profile', profileFile, '--out', path.join(dir, name)],
        { stdio: ['ignore', output.fd, output.fd] });
    } finally {
      await output.close();
    }
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(await readFile(log, 'utf8'), /Output would overwrite/);
  }
  assert.equal(await readFile(manifestFile, 'utf8'), inputs[0]);
  assert.equal(await readFile(profileFile, 'utf8'), inputs[1]);
});

function metrics(after) {
  // The backend uses path labels for SQL. Queue latency is a histogram across judge task/priority types.
  return [
    '# HELP process_resident_memory_bytes Resident memory',
    'process_start_time_seconds 123',
    'process_resident_memory_bytes ' + (after ? 80 : 60),
    'libreoj_request_sql_queries_sum{api="/api/homepage/getHomepage"} ' + (after ? 15 : 5),
    'libreoj_request_sql_queries_count{api="/api/homepage/getHomepage"} ' + (after ? 7 : 2),
    'libreoj_request_sql_queries_sum{api="/api/auth/login"} ' + (after ? 99999 : 9),
    'libreoj_judge_oldest_queued_job_seconds ' + (after ? 1 : 2),
    'libreoj_judge_task_queue_time_seconds_count{type="a",priority_type="b"} ' + (after ? 30 : 10),
    'libreoj_judge_task_queue_time_seconds_sum{type="a",priority_type="b"} ' + (after ? 5 : 3),
    'libreoj_judge_task_queue_time_seconds_bucket{le="0.05",type="a",priority_type="b"} ' + (after ? 12 : 2),
    'libreoj_judge_task_queue_time_seconds_bucket{le="0.2",type="a",priority_type="b"} ' + (after ? 24 : 5),
    'libreoj_judge_task_queue_time_seconds_bucket{le="+Inf",type="a",priority_type="b"} ' + (after ? 30 : 10)
  ].join('\n');
}

test('optional before/after scrapes report query-count deltas, queue histogram and measured RSS outside workload', async () => {
  let scrapes = 0;
  const { report, calls } = await workload(only('home'), { metricsUrl: 'http://127.0.0.1:28401/metrics' },
    async ({ path }) => path === '/metrics' ? new Response(metrics(scrapes++ > 0)) : asJson({}));
  assert.deepEqual(calls.map(c => c.path), ['/metrics', ...Array(5).fill('homepage/getHomepage'), '/metrics']);
  assert.equal(report.requests.count, 5);
  assert.deepEqual(report.metrics.sql, { requests: 5, queries: 10, queriesPerRequest: 2,
    byRoute: { 'homepage/getHomepage': { requests: 5, queries: 10, queriesPerRequest: 2 } } });
  assert.deepEqual(report.metrics.processRssBytes, { before: 60, after: 80 });
  assert.deepEqual(report.metrics.judgeQueue, { waits: 20, meanWaitSeconds: 0.1, p95BucketUpperSeconds: 0.2,
    oldestQueuedSeconds: { before: 2, after: 1 } });
  assert.equal(report.metrics.cache.available, false);
  assert.throws(() => summarizeMetrics(metrics(false), metrics(true).replace('seconds 123', 'seconds 124'), []), /changed/);
  assert.throws(() => summarizeMetrics(metrics(true), metrics(false), []), /reset/);
});

test('latency results survive an unavailable metrics listener', async () => {
  const { report } = await workload(only('home'), { metricsUrl: 'http://127.0.0.1:28401/metrics' },
    async ({ path }) => path === '/metrics' ? new Response(null, { status: 403 }) : asJson({}));
  assert.equal(report.requests.count, 5);
  assert.match(report.metrics.error, /Before scrape failed: Metrics HTTP_403/);
});
