// Disposable contributor services on Linux. Run "node deploy/dev/stack.mjs --help".
import fs from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  bootstrapAdmin,
  fileCredentialStore,
  generatePassword,
  readPermissionDefinitions
} from "../bootstrap-admin.mjs";
import { databaseOptions, ensureStorageBucket, minioOptions } from "../bootstrap-services.mjs";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const backend = path.join(root, "apps/backend");
const frontend = path.join(root, "packages/frontend");
const require = createRequire(path.join(backend, "package.json"));
const host = "127.0.0.1";
const serviceNames = ["mariadb", "redis", "minio"];
const defaultBase = 28400;
const usage = `node deploy/dev/stack.mjs start|stop|reset|frontend|seed [--dir DIR] [--base-port N]
start creates or restarts the three private services. Build the protocol and backend first.
stop keeps the data. reset stops the services and removes the marked stack directory.
seed installs the optional contributor fixture in this stack. Use a separate fresh stack for capacity benchmarks.
frontend runs the Vite development server in the foreground. Stop the frontend and backend with Ctrl-C.
DIR defaults to .dev-stack in the checkout. On Ubuntu use --dir /var/tmp/llmoj-dev-$(id -u) if AppArmor restricts MariaDB.
--base-port (start only) defaults to 28400. The seven consecutive ports are backend, metrics, frontend, MariaDB, Redis, MinIO API and console.
Set LLMOJ_MINIO_BINARY to the absolute path of minio or provide runtime/minio in the checkout.`;

class StackError extends Error {}
const fail = message => {
  throw new StackError(message);
};

export function portsFor(base) {
  if (!Number.isSafeInteger(base) || base < 1024 || base > 65529) fail("Choose a base port between 1024 and 65529.");
  return {
    backend: base,
    metrics: base + 1,
    frontend: base + 2,
    mariadb: base + 3,
    redis: base + 4,
    minio: base + 5,
    console: base + 6
  };
}

export function parseOptions(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { dir: { type: "string" }, "base-port": { type: "string" } },
    allowPositionals: true
  });
  const [command] = positionals;
  if (positionals.length !== 1 || !["start", "stop", "reset", "frontend", "seed"].includes(command)) fail(usage);
  let base;
  if (values["base-port"] !== undefined) {
    if (command !== "start" || !/^\d+$/.test(values["base-port"])) fail(usage);
    base = Number(values["base-port"]);
    portsFor(base);
  }
  if (values.dir === "") fail(usage);
  return { command, dir: path.resolve(values.dir ?? path.join(root, ".dev-stack")), base };
}

export function newSecrets() {
  return Object.fromEntries(
    ["database", "redis", "access", "minio", "session", "maintenance"].map(key => [
      key,
      randomBytes(key === "access" ? 8 : 32).toString("hex")
    ])
  );
}

export function backendConfig(ports, secrets) {
  const config = require("js-yaml").load(fs.readFileSync(path.join(backend, "config-example.yaml"), "utf8"));
  config.server = { ...config.server, hostname: host, port: ports.backend, clusters: null };
  config.metrics = { hostname: host, basePort: ports.metrics, allowedIps: [host] };
  config.services.database = {
    type: "mariadb",
    host,
    port: ports.mariadb,
    username: "llmoj_dev",
    password: secrets.database,
    database: "llmoj_dev"
  };
  config.services.redis = `redis://:${secrets.redis}@${host}:${ports.redis}/0`;
  Object.assign(config.services.minio, {
    default: { endpoint: `http://${host}:${ports.minio}`, urlEndpoint: null },
    forJudge: null,
    forUserDownload: null,
    forUserUpload: null,
    accessKey: secrets.access,
    secretKey: secrets.minio,
    bucket: "llmoj-dev-files"
  });
  config.services.mail = { address: null, transport: { jsonTransport: true } };
  Object.assign(config.security, {
    crossOrigin: { enabled: false, whiteList: [] },
    sessionSecret: secrets.session,
    maintainceKey: secrets.maintenance,
    captcha: { turnstile: null, tencentCaptcha: null }
  });
  config.preference.security.requireEmailVerification = false;
  return config;
}

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function backendEnvironment(dir) {
  const vars = {
    TMPDIR: path.join(dir, "tmp"),
    LIBREOJ_CONFIG_FILE: path.join(dir, "backend.yaml"),
    LIBREOJ_SCHEMA_SYNC: "0",
    HYHOJ_AI_STATE_DIR: path.join(dir, "ai"),
    HYHOJ_AI_GENERATED_DIR: path.join(dir, "ai-generated"),
    HYHOJ_AI_SAMPLE_INPUTS_DIR: path.join(dir, "ai-sample-inputs"),
    HYHOJ_AI_RUNNER_SOCKET: path.join(dir, "ai-runner.sock"),
    HYHOJ_ARCHIVE_WORK_DIRECTORY: path.join(dir, "backend-archives"),
    HYHOJ_PUBLIC_DIR: path.join(dir, "public")
  };
  return [
    "unset LIBREOJ_MIGRATION_CONFIG_FILE",
    ...Object.entries(vars).map(([name, value]) => `export ${name}=${quote(value)}`),
    ""
  ].join("\n");
}

export function viteOptions(dir, ports) {
  const cacheDir = path.join(dir, "vite-cache");
  return {
    root: frontend,
    configFile: path.join(frontend, "vite.config.ts"),
    configLoader: "native",
    cacheDir,
    server: {
      host,
      port: ports.frontend,
      strictPort: true,
      proxy: { "/api": { target: `http://${host}:${ports.backend}`, ws: true } },
      fs: { allow: [frontend, path.join(root, "node_modules"), cacheDir] }
    }
  };
}

export async function checkPorts(ports, makeServer = () => net.createServer()) {
  for (const [name, port] of Object.entries(ports)) {
    const server = makeServer();
    try {
      const listening = once(server, "listening");
      server.listen({ host, port, exclusive: true });
      await listening;
    } catch (error) {
      fail(
        `Cannot bind ${name} port ${host}:${port} (${error.code ?? "bind failed"}). Choose another --base-port for a fresh directory.`
      );
    }
    await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
}

function privateWrite(file, contents) {
  const temp = file + ".tmp-" + randomUUID();
  fs.writeFileSync(temp, contents, { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
}

function privateText(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077)
      fail(`Expected a private, owner-only file at ${file}.`);
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function privateRead(file) {
  return JSON.parse(privateText(file));
}

export function loadBackendConfig(dir, expected) {
  const file = path.join(dir, "backend.yaml");
  const yaml = require("js-yaml");
  let saved;
  try {
    saved = yaml.load(privateText(file));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    privateWrite(file, yaml.dump(expected));
    return expected;
  }
  for (const key of ["services", "server", "metrics"]) {
    if (!isDeepStrictEqual(saved?.[key], expected[key]))
      fail(`The ${key} settings in backend.yaml must match this private stack.`);
  }
  return saved;
}

function ownedDirectory(dir, create) {
  if (fs.realpathSync(path.dirname(dir)) !== path.dirname(dir)) fail("Choose a stack path without symlink components.");
  if (create) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077 || fs.realpathSync(dir) !== dir) {
    fail(`Use a private directory owned by your user (0700) without symlinks: ${dir}`);
  }
}

// flock on the directory FD releases automatically when the command exits, including after a crash.
function lockDirectory(dir) {
  const fd = fs.openSync(dir, fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const lock = spawnSync("flock", ["-n", "-E", "75", "3"], { stdio: ["ignore", "ignore", "ignore", fd] });
    if (lock.status !== 0)
      fail(lock.status === 75 ? "Another stack command is running." : "The Linux flock utility is required.");
    if (fs.fstatSync(fd).ino !== fs.statSync(dir).ino) fail("The stack directory changed. Retry your command.");
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function openState(dir, create, base) {
  const file = path.join(dir, "llmoj-dev.json");
  let state;
  try {
    state = privateRead(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!create || fs.readdirSync(dir).length)
      fail("Expected an empty directory for a new stack or an existing LLMOJ dev stack marker.");
    state = { format: "llmoj-dev-1", dir, id: randomUUID(), base: base ?? defaultBase, secrets: newSecrets() };
    privateWrite(file, JSON.stringify(state) + "\n");
  }
  if (
    state?.format !== "llmoj-dev-1" ||
    state.dir !== dir ||
    !/^[0-9a-f-]{36}$/.test(state.id) ||
    !["database", "redis", "access", "minio", "session", "maintenance"].every(k =>
      /^[a-f0-9]{16,64}$/.test(state.secrets?.[k])
    )
  ) {
    fail("Invalid stack marker or moved stack directory.");
  }
  portsFor(state.base);
  if (base !== undefined && state.base !== base)
    fail("The existing stack has a different base port. Use its saved ports or reset it.");
  return state;
}

// A Linux pidfd pins the process across the identity check and signal. Python exposes this API.
const processControl = `
import os, select, signal, sys
mode, pid = sys.argv[1], int(sys.argv[2])
try:
    fd = os.pidfd_open(pid)
    with open(f"/proc/{pid}/stat") as f:
        fields = f.read().rsplit(") ", 1)[1].split()
    with open("/proc/sys/kernel/random/boot_id") as f:
        stamp = f.read().strip() + ":" + fields[19]
    if fields[0] == "Z" or (len(sys.argv) > 3 and sys.argv[3] != stamp):
        sys.exit(3)
    if mode == "stop":
        signal.pidfd_send_signal(fd, signal.SIGTERM)
        poll = select.poll()
        poll.register(fd, select.POLLIN)
        if not poll.poll(30000):
            sys.exit(4)
    else:
        print(stamp)
except (FileNotFoundError, ProcessLookupError):
    sys.exit(3)
`;

function processAction(mode, pid, stamp) {
  if (!Number.isSafeInteger(pid) || pid < 2) fail("Invalid service PID.");
  const run = spawnSync("python3", ["-c", processControl, mode, String(pid), ...(stamp ? [stamp] : [])], {
    encoding: "utf8"
  });
  if (run.status === 3) return null;
  if (run.status === 4) fail(`PID ${pid} is still stopping. Retry stop before reset.`);
  if (run.status !== 0) fail("Service PID verification requires Linux /proc and Python 3.9+ with pidfd support.");
  return mode === "stop" ? true : run.stdout.trim();
}

function pidFile(dir, name) {
  return path.join(dir, name + ".pid");
}

function recordFor(state, name) {
  try {
    const record = privateRead(pidFile(state.dir, name));
    if (
      record.stack !== state.id ||
      record.name !== name ||
      !Number.isSafeInteger(record.pid) ||
      record.pid < 2 ||
      !/^[a-f0-9-]{36}:\d+$/.test(record.stamp)
    )
      fail(`Invalid ${name} PID record. Inspect ${state.dir} before continuing.`);
    return record;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function stopServices(state) {
  for (const name of [...serviceNames].reverse()) {
    const record = recordFor(state, name);
    if (record) {
      processAction("stop", record.pid, record.stamp);
      fs.unlinkSync(pidFile(state.dir, name));
    }
  }
}

function logFd(dir, name) {
  return fs.openSync(
    path.join(dir, name + ".log"),
    fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o600
  );
}

export async function launchService(state, name, binary, args, env) {
  const fd = logFd(state.dir, name);
  let child;
  try {
    // If the CLI dies between spawn and publishing the PID record, EOF aborts the launch.
    child = spawn("sh", ["-c", 'read -r ready && exec "$@"', "llmoj-dev", binary, ...args], {
      cwd: state.dir,
      env,
      detached: true,
      stdio: ["pipe", fd, fd]
    });
    await once(child, "spawn");
    const stamp = processAction("check", child.pid);
    if (!stamp) fail(`Could not start ${name}.`);
    privateWrite(pidFile(state.dir, name), JSON.stringify({ stack: state.id, name, pid: child.pid, stamp }) + "\n");
    child.stdin.on("error", () => {});
    child.stdin.end("ready\n");
    child.unref();
    return child;
  } catch (error) {
    child?.stdin?.destroy();
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function runLogged(program, args, dir, name, env, lockFd) {
  const fd = logFd(dir, name);
  try {
    const result = spawnSync(program, args, { cwd: dir, env, stdio: ["ignore", fd, fd, lockFd], timeout: 180000 });
    if (result.status !== 0)
      fail(
        `${name} failed (${result.error?.code ?? result.signal ?? result.status}). See ${path.join(dir, name + ".log")}.`
      );
  } finally {
    fs.closeSync(fd);
  }
}

const appArmorTip = "On Ubuntu, AppArmor may require --dir /var/tmp/llmoj-dev-$(id -u).";
function initializeMaria(dir, username, env, lockFd) {
  const data = path.join(dir, "mariadb");
  if (!fs.existsSync(data)) {
    // Publish complete system tables only. A failed bootstrap can leave mysql/ populated.
    const staging = fs.mkdtempSync(path.join(dir, "install-"));
    try {
      runLogged(
        "mariadb-install-db",
        [
          "--no-defaults",
          "--datadir=" + staging,
          "--auth-root-authentication-method=socket",
          "--auth-root-socket-user=" + username,
          "--skip-test-db",
          "--force"
        ],
        dir,
        "mariadb-install",
        env,
        lockFd
      );
    } catch (error) {
      fail(`${error.message} ${appArmorTip}`);
    }
    fs.renameSync(staging, data);
  }
  ownedDirectory(data, false);
}

async function waitFor(name, child, dir, check) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      if (await check()) return;
    } catch {
      /* Service may still be starting. */
    }
    await delay(200);
  }
  fail(
    `${name} failed to become ready. See ${path.join(dir, name + ".log")}.${name === "mariadb" ? " " + appArmorTip : ""}`
  );
}

function checkBinaries(minio) {
  for (const bin of ["mariadb-install-db", "mariadbd", "redis-server", minio]) {
    const candidates = path.isAbsolute(bin)
      ? [bin]
      : process.env.PATH.split(path.delimiter).map(dir => path.join(dir, bin));
    if (
      !candidates.some(file => {
        try {
          fs.accessSync(file, fs.constants.X_OK);
          return fs.statSync(file).isFile();
        } catch {
          return false;
        }
      })
    ) {
      fail(
        bin === minio
          ? "Set LLMOJ_MINIO_BINARY to a runnable MinIO binary or provide runtime/minio."
          : `Missing required program on PATH: ${bin}`
      );
    }
  }
}

async function start(state, lockFd) {
  const { dir } = state;
  for (const name of serviceNames) {
    const record = recordFor(state, name);
    if (record && processAction("check", record.pid, record.stamp))
      fail(`${name} is already running. Stop the stack before starting it again.`);
  }
  const ports = portsFor(state.base);
  const minio = path.resolve(process.env.LLMOJ_MINIO_BINARY || path.join(root, "runtime/minio"));
  checkBinaries(minio);
  if (!fs.existsSync(path.join(backend, "dist/main.js")))
    fail("Build @libreoj/judge-protocol and apps/backend (nest build) before starting the stack.");
  const socketPath = path.join(dir, "mysql.sock");
  if (Buffer.byteLength(socketPath) >= 104) fail("Choose a shorter --dir for the MariaDB Unix socket.");
  processAction("check", process.pid);
  await checkPorts(ports);
  const config = loadBackendConfig(dir, backendConfig(ports, state.secrets));
  const configFile = path.join(dir, "backend.yaml");
  privateWrite(path.join(dir, "backend.env"), backendEnvironment(dir));
  privateWrite(path.join(dir, "redis.conf"), "requirepass " + state.secrets.redis + "\n");
  for (const name of ["tmp", "redis", "minio", "certs"]) ownedDirectory(path.join(dir, name), true);
  // A service looking up its home (e.g. MinIO for certificates) must use this stack.
  const env = { PATH: process.env.PATH, TMPDIR: path.join(dir, "tmp"), HOME: dir, LANG: "C.UTF-8" };
  const username = os.userInfo().username;
  initializeMaria(dir, username, env, lockFd);
  const mariadb = require("mariadb");
  try {
    const db = await launchService(
      state,
      "mariadb",
      "mariadbd",
      [
        "--no-defaults",
        "--datadir=" + path.join(dir, "mariadb"),
        "--socket=" + socketPath,
        "--pid-file=" + path.join(dir, "mysql-server.pid"),
        "--tmpdir=" + env.TMPDIR,
        "--bind-address=" + host,
        "--port=" + ports.mariadb,
        "--skip-name-resolve",
        "--character-set-server=utf8mb4",
        "--collation-server=utf8mb4_unicode_ci"
      ],
      env
    );
    let owner;
    await waitFor("mariadb", db, dir, async () => {
      owner = await mariadb.createConnection({ socketPath, user: username, connectTimeout: 1000 });
      return true;
    });
    try {
      await owner.query("CREATE DATABASE IF NOT EXISTS `llmoj_dev` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
      await owner.query("CREATE USER IF NOT EXISTS 'llmoj_dev'@'127.0.0.1' IDENTIFIED BY ?", [state.secrets.database]);
      await owner.query("GRANT ALL ON `llmoj\\_dev`.* TO 'llmoj_dev'@'127.0.0.1'");
    } finally {
      await owner.end();
    }

    const redis = await launchService(
      state,
      "redis",
      "redis-server",
      [
        path.join(dir, "redis.conf"),
        "--bind",
        host,
        "--port",
        String(ports.redis),
        "--dir",
        path.join(dir, "redis"),
        "--pidfile",
        path.join(dir, "redis-server.pid"),
        "--save",
        "",
        "--appendonly",
        "no",
        "--daemonize",
        "no"
      ],
      env
    );
    await waitFor("redis", redis, dir, async () => {
      const client = new (require("ioredis"))(config.services.redis, {
        lazyConnect: true,
        connectTimeout: 1000,
        retryStrategy: () => null
      });
      client.on("error", () => {});
      try {
        await client.connect();
        return (await client.ping()) === "PONG";
      } finally {
        client.disconnect();
      }
    });
    const storage = await launchService(
      state,
      "minio",
      minio,
      [
        "server",
        "--certs-dir",
        path.join(dir, "certs"),
        "--address",
        host + ":" + ports.minio,
        "--console-address",
        host + ":" + ports.console,
        path.join(dir, "minio")
      ],
      {
        ...env,
        MINIO_ROOT_USER: state.secrets.access,
        MINIO_ROOT_PASSWORD: state.secrets.minio,
        MINIO_CONFIG_DIR: dir,
        MINIO_UPDATE: "off",
        MINIO_CALLHOME_ENABLE: "off"
      }
    );
    await waitFor("minio", storage, dir, async () => {
      const response = await fetch(config.services.minio.default.endpoint + "/minio/health/ready", {
        redirect: "error",
        signal: AbortSignal.timeout(1000)
      });
      await response.body?.cancel();
      return response.ok;
    });
    await ensureStorageBucket(
      new (require("minio").Client)(minioOptions(config.services.minio)),
      config.services.minio.bucket
    );
    if (!fs.existsSync(path.join(dir, "schema-ready"))) {
      runLogged(
        process.execPath,
        [path.join(root, "deploy/initialize-schema.mjs"), "--root", root, "--config", configFile],
        dir,
        "schema",
        env,
        lockFd
      );
      privateWrite(path.join(dir, "schema-ready"), "initialized\n");
    }
    const connection = await mariadb.createConnection(databaseOptions(config.services.database));
    try {
      await bootstrapAdmin({
        connection,
        bcrypt: require("bcrypt"),
        ...(await readPermissionDefinitions(root)),
        credentialStore: fileCredentialStore(path.join(dir, "admin-credentials.json"))
      });
    } finally {
      await connection.end();
    }
  } catch (error) {
    stopServices(state);
    throw error;
  }

  const command = name => `node ${quote(script)} ${name} --dir ${quote(dir)}`;
  console.log(`Backend http://${host}:${ports.backend} (OpenAPI at /docs)
Metrics http://${host}:${ports.metrics}/metrics
Frontend http://${host}:${ports.frontend}
MinIO http://${host}:${ports.minio}, console http://${host}:${ports.console}
Administrator login details are in ${path.join(dir, "admin-credentials.json")}.

Start the backend and frontend in separate terminals.
  (cd ${quote(backend)} && . ${quote(path.join(dir, "backend.env"))} && node dist/main)
  ${command("frontend")}

After closing both terminals, stop the services or remove this stack.
  ${command("stop")}
  ${command("reset")}`);
}

export const contributorExample = {
  title: "Double an integer",
  sections: [
    { type: "Text", sectionTitle: "Task", text: "Read one integer and print twice its value." },
    { type: "Sample", sectionTitle: "Example", sampleId: 0 }
  ],
  samples: [{ inputData: "4\n", outputData: "8\n" }],
  files: { "1.in": "0\n", "1.out": "0\n", "2.in": "-13\n", "2.out": "-26\n" },
  content: {
    language: "cpp",
    compileAndRunOptions: { compiler: "g++", std: "c++17", O: "2", m: "64" },
    code: "#include <iostream>\nint main() { int n; std::cin >> n; std::cout << 2 * n << '\\n'; }\n"
  }
};

async function seedContributor(state) {
  const { dir } = state;
  for (const name of serviceNames) {
    const record = recordFor(state, name);
    if (!record || !processAction("check", record.pid, record.stamp)) fail("Start this stack before seeding it.");
  }
  const config = backendConfig(portsFor(state.base), state.secrets);
  require("reflect-metadata");
  const { DataSource } = require("typeorm");
  const ds = new DataSource({
    ...config.services.database,
    entities: [path.join(backend, "dist/**/*.entity.js")],
    synchronize: false,
    migrationsRun: false,
    logging: false
  });
  const { FileService } = require("./dist/file/file.service.js");
  const { createRegisteredUser } = require("./dist/auth/create-registered-user.js");
  const { dataVersionDigest } = require("./dist/problem/problem-data-version.service.js");
  const { ProblemTypeTraditionalService } = require("./dist/problem-type/types/traditional/problem-type.service.js");
  const { StatisticsOutboxService } = require("./dist/submission/statistics-outbox.service.js");
  const fileService = new FileService(ds.getRepository("file"), { config });
  const traditional = new ProblemTypeTraditionalService({ config });
  const counts = new StatisticsOutboxService(ds);
  const example = contributorExample;
  const username = "dev_student";
  const credentials = path.join(dir, "student-credentials.json");
  const now = new Date();
  await ds.initialize();
  try {
    if (await ds.manager.existsBy("user", { username }))
      fail("The contributor fixture username already exists. Use its existing fixture or a fresh stack.");
    const password = generatePassword();
    const hash = await require("bcrypt").hash(password, 10);
    const { problemId, submissionId, changes } = await ds.transaction(async manager => {
      const user = await createRegisteredUser(manager, username, "student@localhost.invalid", hash, false);
      const problem = await manager.save("problem", {
        type: "Traditional",
        ownerId: user.id,
        isPublic: true,
        locales: ["en_US"],
        publicTime: now,
        submissionCount: 0,
        acceptedSubmissionCount: 0
      });
      // Use the editor's default traditional format. The backend pairs the two .in/.out files in the pinned version.
      const judgeInfo = traditional.getDefaultJudgeInfo();
      await manager.insert("problem_judge_info", { problemId: problem.id, judgeInfo });
      await manager.insert("problem_sample", { problemId: problem.id, data: example.samples });
      await manager.insert("localized_content", [
        { objectId: problem.id, type: "ProblemTitle", locale: "en_US", data: example.title },
        { objectId: problem.id, type: "ProblemContent", locale: "en_US", data: JSON.stringify(example.sections) }
      ]);
      const testData = [];
      for (const [filename, text] of Object.entries(example.files)) {
        // A failed transaction can leave an object: a retry uses the same UUID for the same bytes.
        const uuid = require("uuid").v5(filename, state.id);
        const bytes = Buffer.from(text);
        if (await manager.existsBy("file", { uuid })) fail("A contributor test data file already exists.");
        const sha256 = await fileService.uploadFile(uuid, bytes, 1);
        await manager.insert("file", { uuid, size: bytes.length, uploadTime: now, sha256 });
        await manager.insert("problem_file", { problemId: problem.id, type: "TestData", filename, uuid });
        testData.push({ filename, uuid, sha256 });
      }
      const version = {
        problemType: "Traditional",
        judgeInfo: traditional.preprocessJudgeInfo(judgeInfo, testData),
        samples: example.samples,
        testData
      };
      const versionRow = await manager.save("problem_data_version", {
        ...version,
        problemId: problem.id,
        digest: dataVersionDigest(version),
        version: 1,
        createdAt: now
      });
      // A completed, canceled submission makes a rejudgeable example without impersonating a judge.
      const submission = await manager.save("submission", {
        isPublic: true,
        submitterId: user.id,
        problemId: problem.id,
        problemDataVersionId: versionRow.id,
        codeLanguage: example.content.language,
        answerSize: Buffer.byteLength(example.content.code),
        submitTime: now,
        score: 0,
        status: "Canceled",
        totalOccupiedTime: 0
      });
      await manager.insert("submission_detail", {
        submissionId: submission.id,
        content: example.content,
        result: {
          progressType: "Finished",
          status: "Canceled",
          score: 0,
          totalOccupiedTime: 0,
          systemMessage: "Dev fixture. Rejudge after connecting a judge."
        }
      });
      const changes = await counts.record(manager, null, submission);
      privateWrite(credentials, JSON.stringify({ username, password }, null, 2) + "\n");
      return { problemId: problem.id, submissionId: submission.id, changes };
    });
    await counts.apply(changes);
    console.log(
      `Created public problem ${problemId} and canceled submission ${submissionId}. Student login details are in ${credentials}.`
    );
  } finally {
    await ds.destroy();
  }
}

export async function run({ command, dir, base }) {
  if (process.platform !== "linux" || process.getuid() === 0) fail("Run the dev stack on Linux as your ordinary user.");
  // Vite serves these directories, including public/. Place private database files outside them.
  for (const served of [frontend, path.join(root, "node_modules")]) {
    if (dir === served || dir.startsWith(served + path.sep))
      fail("Choose a stack directory outside frontend and node_modules.");
  }
  process.umask(0o077);
  try {
    ownedDirectory(dir, command === "start");
  } catch (error) {
    if ((command === "stop" || command === "reset") && error.code === "ENOENT") return;
    throw error;
  }
  const fd = lockDirectory(dir);
  let state;
  try {
    state = openState(dir, command === "start", base);
    if (command === "start") return await start(state, fd);
    if (command === "seed") return await seedContributor(state);
    if (command !== "frontend") {
      stopServices(state);
      if (command === "reset") fs.rmSync(dir, { recursive: true });
      return;
    }
  } finally {
    fs.closeSync(fd);
  }
  process.chdir(frontend);
  const vite = createRequire(path.join(frontend, "package.json"))("vite");
  const server = await vite.createServer(viteOptions(dir, portsFor(state.base)));
  await server.listen();
  server.printUrls();
}

if (import.meta.main) {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--help") console.log(usage);
    else await run(parseOptions(process.argv.slice(2)));
  } catch (error) {
    // SQL/SDK errors may include parameters or credentials.
    const detail =
      error instanceof StackError || error.code?.startsWith("ERR_PARSE_ARGS")
        ? error.message
        : `Dev stack operation failed (${error.code || "check the service and schema logs in the stack directory"}).`;
    console.error(detail);
    process.exitCode = 1;
  }
}
