#!/usr/bin/env node
// Run after the backend has synchronized its schema, never as a systemd service.
import { randomBytes, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class BootstrapError extends Error {}

export function generatePassword() {
  // The normal registration form accepts at most 32 characters.
  return randomBytes(24).toString("base64url");
}

export async function readPermissionDefinitions(root) {
  const enumSource = await fs.readFile(path.join(root, "apps/backend/src/user/user-privilege.entity.ts"), "utf8");
  const catalogSource = await fs.readFile(path.join(root, "apps/backend/src/access/permission-catalog.ts"), "utf8");
  const enumBody = /export enum UserPrivilegeType\s*\{([\s\S]*?)\}/.exec(enumSource)?.[1];
  const catalogBody = /export const permissionCatalog\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(catalogSource)?.[1];
  if (!enumBody || !catalogBody) throw new BootstrapError("Cannot read the backend permission definitions.");
  const privileges = [...enumBody.matchAll(/\b\w+\s*=\s*"([A-Za-z0-9_]+)"/g)].map(match => match[1]);
  const permissions = [...catalogBody.matchAll(/\bkey:\s*"([A-Za-z0-9_]+)"/g)].map(match => match[1]);
  if (!privileges.length || !permissions.length || !privileges.includes("ManagePermissions") ||
      privileges.length !== new Set(privileges).size || permissions.length !== new Set(permissions).size ||
      permissions.some(permission => !privileges.includes(permission))) {
    throw new BootstrapError("The backend permission definitions are inconsistent; no administrator was modified.");
  }
  return { privileges, permissions };
}

export function fileCredentialStore(filename) {
  async function load() {
    let handle;
    try {
      handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
        throw new BootstrapError("The administrator credentials file must be owner-only (0600) and owned by the installer.");
      }
      const value = JSON.parse(await handle.readFile("utf8"));
      if (value.version !== 1 || value.username !== "admin" || !Number.isSafeInteger(value.userId) ||
          value.userId <= 0 || typeof value.password !== "string" || value.password.length < 6 || value.password.length > 32) {
        throw new BootstrapError("The administrator credentials file is invalid; it was not overwritten.");
      }
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (error instanceof BootstrapError) throw error;
      throw new BootstrapError("Cannot safely read the administrator credentials file; it was not overwritten.");
    } finally {
      await handle?.close();
    }
  }

  async function write(value) {
    const temporary = `${filename}.pending-${process.pid}-${randomBytes(8).toString("hex")}`;
    let handle;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, filename);
      const directory = await fs.open(path.dirname(filename), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {
      throw new BootstrapError("Cannot securely save the administrator credentials; the database transaction was not committed.");
    } finally {
      await handle?.close();
      await fs.rm(temporary, { force: true });
    }
  }
  return { filename, load, write, remove: () => fs.rm(filename, { force: true }) };
}

export async function bootstrapAdmin({ connection, bcrypt, privileges, permissions, credentialStore,
  email = "admin@localhost.invalid", makePassword = generatePassword }) {
  const [database] = await connection.query("SELECT DATABASE() AS name");
  const lockName = `libreoj-admin-${createHash("sha256").update(database.name).digest("hex").slice(0, 40)}`;
  const [lock] = await connection.query("SELECT GET_LOCK(?, 30) AS acquired", [lockName]);
  if (Number(lock.acquired) !== 1) throw new BootstrapError("Another administrator initialization is in progress.");
  let transactionStarted = false;
  let credentialsAttempted = false;
  let commitAttempted = false;
  let saved;
  try {
    saved = await credentialStore.load();
    await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await connection.beginTransaction();
    transactionStarted = true;
    const users = await connection.query("SELECT id, username, isAdmin FROM `user` WHERE username = ? FOR UPDATE", ["admin"]);
    let user = users[0];
    let created = false;
    let credentials = null;
    if (user) {
      if (user.username !== "admin" || Number(user.isAdmin) !== 1) {
        throw new BootstrapError("The username admin is already occupied by a non-administrator or a different spelling; it was not elevated or overwritten.");
      }
      const [auth] = await connection.query("SELECT password FROM user_auth WHERE userId = ? FOR UPDATE", [user.id]);
      if (!auth?.password) throw new BootstrapError("The existing administrator has no usable password; it was not reset.");
      if (saved?.userId === Number(user.id) && await bcrypt.compare(saved.password, auth.password)) credentials = saved;
    } else {
      if (saved) {
        throw new BootstrapError("Saved administrator credentials exist but the corresponding administrator is missing; review this installation before recreating the account.");
      }
      const password = makePassword();
      if (typeof password !== "string" || password.length < 6 || password.length > 32) {
        throw new BootstrapError("The generated administrator password does not meet the normal registration limits.");
      }
      // Exactly the same algorithm and work factor as AuthService.hashPassword.
      const passwordHash = await bcrypt.hash(password, 10);
      const insert = await connection.query(
        "INSERT INTO `user` (username, email, nickname, bio, avatarInfo, isAdmin, acceptedProblemCount, submissionCount, rating, publicEmail, registrationTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["admin", email, "", "", "gravatar:", true, 0, 0, 0, false, new Date()]
      );
      const userId = Number(insert.insertId);
      if (!Number.isSafeInteger(userId) || userId <= 0) throw new BootstrapError("The database returned an invalid administrator ID.");
      user = { id: userId, username: "admin", isAdmin: true };
      await connection.query("INSERT INTO user_auth (userId, password) VALUES (?, ?)", [userId, passwordHash]);
      credentials = { version: 1, userId, username: "admin", password, createdAt: new Date().toISOString() };
      created = true;
    }

    // Preserve any existing profile/preferences when the installer is rerun.
    await connection.query(
      "INSERT INTO user_information (userId, organization, location, url, telegram, qq, github) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE userId = VALUES(userId)",
      [user.id, "", "", "", "", "", ""]
    );
    await connection.query("INSERT INTO user_preference (userId, preference) VALUES (?, ?) ON DUPLICATE KEY UPDATE userId = VALUES(userId)", [user.id, "{}"]);
    for (const privilege of privileges) {
      await connection.query("INSERT INTO user_privilege (userId, privilegeType) VALUES (?, ?) ON DUPLICATE KEY UPDATE userId = VALUES(userId)", [user.id, privilege]);
    }
    for (const permission of permissions) {
      await connection.query("INSERT INTO user_permission_rule (userId, permission, allowed) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE allowed = VALUES(allowed)", [user.id, permission, true]);
    }
    if (created) {
      // Persist and fsync before committing, so an interrupted installer can recover
      // the password. If COMMIT has an ambiguous result, retain this recovery file.
      credentialsAttempted = true;
      await credentialStore.write(credentials);
    }
    commitAttempted = true;
    await connection.commit();
    transactionStarted = false;
    return { created, userId: Number(user.id), credentials };
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => {});
    if (credentialsAttempted && !commitAttempted) {
      if (saved) await credentialStore.write(saved); else await credentialStore.remove();
    }
    throw error;
  } finally {
    await connection.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => {});
  }
}

export async function verifySavedCredentials({ connection, bcrypt, credentialStore }) {
  const [user] = await connection.query(
    "SELECT u.id, u.username, u.isAdmin, a.password FROM `user` u INNER JOIN user_auth a ON a.userId = u.id WHERE u.username = ?", ["admin"]
  );
  if (!user || user.username !== "admin" || Number(user.isAdmin) !== 1 || !user.password) {
    throw new BootstrapError("No initialized administrator with a usable password was found; credentials were not displayed.");
  }
  const saved = await credentialStore.load();
  if (!saved || Number(user.id) !== saved.userId || !(await bcrypt.compare(saved.password, user.password))) return null;
  return saved;
}

// Keep the final login details visible even when build output is redirected. A
// controlling terminal is preferred; unattended installs can still read stdout.
// Only credentials verified against the current database password are displayed.
export async function showAdminCredentials({ connection, bcrypt, credentialStore,
  language = process.env.LLMOJ_INSTALL_LANG, environment = process.env,
  openTerminal = () => fs.open("/dev/tty", "w"), stdout = process.stdout }) {
  const credentials = await verifySavedCredentials({ connection, bcrypt, credentialStore });
  const chinese = language === "zh-CN";
  const message = [
    chinese ? "管理员登录信息" : "Administrator login details",
    chinese ? "管理员用户名: admin" : "Administrator username: admin",
    credentials
      ? `${chinese ? "管理员密码" : "Administrator password"}: ${credentials.password}`
      : (chinese
        ? "管理员密码: 沿用原有密码（初始凭据缺失或已失效，未显示过期密码，未重置）"
        : "Administrator password: retained; initial credentials are missing or no longer current (not displayed or reset)"),
    chinese ? "管理员权限: 所有权限已开放（isAdmin）" : "Administrator privileges: all permissions (isAdmin)",
    `${chinese ? "管理员凭据文件位置" : "Administrator credential file location"}: ${credentialStore.filename} ${
      chinese ? "（仅 root 可读，0600）" : "(root only, 0600)"}`,
    ""
  ].join("\n");
  let terminal;
  try {
    terminal = await openTerminal();
  } catch (error) {
    // /dev/tty cannot be opened without a controlling terminal (for example in CI).
    if (!["ENXIO", "ENODEV", "ENOENT", "ENOTTY", "EACCES"].includes(error.code)) throw error;
  }
  if (terminal) {
    try { await terminal.writeFile(message); } finally { await terminal.close(); }
    return { verified: !!credentials, destination: "terminal" };
  }
  if (environment.INVOCATION_ID || environment.JOURNAL_STREAM) {
    throw new BootstrapError("Administrator credentials cannot be printed to a systemd journal; run the installer in your terminal.");
  }
  stdout.write(message);
  return { verified: !!credentials, destination: "stdout" };
}

function argumentsFor(argv) {
  const options = { root: process.env.LIBREOJ_ROOT || "/opt/LibreOJ", showCredentials: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--show-credentials") options.showCredentials = true;
    else if (["--root", "--config", "--email"].includes(flag) && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      options[flag.slice(2)] = argv[++index];
    } else throw new BootstrapError("Usage: node bootstrap-admin.mjs [--root DIR] [--config backend.yaml] [--email ADDRESS] [--show-credentials]");
  }
  options.root = path.resolve(options.root);
  options.config ||= process.env.LIBREOJ_CONFIG_FILE || path.join(options.root, "config/backend.yaml");
  if (options.email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email) || options.email.length > 255)) {
    throw new BootstrapError("The administrator email address is invalid.");
  }
  return options;
}

async function main() {
  if (process.getuid?.() !== 0) throw new BootstrapError("Run the administrator initialization through the installer with sudo.");
  const options = argumentsFor(process.argv.slice(2));
  const require = createRequire(path.join(options.root, "apps/backend/package.json"));
  const bcrypt = require("bcrypt");
  const mariadb = require("mariadb");
  const yaml = require("js-yaml");
  const config = yaml.load(await fs.readFile(options.config, "utf8"));
  const database = config?.services?.database;
  if (!database?.database || !database.username || !["mysql", "mariadb"].includes(database.type)) {
    throw new BootstrapError("The generated backend database configuration is missing or invalid.");
  }
  const connection = await mariadb.createConnection({
    host: database.host, port: database.port, user: database.username, password: database.password,
    database: database.database, connectTimeout: 10000, socketPath: database.socketPath
  });
  try {
    const credentialStore = fileCredentialStore(path.join(options.root, "config/admin-credentials.json"));
    if (options.showCredentials) {
      await showAdminCredentials({ connection, bcrypt, credentialStore });
    } else {
      const definitions = await readPermissionDefinitions(options.root);
      const result = await bootstrapAdmin({ connection, bcrypt, credentialStore, ...definitions, email: options.email });
      const chinese = process.env.LLMOJ_INSTALL_LANG === "zh-CN";
      process.stdout.write(result.created
        ? (chinese ? "已创建全权限 admin；初始凭据保存在仅 root 可读的 config/admin-credentials.json。\n"
          : "Administrator admin created with all permissions; initial credentials saved to the root-only config/admin-credentials.json.\n")
        : (chinese ? "保留已有全权限 admin，未重置密码。\n"
          : "Existing administrator admin retained with all permissions; its password was not reset.\n"));
    }
  } finally {
    await connection.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Driver errors can include SQL parameters. Never print their message/stack.
    const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code || "") ? ` (${error.code})` : "";
    process.stderr.write(error instanceof BootstrapError ? `${error.message}\n` : `Administrator initialization failed${code}; credentials were not displayed.\n`);
    process.exitCode = 1;
  });
}
