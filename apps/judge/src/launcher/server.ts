/* eslint-disable no-bitwise */
import fs from "fs";

import * as Sandbox from "simple-sandbox";

import { checkSandboxRequest, RequestError, sandboxParameter } from "./policy";
import { LauncherSettings } from "./settings";
import { JudgeMessage, LauncherMessage, SAMPLE_JOB, SAMPLE_NAME } from "./protocol";
import * as native from "./native";

export interface Account {
  uid: number;
  gid: number;
}

interface Run {
  sandbox?: ReturnType<typeof Sandbox.startSandbox>;
  stopped: boolean;
  done: Promise<void>;
}

interface Pinned {
  fd: number;
  writable: boolean;
}

function closeAll(descriptors: number[]) {
  for (const fd of descriptors) {
    try {
      native.closeDescriptor(fd);
    } catch {
      // Already closed
    }
  }
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the judge's sandboxes. Before a sandbox starts, its writable directories are given to the sandbox user and
 * its read-only ones are made readable, as the judge used to do as root; afterwards, everything the sandbox user left
 * in the writable ones is given back to the judge's account. Mount sources are opened through directories only, here
 * and again by the sandbox, so root never follows a link the judge or a program left.
 */
export class LauncherServer {
  private readonly runs = new Map<number, Run>();

  private channel: native.ChannelHandle = null;

  constructor(
    private readonly settings: LauncherSettings,
    private readonly account: Account,
    private readonly sandboxUser: Account,
    // The local AI runner's sample directory (the backend's), or null
    private readonly sampleDirectory: string | null,
    private readonly log: (message: string) => void
  ) {}

  /** Serves requests on a channel descriptor until the judge closes it. */
  serve(fd: number, onClose: () => void) {
    this.channel = new native.Channel(fd, (data, descriptors) => {
      if (data === null) {
        onClose();
        return;
      }
      let message: JudgeMessage;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        closeAll(descriptors);
        this.log("Refused a message that isn't JSON");
        return;
      }
      this.handle(message, descriptors).catch(error => this.log(`Request failed: ${describe(error)}`));
    });
  }

  close() {
    this.channel?.close();
    this.channel = null;
  }

  /** Stops every sandbox and waits until they are gone. */
  async stopAll() {
    const runs = [...this.runs.values()];
    for (const run of runs) {
      run.stopped = true;
      run.sandbox?.stop();
    }
    await Promise.all(runs.map(run => run.done));
  }

  private reply(message: LauncherMessage, descriptors?: number[]) {
    if (!this.channel) return;
    try {
      this.channel.send(Buffer.from(JSON.stringify(message)), descriptors);
    } catch (error) {
      this.log(`Can't reply to the judge: ${describe(error)}`);
    }
  }

  private async handle(message: JudgeMessage, descriptors: number[]) {
    const id = message && typeof message === "object" ? message.id : undefined;
    if (!Number.isSafeInteger(id)) {
      closeAll(descriptors);
      this.log("Refused a request without an ID");
      return;
    }
    if (message.op === "start") {
      await this.start(id, message.sandbox, descriptors);
      return;
    }
    closeAll(descriptors);
    if (message.op === "stop") this.stop(id);
    else if (message.op === "openSample") this.openSample(id, message.job, message.name);
    else this.reply({ op: "failed", id, message: "Unknown request" });
  }

  private get forSandbox(): native.WalkOptions {
    return {
      owners: [this.account.uid, this.sandboxUser.uid],
      uid: this.sandboxUser.uid,
      gid: this.sandboxUser.gid,
      exact: true,
      directoryMode: 0o755,
      fileMode: 0o755
    };
  }

  private get readable(): native.WalkOptions {
    return {
      owners: [this.account.uid, this.sandboxUser.uid],
      uid: this.account.uid,
      gid: this.account.gid,
      exact: true,
      directoryMode: 0o755,
      fileMode: 0o755
    };
  }

  private get forJudge(): native.WalkOptions {
    return {
      owners: [this.sandboxUser.uid],
      uid: this.account.uid,
      gid: this.account.gid,
      exact: false,
      directoryMode: 0o700,
      fileMode: 0o600
    };
  }

  private async giveBack(pinned: Pinned[]) {
    await Promise.all(pinned.filter(item => item.writable).map(item => native.walkOwnership(item.fd, this.forJudge)));
  }

  private async start(id: number, request: unknown, received: number[]) {
    const pinned: Pinned[] = [];
    let run: Run;
    let finish: () => void;
    try {
      if (this.runs.has(id)) throw new RequestError("The request ID is in use");
      if (this.runs.size >= this.settings.maxSandboxes) throw new RequestError("Too many sandboxes are running");
      const checked = checkSandboxRequest(request, this.settings, received.length);
      // A program gets only pipes and regular files the judge's account owns (its own files, pipes and shared
      // memory): never a directory, socket or device, nor another user's file it could reopen as the sandbox user
      for (const fd of received) {
        const stat = fs.fstatSync(fd);
        if (!(stat.isFile() || stat.isFIFO()) || stat.uid !== this.account.uid)
          throw new RequestError("Only the judge's own pipes and files can be passed to a program");
      }
      run = {
        stopped: false,
        done: new Promise(resolve => {
          finish = resolve;
        })
      };
      this.runs.set(id, run);
      for (const mount of checked.mounts)
        pinned.push({ fd: native.openDirectory(mount.root, mount.relative), writable: mount.writable });
      await Promise.all(
        pinned.map(item => native.walkOwnership(item.fd, item.writable ? this.forSandbox : this.readable))
      );
      if (run.stopped) throw new Error("Stopped before it started");
      run.sandbox = Sandbox.startSandbox(sandboxParameter(checked, this.settings, this.sandboxUser, received));
    } catch (error) {
      closeAll(received);
      await this.giveBack(pinned).catch(cleanup => this.log(`Can't give a directory back: ${describe(cleanup)}`));
      closeAll(pinned.map(item => item.fd));
      if (run) {
        this.runs.delete(id);
        finish();
      }
      this.reply({ op: "failed", id, message: describe(error) });
      return;
    }

    // The program has its own copies now. Closing ours lets pipes reach end of file.
    closeAll(received);
    closeAll(pinned.filter(item => !item.writable).map(item => item.fd));
    if (run.stopped) run.sandbox.stop();
    this.reply({ op: "started", id });

    let result: Sandbox.SandboxResult;
    let failure: unknown;
    try {
      result = await run.sandbox.waitForStop();
    } catch (error) {
      failure = error;
    }
    try {
      await this.giveBack(pinned);
    } catch (error) {
      failure ??= error;
    }
    closeAll(pinned.filter(item => item.writable).map(item => item.fd));
    this.runs.delete(id);
    finish();
    if (failure) this.reply({ op: "failed", id, message: describe(failure) });
    else this.reply({ op: "result", id, result });
  }

  private stop(id: number) {
    const run = this.runs.get(id);
    if (!run) return;
    run.stopped = true;
    run.sandbox?.stop();
  }

  private openSample(id: number, job: unknown, name: unknown) {
    let directory = -1;
    let file = -1;
    try {
      if (!this.sampleDirectory) throw new RequestError("This judge has no local AI runner");
      if (typeof job !== "string" || !SAMPLE_JOB.test(job) || typeof name !== "string" || !SAMPLE_NAME.test(name))
        throw new RequestError("Invalid sample file");
      directory = native.openDirectory(this.sampleDirectory, job);
      file = fs.openSync(
        `/proc/self/fd/${directory}/${name}`,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY
      );
      if (!fs.fstatSync(file).isFile()) throw new RequestError("The sample isn't a regular file");
      this.reply({ op: "sample", id }, [file]);
    } catch (error) {
      this.reply({ op: "failed", id, message: describe(error) });
    } finally {
      closeAll([directory, file].filter(fd => fd !== -1));
    }
  }
}
