import fs from "fs";
import path from "path";

import * as Sandbox from "simple-sandbox";

import config from "./config";
import { MappedPath, safelyJoinPath, OverridableRecord, merge } from "./utils";
import rpc from "./rpc";
import { CanceledError } from "./error";
import { FileDescriptor } from "./posixUtils";
import * as fsNative from "./fsNative";
import { launcher, LauncherSandbox } from "./launcherClient";
import { openBeneathSync } from "./safeFile";

export enum CpuAffinityStrategy {
  Compiler = "Compiler",
  UserProgram = "UserProgram",
  Interactor = "Interactor",
  Checker = "Checker"
}

/**
 * `TaskIndependentSandboxConfig` doesn't contain `time`, `memory` and `workingDirectory` property.
 *
 * It's used for language's run config since some config of one language is common and task independent.
 *
 * @note Remember to use `merge` if you want to override environments from this config.
 */
export interface RuntimeInitializationConfig {
  executable: string;
  parameters: string[];
  time: number;
  memory: number;
  stackSize?: number;
  process: number;
}

export interface TaskIndependentSandboxConfig {
  /**
   * If `executable` is passed, it will be the file to execute
   */
  executable?: string;
  /**
   * Trusted language runtime startup, without submission files or stdin. Runs in
   * an independent compiler sandbox before every execution, including cache hits.
   */
  runtimeInitialization?: RuntimeInitializationConfig;
  /**
   * If `script` is passed, it will be written to a file and the file becomes the `executable`
   * The compiler / user program should be executed by the script
   * Note that the script itself, if not executed the compiler / user program via exec syscall, will be
   * also calcuated to the process limit
   */
  script?: string;

  /**
   * Will be prepend with the executable (or written script path) as argv
   */
  parameters: string[];
  /**
   * Stack size limit, by default equals to the memory limit
   * Note that for some language runtimes a too large stack size could cause issues
   */
  stackSize?: number;
  /**
   * The maximum process the executable can create (in the same time), including threads
   */
  process: number;
  /**
   * The file the standard input being redirect to
   */
  stdin?: string | FileDescriptor;
  /**
   * The file the standard output being redirect to
   */
  stdout?: string | FileDescriptor;
  /**
   * The file the standard error being redirect to
   */
  stderr?: string | FileDescriptor;

  /**
   * The being overrided environment variables
   */
  environments?: OverridableRecord<string, string>;
}

/**
 * `SandboxConfigBase` doesn't contain `tempDirectoryOutside`, `extraMounts` and `cpuAffinity` property.
 *
 * It's used for compilation config since we use common mounting config and CPU affinity for all languages.
 */
export interface SandboxConfigBase extends TaskIndependentSandboxConfig {
  time: number;
  memory: number;
  /**
   * The working directory for the process
   */
  workingDirectory: string;

  /**
   * The list of file descriptors to be preserved after `exec`
   */
  preservedFileDescriptors?: FileDescriptor[];
}

export interface SandboxConfig extends SandboxConfigBase {
  /**
   * The directory path outside the sandbox being mounted to `/tmp` inside sandbox
   */
  tempDirectoryOutside: string;

  /**
   * Extra mounts other than temp directory
   */
  extraMounts: SandboxMountDirectory[];

  /**
   * Pin the task to specfic CPU cores (starting from 0, defined in config)
   */
  cpuAffinity: CpuAffinityStrategy;
}

export interface SandboxMountDirectory {
  mappedPath: MappedPath;
  readOnly: boolean;
}

// Only external /tmp contents are writable; the original image remains immutable.
const insideBase = config.sandbox.immutable ? "/tmp/libreoj" : "/sandbox";
export const SANDBOX_INSIDE_PATH_BINARY = `${insideBase}/binary`;
export const SANDBOX_INSIDE_PATH_WORKING = `${insideBase}/working`;
export const SANDBOX_INSIDE_PATH_SOURCE = `${insideBase}/source`;

/**
 * Opens a standard I/O path of the program (inside the sandbox) through the directory mounted there, never following
 * a link the program could have left. Returns null for none (/dev/null).
 */
function openStandardFile(
  file: string,
  workingDirectory: string,
  mounts: SandboxMountDirectory[],
  write: boolean
): number | null {
  if (!file || file === "/dev/null") return null;
  const inside = path.posix.resolve(workingDirectory, file);
  const mount = mounts
    .filter(item => inside.startsWith(`${item.mappedPath.inside}/`))
    .sort((a, b) => b.mappedPath.inside.length - a.mappedPath.inside.length)[0];
  if (!mount) throw new Error(`The sandbox's standard I/O file ${inside} isn't in a mounted directory`);
  // eslint-disable-next-line no-bitwise
  const flags = write ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC : fs.constants.O_RDONLY;
  return openBeneathSync(mount.mappedPath.outside, inside.slice(mount.mappedPath.inside.length + 1), flags);
}

/**
 * @param taskId If not null, it is used to determine if and be notified when the current is canceled.
 */
export async function startSandbox(taskId: string, sandboxConfig: SandboxConfig) {
  if (taskId) rpc.ensureNotCanceled(taskId);

  if (sandboxConfig.runtimeInitialization) {
    const initialized = await runSandbox(taskId, {
      ...sandboxConfig.runtimeInitialization,
      workingDirectory: "/tmp",
      tempDirectoryOutside: sandboxConfig.tempDirectoryOutside,
      extraMounts: [],
      cpuAffinity: CpuAffinityStrategy.Compiler
    });
    if (initialized.status !== Sandbox.SandboxStatus.OK)
      throw new Error(`Language runtime initialization encountered a ${Sandbox.SandboxStatus[initialized.status]}`);
  }

  let executable: string;
  let parametersPrepend: string[];
  if (sandboxConfig.executable) {
    executable = sandboxConfig.executable;
    parametersPrepend = [executable];
  } else {
    executable = "/bin/bash";
    parametersPrepend = [executable, "-c", sandboxConfig.script, "script.sh"];
  }

  const mounts = [
    {
      mappedPath: {
        outside: sandboxConfig.tempDirectoryOutside,
        inside: "/tmp"
      },
      readOnly: false
    }
  ].concat(sandboxConfig.extraMounts);

  // /tmp binds first; nested mountpoints are created only in the external work directory. A mutable image already
  // has its mountpoints: it belongs to root.
  if (config.sandbox.immutable)
    await Promise.all(
      mounts.map(mount => {
        if (mount.mappedPath.inside === "/tmp") return Promise.resolve();
        if (!mount.mappedPath.inside.startsWith("/tmp/"))
          throw new Error("Immutable rootfs mounts must be inside /tmp");
        return fsNative.ensureDir(safelyJoinPath(sandboxConfig.tempDirectoryOutside, mount.mappedPath.inside.slice(5)));
      })
    );

  if (taskId) rpc.ensureNotCanceled(taskId);

  // Descriptors go to the launcher with the request; the program gets them at the same numbers as here.
  const passed: number[] = [];
  const opened: number[] = [];
  const pass = (fd: number) => {
    if (!passed.includes(fd)) passed.push(fd);
    return fd;
  };
  for (const descriptor of sandboxConfig.preservedFileDescriptors || []) if (descriptor) pass(descriptor.fd);
  const standard = (file: string | FileDescriptor, write: boolean) => {
    if (file && typeof file === "object") return pass(file.fd);
    const fd = openStandardFile(file as string, sandboxConfig.workingDirectory, mounts, write);
    if (fd === null) return null;
    opened.push(fd);
    return pass(fd);
  };

  let sandbox: LauncherSandbox;
  try {
    const stdin = standard(sandboxConfig.stdin, false);
    const stdout = standard(sandboxConfig.stdout, true);
    // The same file for both, as compilers' messages are, is opened once
    const stderr =
      typeof sandboxConfig.stderr === "string" && sandboxConfig.stderr === sandboxConfig.stdout
        ? stdout
        : standard(sandboxConfig.stderr, true);

    const environments = merge(config.sandbox.environments, sandboxConfig.environments);
    sandbox = await launcher().startSandbox(
      {
        time: sandboxConfig.time,
        memory: sandboxConfig.memory,
        // Stack pages are already included in the memory limits. A separate 8 MiB
        // ceiling rejects valid deep recursion while most of the problem budget is unused.
        stackSize: sandboxConfig.stackSize ?? sandboxConfig.memory,
        process: sandboxConfig.process,
        strategy: sandboxConfig.cpuAffinity,
        executable,
        parameters: [...parametersPrepend, ...(sandboxConfig.parameters || []).filter(x => x != null)],
        environments: Object.entries(environments).map(([key, value]) => `${key}=${value}`),
        workingDirectory: sandboxConfig.workingDirectory,
        mounts: mounts.map(mount => ({
          outside: mount.mappedPath.outside,
          inside: mount.mappedPath.inside,
          writable: !mount.readOnly
        })),
        descriptors: passed,
        stdin,
        stdout,
        stderr
      },
      passed
    );
  } finally {
    // The launcher has its own copies
    for (const fd of opened) fs.closeSync(fd);
  }

  const resultPromise = taskId
    ? // eslint-disable-next-line no-async-promise-executor
      new Promise<Sandbox.SandboxResult>(async (resolve, reject) => {
        const off = rpc.onCancel(taskId, () => {
          sandbox.stop();
        });

        try {
          const result = await sandbox.waitForStop();
          off();
          if (rpc.isCanceled(taskId)) reject(new CanceledError());
          else resolve(result);
        } catch (e) {
          off();
          reject(e);
        }
      })
    : sandbox.waitForStop();

  return {
    waitForStop: () => resultPromise,
    stop: () => sandbox.stop()
  };
}

/**
 * @param taskId If not null, it is used to determine if and be notified when the current is canceled.
 */
export async function runSandbox(taskId: string, sandboxConfig: SandboxConfig) {
  const sandbox = await startSandbox(taskId, sandboxConfig);
  return await sandbox.waitForStop();
}
