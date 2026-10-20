/* eslint-disable no-bitwise */
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

import yaml from "js-yaml";
import * as Sandbox from "simple-sandbox";

import { LauncherServer, Account } from "./server";
import { loadSettings, LauncherSettings } from "./settings";
import {
  AI_RUNNER_DESCRIPTOR_VARIABLE,
  CONFIG_DESCRIPTOR_VARIABLE,
  DEFAULT_JUDGE_ACCOUNT,
  LAUNCHER_DESCRIPTOR_VARIABLE
} from "./protocol";
import * as native from "./native";

/*
 * The judge's sandbox launcher: the only part of the judge that runs as root.
 *
 * It reads the judge's private configuration, prepares the judge's directories, and starts the judge (src/index.ts)
 * as the account libreoj-judge, without privileges. The judge connects to the site, downloads files and handles
 * results; whenever it needs to run a program, it asks the launcher, which checks the request against the
 * configuration and runs the sandbox (src/launcher/server.ts).
 */

// The installation this code belongs to: <root>/apps/judge/src/launcher
const INSTALLATION_ROOT = path.resolve(__dirname, "../../../..");

function log(message: string) {
  // eslint-disable-next-line no-console
  console.error(`[launcher] ${message}`);
}

function account(): Account & { name: string } {
  const name = process.env.LIBREOJ_JUDGE_USER || DEFAULT_JUDGE_ACCOUNT;
  const entry = native.userEntry(name);
  if (!entry)
    throw new Error(
      `The account ${name} doesn't exist. Create it with: useradd --system --user-group --no-create-home ` +
        `--home-dir /nonexistent --shell /usr/sbin/nologin ${name}`
    );
  if (entry.uid === 0 || entry.gid === 0) throw new Error(`The account ${name} must not be root`);
  return { name, uid: entry.uid, gid: entry.gid };
}

/** Whether `stat`'s directory lets the account in. */
function searchable(stat: fs.Stats, judge: Account) {
  if (stat.uid === judge.uid) return (stat.mode & 0o100) !== 0;
  if (stat.gid === judge.gid) return (stat.mode & 0o010) !== 0;
  return (stat.mode & 0o001) !== 0;
}

/**
 * Lets the account reach `directory`: a parent directory of the installation's own that it can't pass through gets
 * search permission for others (o+x: passing through, not listing). Anywhere else, the administrator decides.
 */
function makeReachable(directory: string, judge: Account & { name: string }) {
  const parts = directory.split("/").filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    const ancestor = `/${parts.slice(0, i + 1).join("/")}`;
    const stat = fs.statSync(ancestor);
    if (searchable(stat, judge)) continue;
    if (ancestor.startsWith(`${INSTALLATION_ROOT}/`) && stat.uid === 0) {
      fs.chmodSync(ancestor, (stat.mode & 0o7777) | 0o001);
      log(`Let ${judge.name} pass through ${ancestor}`);
    } else throw new Error(`The account ${judge.name} can't reach ${directory}: allow it to pass through ${ancestor}`);
  }
}

async function walk(directory: string, options: native.WalkOptions) {
  const fd = native.openDirectory(directory, "");
  try {
    return await native.walkOwnership(fd, options);
  } finally {
    native.closeDescriptor(fd);
  }
}

function realDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory()) throw new Error(`${directory} must be a directory`);
}

/**
 * The judge's directories belong to its account. Files that root owns (left by judges that ran as root) and that the
 * sandbox user left are given to the account too.
 */
async function prepareDirectories(settings: LauncherSettings, judge: Account & { name: string }, sandboxUser: Account) {
  const own = { uid: judge.uid, gid: judge.gid, exact: false, directoryMode: 0o700, fileMode: 0o600 };
  for (const directory of [settings.dataStore, settings.binaryCacheStore, ...settings.taskWorkingDirectories]) {
    realDirectory(directory);
    makeReachable(directory, judge);
    const changed = await walk(directory, { ...own, owners: [0, sandboxUser.uid] });
    if (changed > 100) log(`Gave ${changed} files in ${directory} to ${judge.name}`);
    // Private to the judge: its parents may let others pass through, and sandboxes see only what is mounted
    fs.chmodSync(directory, fs.statSync(directory).mode & 0o7700);
  }
  if (settings.aiGeneratedDirectory) {
    // Readable by the backend's group: new files inherit the group from the set-group-ID directory
    realDirectory(settings.aiGeneratedDirectory);
    makeReachable(settings.aiGeneratedDirectory, judge);
    await walk(settings.aiGeneratedDirectory, {
      owners: [0, judge.uid, sandboxUser.uid],
      uid: judge.uid,
      gid: settings.aiRunnerGid,
      exact: false,
      directoryMode: 0o700,
      fileMode: 0o600
    });
    fs.chmodSync(settings.aiGeneratedDirectory, 0o2750);
  }
}

/** The local AI runner's socket, for the backend's group only. The judge gets the listening descriptor. */
function listenForAi(settings: LauncherSettings) {
  if (!settings.aiRunnerSocket) return -1;
  try {
    if (!fs.lstatSync(settings.aiRunnerSocket).isSocket())
      throw new Error(`${settings.aiRunnerSocket} exists and isn't a socket`);
    fs.unlinkSync(settings.aiRunnerSocket);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const fd = native.listenUnix(settings.aiRunnerSocket);
  fs.chownSync(settings.aiRunnerSocket, 0, settings.aiRunnerGid);
  fs.chmodSync(settings.aiRunnerSocket, 0o660);
  return fd;
}

export interface LauncherOptions {
  // The judge's configuration file (read as root), or its text
  configFile?: string;
  configText?: string;
  // The program to run as the judge's account, relative to apps/judge, and its arguments
  worker: string;
  args?: string[];
  // Whether to start the judge again when it exits with code 100 (it lost the connection to the site)
  restart: boolean;
}

/** Runs the launcher until the judge exits for good; resolves with its exit code. */
export async function runLauncher(options: LauncherOptions): Promise<number> {
  if (process.getuid() !== 0) throw new Error("The judge's sandbox launcher must run as root");
  // Nothing started from here, the judge included, can gain privileges through a set-user-ID program
  native.noNewPrivileges();
  const judge = account();

  let stopping = false;
  let current: { child: ChildProcess; server: LauncherServer } = null;
  const terminate = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`Stopping on ${signal}`);
    current?.child.kill("SIGTERM");
    setTimeout(() => current?.child.kill("SIGKILL"), 10000).unref();
  };
  process.on("SIGTERM", terminate);
  process.on("SIGINT", terminate);

  let aiListener = -1;
  let aiSocket: string = null;
  for (;;) {
    const configText = options.configText ?? fs.readFileSync(options.configFile, "utf-8");
    const settings = loadSettings(yaml.load(configText));
    const sandboxUser = Sandbox.getUidAndGidInSandbox(settings.rootfs, settings.sandboxUser);
    if (sandboxUser.uid === judge.uid) throw new Error("The sandbox user and the judge's account must differ");
    await prepareDirectories(settings, judge, sandboxUser);
    // Asked to stop before the judge started
    if (stopping) return 0;
    if (settings.aiRunnerSocket !== aiSocket) {
      if (aiListener !== -1) native.closeDescriptor(aiListener);
      aiListener = listenForAi(settings);
      aiSocket = settings.aiRunnerSocket;
    }

    const [launcherEnd, judgeEnd] = native.seqpacketPair();
    const config = native.pipe();
    const env = { ...process.env };
    delete env.LIBREOJ_JUDGE_CONFIG_FILE;
    delete env.LIBREOJ_JUDGE_USER;
    env[LAUNCHER_DESCRIPTOR_VARIABLE] = "3";
    env[CONFIG_DESCRIPTOR_VARIABLE] = "4";
    if (aiListener !== -1) env[AI_RUNNER_DESCRIPTOR_VARIABLE] = "5";
    else delete env[AI_RUNNER_DESCRIPTOR_VARIABLE];
    const child = spawn(process.execPath, [...process.execArgv, options.worker, ...(options.args || [])], {
      cwd: path.resolve(__dirname, "../.."),
      env,
      uid: judge.uid,
      gid: judge.gid,
      stdio: ["ignore", "inherit", "inherit", judgeEnd, config.read, ...(aiListener !== -1 ? [aiListener] : [])]
    });
    native.closeDescriptor(judgeEnd);
    native.closeDescriptor(config.read);
    const server = new LauncherServer(
      settings,
      judge,
      sandboxUser,
      settings.aiRunnerSocket ? process.env.HYHOJ_AI_SAMPLE_INPUTS_DIR || "/opt/LLMOJ/data/ai-sample-inputs" : null,
      log
    );
    current = { child, server };
    const exited = new Promise<{ code: number; signal: string }>(resolve => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
      // Not started at all: no "exit" follows
      child.on("error", () => resolve({ code: child.exitCode ?? 1, signal: null }));
    });
    child.on("error", error => log(`Can't start the judge: ${error.message}`));
    server.serve(launcherEnd, () => {
      // The judge closed its end: it has exited, or is about to
    });
    // The judge reads its configuration as it starts
    const text = Buffer.from(configText);
    let written = 0;
    while (written < text.length) written += fs.writeSync(config.write, text, written, text.length - written);
    native.closeDescriptor(config.write);

    const { code, signal } = await exited;
    await server.stopAll();
    server.close();
    current = null;
    if (signal) log(`The judge was killed by ${signal}`);
    if (!stopping && options.restart && code === 100) continue;
    if (aiListener !== -1) native.closeDescriptor(aiListener);
    if (stopping) return 0;
    // Killed by a signal (e.g. the OOM killer): exit as failed, so that the service manager starts the judge again
    return code ?? 1;
  }
}
