// Run by cluster.service.test.cjs as a detached process group, including both real cluster workers.
const assert = require("node:assert/strict");
const cluster = require("node:cluster");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

require("../redis/register-typescript.cjs");
const { Controller, Get, Module } = require("@nestjs/common");
const { NestFactory, HttpAdapterHost } = require("@nestjs/core");
const { WebSocketGateway } = require("@nestjs/websockets");
const Redis = require("ioredis");
const { ClusterService } = require("./cluster.service.ts");
const { ConfigService } = require("../config/config.service.ts");
const { ErrorFilter } = require("../error.filter.ts");
const { LockService } = require("../redis/lock.service.ts");
const { LockLeaseLostError } = require("../redis/lock-lease.ts");
const { RedisService } = require("../redis/redis.service.ts");

const [directory, mode, redisPort] = process.argv.slice(2);
const slot = Number(process.env.LLMOJ_WORKER_SLOT || 0);
const report = (event, value) => fs.appendFileSync(
  path.join(directory, "events"), JSON.stringify({ pid: process.pid, slot, event, value }) + "\n"
);
const config = { server: { clusters: 2, hostname: "127.0.0.1", port: 0, trustProxy: false }, security: {} };
const tcp = mode === "tcp";

if (cluster.isPrimary) {
  cluster.on("fork", worker => report("fork", worker.process.pid));
  cluster.on("exit", (worker, code, signal) => report("worker-exit", { pid: worker.process.pid, code, signal }));
}

// The portable case holds a renewal until the lease transport is disconnected. The TCP case uses
// the production ioredis driver, its actual command timeout and a dedicated disposable Redis server.
function getClient(options) {
  if (tcp) {
    return new Redis({ ...options, host: "127.0.0.1", port: Number(redisPort), connectionName: `shutdown-${process.pid}` });
  }
  let pending;
  return Object.assign(new EventEmitter(), {
    defineCommand() {},
    async callLock(_key, action) {
      if (action === "refresh") {
        pending = Promise.withResolvers();
        report("refresh-pending");
        return await pending.promise;
      }
      return true;
    },
    disconnect() {
      pending?.reject(new Error("transport closed"));
      report("disconnected");
      this.emit("close");
    }
  });
}

class FixtureController {
  hold() {
    report("request-pending");
    return new Promise(() => {});
  }
}
Controller()(FixtureController);
Get("hold")(FixtureController.prototype, "hold", Object.getOwnPropertyDescriptor(FixtureController.prototype, "hold"));

class JudgeSocket {
  handleConnection() { report("judge-connected"); }
}
WebSocketGateway({
  namespace: "judge", path: "/api/socket", transports: ["websocket"], parser: require("socket.io-msgpack-parser")
})(JudgeSocket);

class FixtureModule {}
Module({
  controllers: [FixtureController],
  providers: [
    { provide: ConfigService, useValue: { config } },
    { provide: RedisService, useValue: { getClient } },
    { provide: ErrorFilter, useValue: { catch: error => { throw error; } } },
    ClusterService, LockService, JudgeSocket,
    {
      provide: "shutdown-probe",
      inject: [LockService, HttpAdapterHost],
      useFactory: (locks, host) => {
        const outcome = (async () => {
          // Start all leases after all processes have booted so even the first renewal can remain pending.
          while (!fs.existsSync(path.join(directory, "acquire"))) await delay(10);
          await assert.rejects(locks.lock(`shutdown-${process.pid}`, async () => {
            report("held");
            await new Promise(() => {});
          }), LockLeaseLostError);
          report("lost");
        })();
        return {
          onApplicationBootstrap() {
            if (tcp) host.httpAdapter.getHttpServer().once("listening", () =>
              report("listening", host.httpAdapter.getHttpServer().address().port));
          },
          async onApplicationShutdown() {
            await outcome;
            if ((slot === 0 || slot === 2) && mode === "stuck") {
              // A still-connected pool that never completes its shutdown hook.
              setInterval(() => {}, 30000);
              await new Promise(() => {});
            }
            // Make a worker finish later than the primary's own Nest hooks, as with asynchronous pool cleanup.
            if (slot) await delay(300);
            report("closed");
          }
        };
      }
    }
  ]
})(FixtureModule);

async function start() {
  if (tcp) {
    // Run the real bootstrap, substituting only the Nest module graph (disposable configuration, no site DB).
    const file = require.resolve("../app.module.ts");
    require.cache[file] = { id: file, filename: file, loaded: true, exports: { AppModule: FixtureModule } };
    delete process.env.LIBREOJ_MIGRATION_CONFIG_FILE;
    process.env.LIBREOJ_SCHEMA_SYNC = "1";
    require("../main.ts");
  } else {
    const app = await NestFactory.create(FixtureModule, { logger: ["error", "warn"], forceCloseConnections: true });
    app.get(ClusterService).enableShutdownHooks(app);
    await app.get(ClusterService).initialization(() => app.init());
    report("ready");
  }
}

start().catch(error => { console.error(error); process.exitCode = 1; });
