import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { bootstrapAdmin, fileCredentialStore, generatePassword, readPermissionDefinitions, verifySavedCredentials, showAdminCredentials } from "../bootstrap-admin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "apps/backend/package.json"));
const bcrypt = require("bcrypt");
const definitions = await readPermissionDefinitions(root);

function fixture(initial = {}, options = {}) {
  let state = { user: null, auth: null, information: null, preference: null, privileges: [], permissions: {}, ...initial };
  let saved = options.saved || null;
  let snapshot;
  let committed = false;
  const calls = [];
  const credentialStore = {
    filename: "/synthetic-install/config/admin-credentials.json",
    load: async () => saved,
    write: async value => { if (options.failWrite) throw new Error("disk full"); saved = structuredClone(value); },
    remove: async () => { saved = null; }
  };
  const connection = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (options.failQuery && sql.includes(options.failQuery)) throw new Error("database error");
      if (sql === "SELECT DATABASE() AS name") return [{ name: "isolated_fixture" }];
      if (sql.startsWith("SELECT GET_LOCK")) return [{ acquired: 1 }];
      if (sql.startsWith("SELECT RELEASE_LOCK") || sql.startsWith("SET TRANSACTION")) return [];
      if (sql.startsWith("SELECT u.id")) return state.user && state.auth ? [{ ...state.user, password: state.auth.password }] : [];
      if (sql.startsWith("SELECT id, username")) return state.user ? [state.user] : [];
      if (sql.startsWith("SELECT password")) return state.auth ? [state.auth] : [];
      if (sql.startsWith("INSERT INTO `user`")) {
        const [username, email, nickname, bio, avatarInfo, isAdmin, acceptedProblemCount, submissionCount, rating, publicEmail, registrationTime] = parameters;
        state.user = { id: 11, username, email, nickname, bio, avatarInfo, isAdmin, acceptedProblemCount, submissionCount, rating, publicEmail, registrationTime };
        return { insertId: 11n };
      }
      if (sql.startsWith("INSERT INTO user_auth")) { state.auth = { userId: parameters[0], password: parameters[1] }; return {}; }
      if (sql.startsWith("INSERT INTO user_information")) { state.information ||= parameters; return {}; }
      if (sql.startsWith("INSERT INTO user_preference")) { state.preference ||= parameters; return {}; }
      if (sql.startsWith("INSERT INTO user_privilege")) { if (!state.privileges.includes(parameters[1])) state.privileges.push(parameters[1]); return {}; }
      if (sql.startsWith("INSERT INTO user_permission_rule")) { state.permissions[parameters[1]] = parameters[2]; return {}; }
      throw new Error("Unexpected test query");
    },
    async beginTransaction() { snapshot = structuredClone(state); committed = false; },
    async commit() { committed = true; if (options.ambiguousCommit) throw new Error("connection lost after commit"); },
    async rollback() { if (!committed) state = snapshot; }
  };
  return { connection, credentialStore, calls, state: () => state, saved: () => saved,
    run: extra => bootstrapAdmin({ connection, credentialStore, bcrypt, ...definitions, ...extra }) };
}

test("new admin uses the real login password algorithm and grants every backend permission", async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.created, true);
  assert.equal(result.credentials.username, "admin");
  assert.match(result.credentials.password, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(bcrypt.getRounds(f.state().auth.password), 10);
  assert.equal(await bcrypt.compare(result.credentials.password, f.state().auth.password), true);
  assert.equal(f.state().user.isAdmin, true);
  assert.equal(f.state().user.publicEmail, false);
  assert.equal(f.state().information.length, 7);
  assert.deepEqual(JSON.parse(f.state().preference[1]), {});
  assert.deepEqual(f.state().privileges.sort(), definitions.privileges.toSorted());
  assert.deepEqual(Object.keys(f.state().permissions).sort(), definitions.permissions.toSorted());
  assert(Object.values(f.state().permissions).every(value => value === true));
  assert(!f.calls.some(call => call.parameters.includes(result.credentials.password)), "the plaintext password must never enter SQL");
  assert.deepEqual(f.saved(), result.credentials);
});

test("rerunning preserves the original password, profile and preferences", async () => {
  const f = fixture();
  const first = await f.run();
  const originalHash = f.state().auth.password;
  f.state().preference = [11, '{"theme":"dark"}'];
  f.state().information = [11, "Original organization"];
  f.state().permissions.ViewProblem = false;
  const next = await f.run({ makePassword: () => { throw new Error("must not generate a password"); } });
  assert.equal(next.created, false);
  assert.equal(f.state().auth.password, originalHash);
  assert.equal(next.credentials.password, first.credentials.password);
  assert.deepEqual(f.state().information, [11, "Original organization"]);
  assert.equal(f.state().preference[1], '{"theme":"dark"}');
  assert.equal(f.state().permissions.ViewProblem, true);
});

test("existing admin without an installation password record keeps its password", async () => {
  const hash = await bcrypt.hash(generatePassword(), 10);
  const f = fixture({ user: { id: 7, username: "admin", isAdmin: true }, auth: { userId: 7, password: hash } });
  const result = await f.run();
  assert.equal(result.created, false);
  assert.equal(result.credentials, null);
  assert.equal(f.state().auth.password, hash);
  assert.equal(f.saved(), null);
});

test("an ordinary user or differently spelled account is never elevated or overwritten", async () => {
  for (const user of [{ id: 5, username: "admin", isAdmin: false }, { id: 5, username: "Admin", isAdmin: true }]) {
    const f = fixture({ user });
    await assert.rejects(f.run(), /occupied/);
    assert.deepEqual(f.state().user, user);
    assert.equal(f.saved(), null);
    assert(!f.calls.some(call => call.sql.startsWith("INSERT")));
  }
});

test("database or credential-storage failure rolls back the entire account", async () => {
  for (const options of [{ failQuery: "INSERT INTO user_permission_rule" }, { failWrite: true }]) {
    const f = fixture({}, options);
    await assert.rejects(f.run());
    assert.equal(f.state().user, null);
    assert.equal(f.state().auth, null);
    assert.equal(f.saved(), null);
  }
});

test("an ambiguous commit keeps recoverable credentials and rerunning verifies them", async () => {
  const f = fixture({}, { ambiguousCommit: true });
  await assert.rejects(f.run(), /connection lost/);
  assert.equal(f.state().user.isAdmin, true);
  assert.equal(await bcrypt.compare(f.saved().password, f.state().auth.password), true);
  const recovered = await verifySavedCredentials({ ...f, bcrypt });
  assert.equal(recovered.password, f.saved().password);
});

test("a changed password is never displayed as the current installation password", async () => {
  const f = fixture();
  await f.run();
  f.state().auth.password = await bcrypt.hash(generatePassword(), 10);
  assert.equal(await verifySavedCredentials({ ...f, bcrypt }), null);
});

const noTerminal = async () => { throw Object.assign(new Error("No controlling terminal"), { code: "ENXIO" }); };

function outputFixture() {
  const chunks = [];
  return { stdout: { write: text => chunks.push(text) }, text: () => chunks.join("") };
}

test("fresh and repeated successful installs display verified login details and file location in both languages", async () => {
  const f = fixture();
  const first = await f.run();
  for (const language of ["en", "zh-CN"]) {
    for (const rerun of [false, true]) {
      if (rerun) await f.run({ makePassword: () => { throw new Error("must retain the saved password"); } });
      const output = outputFixture();
      const result = await showAdminCredentials({ ...f, bcrypt, language, openTerminal: noTerminal,
        environment: {}, stdout: output.stdout });
      assert.deepEqual(result, { verified: true, destination: "stdout" });
      assert(output.text().includes(language === "zh-CN" ? "管理员用户名: admin" : "Administrator username: admin"));
      assert(output.text().includes(`${language === "zh-CN" ? "管理员密码" : "Administrator password"}: ${first.credentials.password}`));
      assert(output.text().includes(f.credentialStore.filename));
      assert(output.text().includes("0600"));
      assert.equal(f.saved().password, first.credentials.password);
    }
  }
});

test("a controlling terminal receives the final block even when ordinary stdout is redirected", async () => {
  const f = fixture();
  await f.run();
  const output = outputFixture();
  let displayed = "";
  let closed = false;
  const result = await showAdminCredentials({ ...f, bcrypt, language: "en",
    environment: { JOURNAL_STREAM: "synthetic:stream" }, stdout: output.stdout,
    openTerminal: async () => ({
      writeFile: async text => { displayed += text; },
      close: async () => { closed = true; }
    }) });
  assert.deepEqual(result, { verified: true, destination: "terminal" });
  assert(displayed.includes(f.saved().password));
  assert(displayed.includes(f.credentialStore.filename));
  assert.equal(output.text(), "");
  assert.equal(closed, true);
});

test("a changed password is neither displayed nor reset when final login details are requested", async () => {
  const f = fixture();
  await f.run();
  const initial = f.saved().password;
  const current = generatePassword();
  f.state().auth.password = await bcrypt.hash(current, 10);
  const hash = f.state().auth.password;
  const output = outputFixture();
  const callCount = f.calls.length;
  const result = await showAdminCredentials({ ...f, bcrypt, language: "zh-CN",
    openTerminal: noTerminal, environment: {}, stdout: output.stdout });
  assert.equal(result.verified, false);
  assert(output.text().includes("未显示过期密码，未重置"));
  assert(!output.text().includes(initial));
  assert(!output.text().includes(current));
  assert.equal(f.state().auth.password, hash);
  assert.equal(f.saved().password, initial);
  assert(f.calls.slice(callCount).every(call => call.sql.startsWith("SELECT")));
});

test("missing original credentials produce an explanation and file location without resetting the account", async () => {
  const hash = await bcrypt.hash(generatePassword(), 10);
  const f = fixture({ user: { id: 7, username: "admin", isAdmin: true }, auth: { userId: 7, password: hash } });
  const output = outputFixture();
  const result = await showAdminCredentials({ ...f, bcrypt, language: "en",
    openTerminal: noTerminal, environment: {}, stdout: output.stdout });
  assert.equal(result.verified, false);
  assert(output.text().includes("initial credentials are missing or no longer current"));
  assert(output.text().includes(f.credentialStore.filename));
  assert.equal(f.state().auth.password, hash);
  assert.equal(f.saved(), null);
  assert(f.calls.every(call => call.sql.startsWith("SELECT")));
});

test("unverified credentials and journal-only execution never emit a password", async () => {
  const f = fixture();
  await f.run();
  for (const environment of [{ INVOCATION_ID: "synthetic" }, { JOURNAL_STREAM: "synthetic:stream" }]) {
    const output = outputFixture();
    await assert.rejects(showAdminCredentials({ ...f, bcrypt, openTerminal: noTerminal,
      environment, stdout: output.stdout }), /systemd journal/);
    assert.equal(output.text(), "");
  }
  const output = outputFixture();
  const broken = fixture({}, { failQuery: "SELECT u.id" });
  let opened = false;
  await assert.rejects(showAdminCredentials({ ...broken, bcrypt,
    openTerminal: async () => { opened = true; }, environment: {}, stdout: output.stdout }));
  assert.equal(output.text(), "");
  assert.equal(opened, false);
});

test("credential storage is owner-only, refuses symlinks and rejects readable files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "libreoj-admin-credentials-test-"));
  try {
    const filename = path.join(directory, "admin-credentials.json");
    const store = fileCredentialStore(filename);
    const value = { version: 1, username: "admin", userId: 1, password: generatePassword() };
    await store.write(value);
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    assert.deepEqual(await store.load(), value);
    await fs.chmod(filename, 0o644);
    await assert.rejects(store.load(), /owner-only/);
    await fs.chmod(filename, 0o600);
    const linked = path.join(directory, "linked.json");
    await fs.symlink(filename, linked);
    await assert.rejects(fileCredentialStore(linked).load(), /safely read/);
    assert.deepEqual(await store.load(), value);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("real backend entities and an isolated MariaDB accept the full administrator transaction", {
  skip: !process.env.LIBREOJ_ADMIN_TEST_SOCKET
}, async () => {
  const socketPath = process.env.LIBREOJ_ADMIN_TEST_SOCKET;
  assert.match(socketPath, /^\/tmp\/libreoj-admin-test-[A-Za-z0-9_-]+\/mysql\.sock$/, "integration tests only accept an isolated temporary Unix socket");
  const databaseName = `libreoj_admin_bootstrap_test_${randomBytes(8).toString("hex")}`;
  const mariadb = require("mariadb");
  const control = await mariadb.createConnection({ socketPath, user: "root" });
  let connection;
  let dataSource;
  let directory;
  try {
    await control.query(`CREATE DATABASE \`${databaseName}\``);
    require("reflect-metadata");
    const ts = require("typescript");
    const originalLoader = require.extensions[".ts"];
    const originalJsLoader = require.extensions[".js"];
    require.extensions[".ts"] = (module, filename) => {
      const source = require("node:fs").readFileSync(filename, "utf8");
      const output = ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true, emitDecoratorMetadata: true
      }, fileName: filename }).outputText;
      module._compile(output, filename);
    };
    let entities;
    try {
      entities = [
        ["user/user.entity.ts", "UserEntity"], ["auth/user-auth.entity.ts", "UserAuthEntity"],
        ["user/user-information.entity.ts", "UserInformationEntity"], ["user/user-preference.entity.ts", "UserPreferenceEntity"],
        ["user/user-privilege.entity.ts", "UserPrivilegeEntity"], ["access/user-permission-rule.entity.ts", "UserPermissionRuleEntity"]
      ].map(([filename, name]) => require(path.join(root, "apps/backend/src", filename))[name]);
    } finally {
      if (originalLoader) require.extensions[".ts"] = originalLoader; else delete require.extensions[".ts"];
      require.extensions[".js"] = originalJsLoader;
    }
    const { DataSource } = require("typeorm");
    dataSource = new DataSource({ type: "mariadb", username: "root", database: databaseName,
      extra: { socketPath }, entities, synchronize: true, logging: false });
    await dataSource.initialize();
    connection = await mariadb.createConnection({ socketPath, user: "root", database: databaseName });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "libreoj-admin-credentials-test-"));
    const credentialStore = fileCredentialStore(path.join(directory, "admin-credentials.json"));
    const first = await bootstrapAdmin({ connection, bcrypt, credentialStore, ...definitions });
    const [user] = await connection.query("SELECT username, isAdmin FROM `user` WHERE id = ?", [first.userId]);
    assert.equal(user.username, "admin");
    assert.equal(Number(user.isAdmin), 1);
    const [auth] = await connection.query("SELECT password FROM user_auth WHERE userId = ?", [first.userId]);
    assert.equal(bcrypt.getRounds(auth.password), 10);
    assert.equal(await bcrypt.compare(first.credentials.password, auth.password), true);
    const rules = await connection.query("SELECT permission, allowed FROM user_permission_rule WHERE userId = ?", [first.userId]);
    assert.deepEqual(rules.map(rule => rule.permission).sort(), definitions.permissions.toSorted());
    assert(rules.every(rule => Number(rule.allowed) === 1));
    const privileges = await connection.query("SELECT privilegeType FROM user_privilege WHERE userId = ?", [first.userId]);
    assert.deepEqual(privileges.map(row => row.privilegeType).sort(), definitions.privileges.toSorted());
    const second = await bootstrapAdmin({ connection, bcrypt, credentialStore, ...definitions });
    assert.equal(second.created, false);
    assert.equal(second.credentials.password, first.credentials.password);
    const [after] = await connection.query("SELECT password FROM user_auth WHERE userId = ?", [first.userId]);
    assert.equal(after.password, auth.password);
    assert.equal((await verifySavedCredentials({ connection, bcrypt, credentialStore })).password, first.credentials.password);
  } finally {
    await connection?.end();
    if (dataSource?.isInitialized) await dataSource.destroy();
    await control.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await control.end();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
});
