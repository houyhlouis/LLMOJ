/** Successful obligations only; failures and resource confirmations always execute afresh. */
import crypto from "crypto";
import fs from "fs";
import path from "path";

import {
  AI_QUALITY_POLICY_VERSION,
  AI_RECEIPT_VERSION,
  aiContractDigest,
  type AiExecutionMeasure,
  type AiRuntimeIdentity
} from "@libreoj/judge-protocol";

export const AI_RECEIPTS = "ai-receipts";
const LIMIT = 512 * 1024 * 1024;
const MAX_OUTPUT = 16 * 1024 * 1024;
const digest = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");
export interface ReceiptInputs {
  kind: "execution" | "comparison" | "legality";
  build: string;
  input: string;
  arguments: string[];
  profile: unknown;
  runtime: AiRuntimeIdentity;
  policy: string;
  actual?: string;
  expected?: string;
}
export const receiptKey = (inputs: ReceiptInputs) =>
  aiContractDigest({ ...inputs, version: AI_RECEIPT_VERSION, qualityPolicy: AI_QUALITY_POLICY_VERSION });
export interface ReceiptCounts {
  executions: number;
  comparisons: number;
  legality: number;
  fresh: number;
  reusedTiming: number;
}
export class AiReceipts {
  readonly counts: ReceiptCounts = { executions: 0, comparisons: 0, legality: 0, fresh: 0, reusedTiming: 0 };

  private bytes: number = null;

  private readonly directory: string;

  constructor(root: string, job: string) {
    if (!/^[0-9a-f-]{36}$/i.test(job)) throw new Error("Invalid receipt job");
    this.directory = path.join(root, AI_RECEIPTS, job.toLowerCase());
  }

  async run(
    inputs: ReceiptInputs,
    fresh: boolean,
    work: () => Promise<{ output: Buffer; measure?: AiExecutionMeasure }>
  ) {
    const key = receiptKey(inputs);
    const filename = path.join(this.directory, key);
    if (!fresh) {
      let file: fs.promises.FileHandle;
      try {
        // eslint-disable-next-line no-bitwise
        file = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = await file.stat();
        if (stat.isFile() && stat.size <= MAX_OUTPUT * 1.5 + 8192) {
          const receipt = JSON.parse(await file.readFile("utf8"));
          const output = Buffer.from(receipt.output, "base64");
          if (
            receipt.version === AI_RECEIPT_VERSION &&
            receipt.qualityPolicy === AI_QUALITY_POLICY_VERSION &&
            receipt.key === key &&
            receipt.hash === digest(output) &&
            output.length <= MAX_OUTPUT
          ) {
            this.counts[
              ({ execution: "executions", comparison: "comparisons", legality: "legality" } as const)[inputs.kind]
            ]++;
            if (receipt.measure) this.counts.reusedTiming++;
            const now = new Date();
            await fs.promises.utimes(this.directory, now, now);
            return { output, measure: receipt.measure as AiExecutionMeasure | undefined, timing: "reused" as const };
          }
        }
      } catch {
        // A missing/corrupt receipt is a cache miss, never evidence of success.
      } finally {
        await file?.close();
      }
    }
    const result = await work();
    this.counts.fresh++;
    if (this.bytes == null) {
      const names = await fs.promises.readdir(this.directory).catch((): string[] => []);
      this.bytes = 0;
      for (const name of names)
        this.bytes += (await fs.promises.lstat(path.join(this.directory, name)).catch(() => ({ size: 0 }))).size;
    }
    if (result.output.length <= MAX_OUTPUT && this.bytes + result.output.length <= LIMIT) {
      try {
        await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const space = await fs.promises.statfs(this.directory);
        if (space.bavail * space.bsize > 2 * 1024 ** 3 + result.output.length) {
          const contents = JSON.stringify({
            version: AI_RECEIPT_VERSION,
            qualityPolicy: AI_QUALITY_POLICY_VERSION,
            key,
            hash: digest(result.output),
            output: result.output.toString("base64"),
            measure: result.measure,
            at: new Date().toISOString()
          });
          const temporary = `${filename}.${crypto.randomUUID()}`;
          try {
            await fs.promises.writeFile(temporary, contents, { mode: 0o400, flag: "wx" });
            await fs.promises.rename(temporary, filename);
            this.bytes += Buffer.byteLength(contents);
          } finally {
            await fs.promises.rm(temporary, { force: true });
          }
        }
      } catch {
        // Reuse is an optimization: inability to retain evidence doesn't skip an obligation.
      }
    }
    return { ...result, timing: "fresh" as const };
  }
}
