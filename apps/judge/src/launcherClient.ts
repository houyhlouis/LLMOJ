import winston from "winston";
import type { SandboxResult } from "simple-sandbox";

import { JudgeMessage, LauncherMessage, LAUNCHER_DESCRIPTOR_VARIABLE, SandboxRequest } from "./launcher/protocol";
import * as native from "./launcher/native";

/*
 * The judge's side of its sandbox launcher (src/launcher). The judge runs without privileges; the launcher, its
 * parent, runs every sandbox for it.
 */

interface Pending {
  started?: () => void;
  sample?: (fd: number) => void;
  result?: (result: SandboxResult) => void;
  fail: (error: Error) => void;
}

export interface LauncherSandbox {
  waitForStop(): Promise<SandboxResult>;
  stop(): void;
}

class LauncherClient {
  private readonly channel: native.ChannelHandle;

  private readonly pending = new Map<number, Pending>();

  private nextId = 1;

  constructor(fd: number) {
    // The launcher's channel must not reach programs the judge starts (e.g. findmnt)
    native.setCloseOnExec(fd, true);
    this.channel = new native.Channel(fd, (data, descriptors) => this.receive(data, descriptors));
  }

  private receive(data: Buffer, descriptors: number[]) {
    if (data === null) {
      winston.error("The sandbox launcher is gone");
      // Nothing can be judged without it; the launcher (if it's still there) starts the judge again
      process.exit(1);
    }
    let message: LauncherMessage;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      message = null;
    }
    const pending = message && this.pending.get(message.id);
    if (!pending) {
      descriptors.forEach(fd => native.closeDescriptor(fd));
      return;
    }
    if (message.op === "started") {
      pending.started?.();
    } else if (message.op === "sample" && descriptors.length === 1) {
      this.pending.delete(message.id);
      pending.sample?.(descriptors[0]);
      return;
    } else if (message.op === "result") {
      this.pending.delete(message.id);
      pending.result?.(message.result as SandboxResult);
    } else {
      this.pending.delete(message.id);
      pending.fail(new Error(message.op === "failed" ? message.message : "Unexpected reply from the sandbox launcher"));
    }
    descriptors.forEach(fd => native.closeDescriptor(fd));
  }

  private send(message: JudgeMessage, descriptors?: number[]) {
    this.channel.send(Buffer.from(JSON.stringify(message)), descriptors);
  }

  /**
   * Starts a sandbox. `descriptors` are this process's descriptors the program gets at the same numbers (listed in
   * `request.descriptors`); the launcher has its own copies once this resolves.
   */
  startSandbox(request: SandboxRequest, descriptors: number[]): Promise<LauncherSandbox> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pending: Pending = { fail: reject };
      const finished = new Promise<SandboxResult>((resolveResult, rejectResult) => {
        pending.result = resolveResult;
        pending.started = () => {
          // From now on a failure is the sandbox's result
          pending.fail = rejectResult;
          resolve({
            waitForStop: () => finished,
            stop: () => {
              if (this.pending.has(id)) this.send({ op: "stop", id });
            }
          });
        };
      });
      // Not awaited before the sandbox starts; a failure then rejects the start instead
      finished.catch(() => undefined);
      this.pending.set(id, pending);
      try {
        this.send({ op: "start", id, sandbox: request }, descriptors);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** An open, read-only descriptor of a sample file the backend stored for a local AI job. */
  openSample(job: string, name: string): Promise<number> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { sample: resolve, fail: reject });
      try {
        this.send({ op: "openSample", id, job, name });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}

let client: LauncherClient = null;

/** The launcher this judge was started by. */
export function launcher(): LauncherClient {
  if (!client) {
    const fd = Number(process.env[LAUNCHER_DESCRIPTOR_VARIABLE]);
    if (!Number.isInteger(fd) || fd < 3)
      throw new Error("The judge runs only under its sandbox launcher: start it with index.mjs");
    client = new LauncherClient(fd);
  }
  return client;
}
