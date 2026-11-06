import { createHash } from "crypto";
import path from "path";
import { Worker } from "worker_threads";

import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";

import type { PdfBook, PdfResult } from "./pdf/statement-pdf";

/**
 * Makes statement PDFs in a worker thread, one at a time per backend process, so typesetting never blocks requests.
 * Everyone who downloads a contest at its start gets the same PDF: equal books share one rendering while it runs and
 * a cached result for a while after. The worker stops after a minute without work (its fonts and MathJax take memory)
 * and is restarted after a rendering that takes too long.
 */

interface Job {
  id: number;
  book: PdfBook;
  resolve(result: PdfResult): void;
  reject(error: Error): void;
}

export const PDF_LIMITS = {
  /** Books waiting for the worker; more are refused as busy */
  queue: 8,
  timeout: 120_000,
  idle: 60_000,
  cacheBytes: 64 * 1024 * 1024,
  cacheTime: 10 * 60_000,
  memoryMb: 1024
};

export class StatementPdfError extends HttpException {
  constructor(code: "STATEMENTS_BUSY" | "STATEMENTS_TIMEOUT" | "STATEMENTS_FAILED") {
    super(
      { error: code },
      code === "STATEMENTS_BUSY" ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
}

@Injectable()
export class StatementPdfService implements OnModuleDestroy {
  /** Tests run the worker from TypeScript: a module the worker requires first (a compiler hook) */
  static workerPreload: string = null;

  private readonly logger = new Logger("StatementPdfService");

  private worker: Worker = null;

  private running: Job = null;

  private readonly queue: Job[] = [];

  private nextId = 1;

  private timer: ReturnType<typeof setTimeout> = null;

  private readonly inFlight = new Map<string, Promise<PdfResult>>();

  private readonly cache = new Map<string, { result: PdfResult; until: number }>();

  async render(book: PdfBook): Promise<PdfResult> {
    const key = createHash("sha256").update(JSON.stringify(book)).digest("hex");
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) {
      // Most recently used last
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.result;
    }
    if (this.inFlight.has(key)) return await this.inFlight.get(key);
    if (this.queue.length >= PDF_LIMITS.queue) throw new StatementPdfError("STATEMENTS_BUSY");
    const promise = new Promise<PdfResult>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, book, resolve, reject });
      this.next();
    });
    this.inFlight.set(key, promise);
    try {
      const result = await promise;
      this.remember(key, result);
      return result;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private remember(key: string, result: PdfResult) {
    const now = Date.now();
    for (const [old, entry] of this.cache) if (entry.until <= now) this.cache.delete(old);
    this.cache.set(key, { result, until: now + PDF_LIMITS.cacheTime });
    let bytes = [...this.cache.values()].reduce((sum, entry) => sum + entry.result.pdf.length, 0);
    for (const [old, entry] of this.cache) {
      if (bytes <= PDF_LIMITS.cacheBytes) break;
      this.cache.delete(old);
      bytes -= entry.result.pdf.length;
    }
  }

  private spawn() {
    const preload = StatementPdfService.workerPreload;
    const options = { resourceLimits: { maxOldGenerationSizeMb: PDF_LIMITS.memoryMb } };
    const file = path.join(__dirname, "pdf", "statement-pdf.worker");
    const worker = __filename.endsWith(".ts")
      ? new Worker(`require(${JSON.stringify(preload)}); require(${JSON.stringify(`${file}.ts`)});`, {
          ...options,
          eval: true
        })
      : new Worker(`${file}.js`, options);
    worker.on(
      "message",
      (message: { id: number; pdf?: Uint8Array; pages?: number; warnings?: PdfResult["warnings"]; error?: string }) => {
        const job = this.running;
        if (!job || job.id !== message.id) return;
        this.finish();
        if (message.error) {
          this.logger.warn(`A statement PDF failed: ${message.error}`);
          job.reject(new StatementPdfError("STATEMENTS_FAILED"));
        } else
          job.resolve({
            pdf: Buffer.from(message.pdf.buffer, message.pdf.byteOffset, message.pdf.byteLength),
            pages: message.pages,
            warnings: message.warnings
          });
      }
    );
    worker.on("error", error => this.lost(worker, error));
    worker.on("exit", code => this.lost(worker, new Error(`exited with code ${code}`)));
    return worker;
  }

  /** The worker stopped (an error, too much memory): the book it worked on fails, the next one gets a new worker */
  private lost(worker: Worker, error: Error) {
    if (this.worker !== worker) return;
    this.worker = null;
    const job = this.running;
    if (job) {
      this.logger.warn(`The statement PDF worker stopped: ${error.message}`);
      this.finish();
      job.reject(new StatementPdfError("STATEMENTS_FAILED"));
    }
  }

  private finish() {
    clearTimeout(this.timer);
    this.running = null;
    this.next();
  }

  private next() {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.stop(), PDF_LIMITS.idle);
      this.timer.unref();
      return;
    }
    this.running = job;
    this.worker ??= this.spawn();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.logger.warn("A statement PDF took too long; its worker is stopped");
      const { worker } = this;
      this.worker = null;
      this.running = null;
      job.reject(new StatementPdfError("STATEMENTS_TIMEOUT"));
      worker?.terminate().catch(() => undefined);
      this.next();
    }, PDF_LIMITS.timeout);
    this.timer.unref();
    this.worker.postMessage({ id: job.id, book: job.book });
  }

  private stop() {
    if (this.running || !this.worker) return;
    const { worker } = this;
    this.worker = null;
    worker.terminate().catch(() => undefined);
  }

  async onModuleDestroy() {
    clearTimeout(this.timer);
    for (const job of this.queue.splice(0)) job.reject(new StatementPdfError("STATEMENTS_FAILED"));
    const { worker } = this;
    this.worker = null;
    await worker?.terminate();
  }
}
