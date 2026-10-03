/** Opt-in client for a disposable local integration environment. */
import fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

export const require = createRequire(new URL("../package.json", import.meta.url));
function requiredEnvironment(name) {
  const value = process.env[name];
  assert(value?.trim(), `Set ${name} explicitly for the disposable integration environment`);
  return value;
}
function loopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}
function parseUrl(value, label) {
  try { return new URL(value); }
  catch { throw new Error(`${label} must be a valid URL`); }
}
const configPath = requiredEnvironment("HYHOJ_TEST_CONFIG");
export const statePath = requiredEnvironment("HYHOJ_TEST_STATE");
const baseUrl = parseUrl(requiredEnvironment("HYHOJ_TEST_BASE"), "HYHOJ_TEST_BASE");
export const config = require("js-yaml").load(fs.readFileSync(configPath, "utf8"));
const database = config?.services?.database;
assert(database && /^hyhoj_test_[a-zA-Z0-9_]+$/.test(database.database),
  "Integration tests require a database named hyhoj_test_* reserved for test fixtures");
assert(loopback(database.host), "Integration test MariaDB must use a numeric loopback address");
assert(baseUrl.protocol === "http:" || baseUrl.protocol === "https:", "Test API must use HTTP or HTTPS");
assert(loopback(baseUrl.hostname), "Test API must use a numeric loopback address");
assert(!baseUrl.username && !baseUrl.password && !baseUrl.search && !baseUrl.hash && baseUrl.pathname === "/",
  "HYHOJ_TEST_BASE must be an origin without credentials, query, hash or path");
assert(!["2002", "29533"].includes(baseUrl.port), "Use a dedicated test API port");
export const base = baseUrl.origin;
assert(typeof config.services.redis === "string", "Test Redis must be configured as an explicit URL");
const redisUrl = parseUrl(config.services.redis, "Test Redis");
assert(["redis:", "rediss:"].includes(redisUrl.protocol) && loopback(redisUrl.hostname),
  "Test Redis must use a numeric loopback address");
assert(/^\/[1-9][0-9]*$/.test(redisUrl.pathname) && !redisUrl.search && !redisUrl.hash,
  "Test Redis requires an explicit dedicated nonzero database, without URL options");
assert(redisUrl.port !== "16379", "Use a dedicated test Redis instance");

export const readState = () => {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert(state && typeof state.users === "object" && typeof state.tokens === "object",
    "HYHOJ_TEST_STATE must contain only the disposable fixture users and session tokens");
  return state;
};
// Validate the explicitly selected fixture state before opening database connections.
readState();
export const db = await require("mariadb").createConnection({
  host: database.host, port: database.port, user: database.username,
  password: database.password, database: database.database
});
export const redis = new (require("ioredis"))(config.services.redis, {
  lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1
});
try { await redis.connect(); }
catch (error) { await db.end(); redis.disconnect(); throw error; }
export async function request(token, route, body, expected = 200) {
  assert(/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(route), "Invalid test API route");
  const response = await fetch(`${base}/api/${route}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  assert([expected, expected === 200 ? 201 : expected].includes(response.status),
    `${route} returned HTTP ${response.status}`);
  return response.json();
}
export async function close() {
  try { await db.end(); }
  finally {
    if (redis.status === "ready") await redis.quit();
    else redis.disconnect();
  }
}
