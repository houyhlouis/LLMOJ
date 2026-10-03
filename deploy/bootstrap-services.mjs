#!/usr/bin/env node
// Local installer helper: create private storage, register the judge, or verify its session.
import { createHash, timingSafeEqual } from "node:crypto";
import { promises as fs, constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class ServiceBootstrapError extends Error {}

const LOCAL_JUDGE_NAME = "local-systemd";
const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
const LOOPBACK_NAMES = new Set([...LOOPBACK_HOSTS, "localhost", "[::1]"]);

function requireString(value, description) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ServiceBootstrapError(`Invalid ${description} configuration.`);
  }
  return value;
}

function requireLoopback(host, description) {
  if (!LOOPBACK_NAMES.has(host)) {
    throw new ServiceBootstrapError(`${description} must use a local loopback endpoint for this installer.`);
  }
}

function requirePort(port, description) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ServiceBootstrapError(`Invalid ${description} port configuration.`);
  }
  return port;
}

export function minioOptions(config) {
  let endpoint;
  try { endpoint = new URL(requireString(config?.default?.endpoint, "MinIO endpoint")); }
  catch { throw new ServiceBootstrapError("Invalid MinIO endpoint configuration."); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.pathname !== "/" ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new ServiceBootstrapError("MinIO requires an HTTP(S) origin without credentials, a path, or query parameters.");
  }
  requireLoopback(endpoint.hostname, "MinIO");
  const useSSL = endpoint.protocol === "https:";
  return {
    endPoint: endpoint.hostname.replace(/^\[|\]$/g, ""),
    port: requirePort(endpoint.port ? Number(endpoint.port) : useSSL ? 443 : 80, "MinIO"),
    useSSL,
    accessKey: requireString(config?.accessKey, "MinIO access key"),
    secretKey: requireString(config?.secretKey, "MinIO secret key"),
    region: "us-east-1"
  };
}

export function databaseOptions(config) {
  requireLoopback(requireString(config?.host, "database host"), "Database");
  return {
    host: config.host,
    port: requirePort(config.port, "database"),
    user: requireString(config.username, "database username"),
    password: requireString(config.password, "database password"),
    database: requireString(config.database, "database name"),
    connectTimeout: 5000,
    socketTimeout: 10000,
    multipleStatements: false
  };
}

export function validateJudgeKey(judge, secrets) {
  const key = requireString(judge?.key, "judge key");
  const secret = requireString(secrets?.judge, "instance judge key");
  const decoded = Buffer.from(key, "base64");
  if (key.length !== 40 || decoded.length !== 30 || decoded.toString("base64") !== key ||
      Buffer.byteLength(secret) !== Buffer.byteLength(key) || !timingSafeEqual(Buffer.from(key), Buffer.from(secret))) {
    throw new ServiceBootstrapError("The judge configuration and private instance key do not match; no client was modified.");
  }
  return key;
}

export async function ensureStorageBucket(client, bucket) {
  requireString(bucket, "MinIO bucket");
  if (!(await client.bucketExists(bucket))) {
    try { await client.makeBucket(bucket, "us-east-1"); }
    catch (error) {
      // Another installer may have created the same bucket after our existence check.
      // BucketAlreadyExists alone is insufficient: it could belong to another account.
      if (error?.code !== "BucketAlreadyOwnedByYou" || !(await client.bucketExists(bucket))) throw error;
    }
  }
}

function positiveId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ServiceBootstrapError("The database returned an invalid judge client ID.");
  }
  return id;
}

export async function registerJudge(connection, key) {
  const [database] = await connection.query("SELECT DATABASE() AS name");
  const lockName = `libreoj-judge-${createHash("sha256").update(database.name).digest("hex").slice(0, 40)}`;
  const [lock] = await connection.query("SELECT GET_LOCK(?, 10) AS acquired", [lockName]);
  if (Number(lock.acquired) !== 1) {
    throw new ServiceBootstrapError("Another judge initialization is in progress.");
  }
  let transaction = false;
  try {
    await connection.beginTransaction();
    transaction = true;
    const namedClients = await connection.query(
      "SELECT id, `key` FROM judge_client WHERE name = ? FOR UPDATE", [LOCAL_JUDGE_NAME]
    );
    if (namedClients.some(client => client.key !== key)) {
      throw new ServiceBootstrapError("The local-systemd judge name already belongs to another key; its credentials were not replaced.");
    }
    const existing = await connection.query("SELECT id FROM judge_client WHERE `key` = ? FOR UPDATE", [key]);
    let id;
    let created = false;
    if (existing.length) {
      id = positiveId(existing[0].id);
    } else {
      const insert = await connection.query(
        "INSERT INTO judge_client (name, `key`, allowedHosts) VALUES (?, ?, ?)",
        [LOCAL_JUDGE_NAME, key, JSON.stringify(LOOPBACK_HOSTS)]
      );
      id = positiveId(insert.insertId);
      created = true;
    }
    await connection.commit();
    transaction = false;
    return { id, created };
  } catch (error) {
    if (transaction) await connection.rollback().catch(() => {});
    throw error;
  } finally {
    await connection.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => {});
  }
}

export async function verifyJudgeSession(connection, redis, key) {
  const clients = await connection.query("SELECT id FROM judge_client WHERE `key` = ?", [key]);
  if (clients.length !== 1) {
    throw new ServiceBootstrapError("The configured judge client is not registered in the backend database.");
  }
  const id = positiveId(clients[0].id);
  // Exact key format used by JudgeClientService.setJudgeClientOnlineSessionId.
  const session = await redis.get(`judge-client-session-id:${id}`);
  if (typeof session !== "string" || session.length === 0) {
    throw new ServiceBootstrapError("The configured judge has not connected to the backend yet.");
  }
  return id;
}

async function readConfigFile(filename, ownerOnly = false) {
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & (ownerOnly ? 0o077 : 0o022))) {
      throw new ServiceBootstrapError("Instance configuration must be regular, root-owned, and protected from modification; private keys must be owner-only.");
    }
    return await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof ServiceBootstrapError) throw error;
    throw new ServiceBootstrapError("Cannot safely read the required instance configuration files.");
  } finally { await handle?.close(); }
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    if (!["--root", "--phase"].includes(option) || values[option] !== undefined || !argv[index + 1]) {
      throw new ServiceBootstrapError("Usage: node deploy/bootstrap-services.mjs --root /absolute/project --phase storage|judge|verify-judge");
    }
    values[option] = argv[index + 1];
  }
  if (!path.isAbsolute(values["--root"] || "") || values["--root"] === "/" ||
      !["storage", "judge", "verify-judge"].includes(values["--phase"])) {
    throw new ServiceBootstrapError("Usage: node deploy/bootstrap-services.mjs --root /absolute/project --phase storage|judge|verify-judge");
  }
  return { root: values["--root"], phase: values["--phase"] };
}

export async function runServiceBootstrap({ root, phase }) {
  if (process.getuid?.() !== 0) throw new ServiceBootstrapError("Run the service bootstrap helper as root through the installer.");
  root = await fs.realpath(root);
  if (root === "/") throw new ServiceBootstrapError("The installation root must not be /.");
  const configDirectory = await fs.lstat(path.join(root, "config"));
  if (!configDirectory.isDirectory() || configDirectory.isSymbolicLink() || configDirectory.uid !== 0 ||
      (configDirectory.mode & 0o022)) {
    throw new ServiceBootstrapError("The instance configuration directory must be a root-owned directory protected from modification.");
  }
  const require = createRequire(path.join(root, "apps/backend/package.json"));
  const yaml = require("js-yaml");
  let backend;
  try { backend = yaml.load(await readConfigFile(path.join(root, "config/backend.yaml"))); }
  catch (error) {
    if (error instanceof ServiceBootstrapError) throw error;
    throw new ServiceBootstrapError("Cannot parse the backend configuration.");
  }
  if (phase === "storage") {
    const { Client } = require("minio");
    const client = new Client(minioOptions(backend?.services?.minio));
    await ensureStorageBucket(client, backend?.services?.minio?.bucket);
    console.log("Private storage bucket is ready (credentials withheld).");
    return;
  }
  if (!["judge", "verify-judge"].includes(phase)) throw new ServiceBootstrapError("Unknown service bootstrap phase.");
  let judge;
  let secrets;
  try {
    judge = yaml.load(await readConfigFile(path.join(root, "config/judge.yaml"), true));
    secrets = JSON.parse(await readConfigFile(path.join(root, "config/secrets.json"), true));
  } catch (error) {
    if (error instanceof ServiceBootstrapError) throw error;
    throw new ServiceBootstrapError("Cannot parse the private judge configuration.");
  }
  const key = validateJudgeKey(judge, secrets);
  const mariadb = require("mariadb");
  let connection;
  let redis;
  try {
    connection = await mariadb.createConnection(databaseOptions(backend?.services?.database));
    if (phase === "judge") {
      await registerJudge(connection, key);
      console.log("Local judge registration is ready (credentials withheld).");
      return;
    }
    const uri = requireString(backend?.services?.redis, "Redis endpoint");
    let endpoint;
    try { endpoint = new URL(uri); }
    catch { throw new ServiceBootstrapError("Invalid Redis endpoint configuration."); }
    if (!["redis:", "rediss:"].includes(endpoint.protocol)) {
      throw new ServiceBootstrapError("Redis requires a redis:// or rediss:// endpoint.");
    }
    requireLoopback(endpoint.hostname, "Redis");
    const Redis = require("ioredis");
    redis = new Redis(uri, {
      lazyConnect: true,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      enableOfflineQueue: false,
      enableReadyCheck: true
    });
    // ioredis otherwise writes unhandled error event details to stderr.
    redis.on("error", () => {});
    await redis.connect();
    await verifyJudgeSession(connection, redis, key);
    console.log("The configured judge is connected to the backend (credentials withheld).");
  } finally {
    redis?.disconnect();
    await connection?.end().catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const deadline = setTimeout(() => {
    console.error("Service bootstrap timed out; check the local storage, database, Redis, and judge services (credentials withheld).");
    process.exit(1);
  }, 30000);
  deadline.unref();
  try {
    if (process.argv.length === 3 && process.argv[2] === "--help") {
      console.log("Usage: node deploy/bootstrap-services.mjs --root /absolute/project --phase storage|judge|verify-judge");
    } else {
      await runServiceBootstrap(parseArguments(process.argv.slice(2)));
    }
  } catch (error) {
    // Never print SDK error messages, SQL parameters, connection URIs, or config data.
    console.error(error instanceof ServiceBootstrapError ? error.message :
      "Service bootstrap failed; verify that local services are ready and the backend database schema exists (credentials withheld).");
    process.exitCode = 1;
  } finally { clearTimeout(deadline); }
}
