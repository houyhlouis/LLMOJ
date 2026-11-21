const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { mock, test } = require("node:test");

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function exerciseDelivery() {
  const ts = require("typescript");
  require("reflect-metadata");
  require.extensions[".ts"] = (module, filename) =>
    module._compile(
      ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2019,
          module: ts.ModuleKind.CommonJS,
          esModuleInterop: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true
        }
      }).outputText,
      filename
    );
  const { Logger } = require("@nestjs/common");
  const { Telegram, TelegramError, Telegraf } = require("telegraf");
  const { ClusterService } = require("../cluster/cluster.service.ts");
  const { requestContext } = require("../common/request-context.ts");
  const { EventReportService, EventReportType } = require("./event-report.service.ts");

  const botToken = "synthetic-delivery-token";
  const privateBody = "synthetic-private-request";
  const remoteDetail = `Remote failure using ${botToken} with ${privateBody}`;
  const config = {
    config: {
      server: { clusters: null },
      preference: { siteName: "Test judge" },
      eventReport: {
        telegramBotToken: botToken,
        telegramApiRoot: null,
        proxyUrl: null,
        sentTo: "synthetic-destination"
      }
    }
  };
  const queueLimit = 64;
  const lastDuringBackoff = 161;
  const firstKept = lastDuringBackoff - queueLimit + 1;
  const logs = [],
    previews = [],
    attachments = [],
    delivered = [];
  const backgroundContexts = new Set();
  let activeCalls = 0,
    peakCalls = 0,
    timeouts = 0;
  mock.method(Logger.prototype, "warn", (...args) => {
    backgroundContexts.add(requestContext.getStore());
    logs.push(args);
  });
  const launch = mock.method(Telegraf.prototype, "launch", async () => {
    throw new Error(remoteDetail);
  });
  mock.timers.enable({ apis: ["setTimeout"] });
  const advance = async ms => {
    mock.timers.tick(ms);
    await nextTurn();
  };

  // Replace only the external transport. The service builds the payload, registers its actual
  // cluster listener, schedules the queue, and aborts the in-flight request on its own clock.
  mock.method(Telegram.prototype, "callApi", async (method, payload, { signal }) => {
    backgroundContexts.add(requestContext.getStore());
    activeCalls++;
    peakCalls = Math.max(peakCalls, activeCalls);
    try {
      assert.equal(payload.chat_id, config.config.eventReport.sentTo);
      const body = method === "sendMessage" ? payload.text : payload.document.source.toString("utf8");
      assert.ok(!body.includes(privateBody));
      const id = Number(body.match(/"requestId": "batch-(\d+)"/)[1]);
      if (method === "sendMessage") {
        previews.push(id);
        if (id === 0)
          await new Promise((_, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                timeouts++;
                reject(new DOMException(remoteDetail, "AbortError"));
              },
              { once: true }
            );
          });
        if (id === firstKept || id === firstKept + 1)
          throw new TelegramError({ error_code: id === firstKept ? 429 : 401, description: remoteDetail });
      } else {
        assert.equal(method, "sendDocument");
        attachments.push(id);
        if (id === firstKept + 2) throw new TypeError(remoteDetail);
        delivered.push(id);
      }
    } finally {
      activeCalls--;
    }
  });
  const cluster = new ClusterService(config);
  const reporter = new EventReportService(config, cluster);
  assert.equal(launch.mock.callCount(), 0);
  const post = (id, service = reporter) => {
    const request = { requestId: `batch-${id}`, res: { writableEnded: false }, body: { password: privateBody } };
    return requestContext.run(request, async () => {
      const posted = service.report({ type: EventReportType.Error, request, error: new Error(privateBody) });
      assert.equal(requestContext.getStore(), request);
      await posted;
      assert.equal(requestContext.getStore(), request);
    });
  };
  assert.equal(previews.length, 0);
  for (let id = 0; id < lastDuringBackoff; id++) await post(id);
  assert.deepEqual(previews, [0]);
  assert.equal(reporter.queue.length, queueLimit);
  assert.ok(!JSON.stringify(reporter.queue).includes(privateBody));
  await advance(9999);
  assert.equal(timeouts, 0);
  await advance(1);
  assert.equal(timeouts, 1);
  await post(lastDuringBackoff);
  assert.equal(reporter.queue.length, queueLimit);

  // Each failure delays the next preview until its backoff expires.
  for (const delay of [1000, 2000, 4000, 8000]) {
    const attempts = previews.length;
    await advance(delay - 1);
    assert.equal(previews.length, attempts);
    await advance(1);
    assert.ok(previews.length > attempts);
  }
  const newest = lastDuringBackoff + 1;
  await post(newest);
  await nextTurn();
  const throughNewest = first => Array.from({ length: newest - first + 1 }, (_, i) => first + i);
  assert.deepEqual(previews, [0, ...throughNewest(firstKept)]);
  assert.deepEqual(attachments, throughNewest(firstKept + 2));
  assert.deepEqual(delivered, throughNewest(firstKept + 3));
  assert.equal(peakCalls, 1);
  assert.equal(activeCalls, 0);
  assert.equal(reporter.queue.length, 0);
  assert.equal(logs.filter(([line]) => line.includes("(TelegramError)")).length, 2);
  assert.ok(logs.some(([line]) => line.includes(`(TypeError) failures=4 dropped=${firstKept - 1}`)));

  // A worker can discover a closed IPC channel after report() has returned.
  const workerCluster = new ClusterService(config);
  workerCluster.isMaster = false;
  const workerReporter = new EventReportService(config, workerCluster);
  let ipcCallback;
  process.send = (_message, callback) => {
    backgroundContexts.add(requestContext.getStore());
    ipcCallback = callback;
    return false;
  };
  await post(newest + 1, workerReporter);
  assert.equal(typeof ipcCallback, "function");
  requestContext.run({ requestId: "unrelated-request" }, () =>
    ipcCallback(Object.assign(new Error(remoteDetail), { code: "ERR_IPC_CHANNEL_CLOSED" }))
  );
  assert.ok(logs.at(-1)[0].includes("failures=1 dropped=0"));
  for (const value of [botToken, privateBody, remoteDetail, "batch-"]) assert.ok(!JSON.stringify(logs).includes(value));
  const previousLogs = logs.length;
  const disabled = new EventReportService(
    { config: { eventReport: {} } },
    {
      isMaster: true,
      onMessageFromWorker: assert.fail,
      postMessageToMaster: assert.fail
    }
  );
  assert.equal(disabled.enabled, false);
  await post(newest + 2, disabled);
  assert.equal(logs.length, previousLogs);
  assert.deepEqual([...backgroundContexts], [undefined], "background delivery or logging inherited an HTTP request");
  await nextTurn();
}

if (process.argv[2] === "--exercise-delivery") {
  // A pending promise without a live socket or timer must also fail the child.
  process.exitCode = 1;
  exerciseDelivery()
    .then(() => {
      process.exitCode = 0;
    })
    .catch(error => console.error(error));
} else {
  test("a strict child survives Telegram failures and drains only the newest queued reports", () => {
    const child = spawnSync(process.execPath, ["--unhandled-rejections=strict", __filename, "--exercise-delivery"], {
      stdio: ["ignore", "ignore", "inherit"],
      timeout: 30_000
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0);
  });
}
