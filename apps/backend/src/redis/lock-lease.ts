import { AsyncLocalStorage } from "async_hooks";
import { performance } from "perf_hooks";

export const LOCK_TTL = 5000;
export const LOCK_REFRESH_INTERVAL = 2500;
const VALIDITY_MS = LOCK_TTL - 100;

export class LockLeaseLostError extends Error {
  readonly code = "LOCK_LEASE_LOST";

  private readonly shuttingDown: boolean;

  constructor(cause: unknown, reason?: "shutdown") {
    super("The Redis lock lease was lost.", { cause });
    this.name = "LockLeaseLostError";
    this.shuttingDown = reason === "shutdown" || LockLeaseLostError.isShutdown(cause);
  }

  static isShutdown(error: unknown): boolean {
    return error instanceof LockLeaseLostError && error.shuttingDown;
  }
}

function withCleanupError(primary: unknown, cleanup: unknown): unknown {
  if (primary === cleanup) return primary;
  if (primary instanceof Error) {
    const previous = Object.getOwnPropertyDescriptor(primary, "cleanupErrors");
    if (previous ? previous.configurable && Array.isArray(previous.value) : Object.isExtensible(primary)) {
      const errors: unknown[] = previous?.value ?? [];
      Object.defineProperty(primary, "cleanupErrors", { value: [...errors, cleanup], configurable: true });
      return primary;
    }
  }
  // JavaScript also permits throwing frozen objects and primitive values.
  return new AggregateError([primary, cleanup], "Protected operation and lease cleanup failed", { cause: primary });
}

export interface LockOwner {
  readonly key: string;
  readonly token: string;
  readonly reader: boolean;
}

/** One acquisition, including the renewal in flight when its callback ends. */
export class LockLease {
  private static readonly context = new AsyncLocalStorage<readonly LockLease[]>();

  private readonly controller = new AbortController();

  private deadline: number;

  private loss?: LockLeaseLostError;

  private released = false;

  private closing = false;

  private refreshTimer?: ReturnType<typeof setTimeout>;

  private expiryTimer?: ReturnType<typeof setTimeout>;

  private refreshing?: Promise<void>;

  constructor(
    readonly owner: LockOwner,
    sentAt: number,
    private readonly refresh: () => Promise<unknown>,
    private readonly check: () => Promise<unknown>
  ) {
    this.deadline = sentAt + VALIDITY_MS;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Detached work after normal release has no lock. Detached work after loss stays fenced. */
  static current(): readonly LockLease[] {
    const held = this.context.getStore()?.filter(lease => !lease.released) ?? [];
    for (const lease of held) lease.assertHeld();
    return held;
  }

  static assertCurrent(): void {
    const leases = this.context.getStore();
    if (leases) for (const lease of leases) if (!lease.released) lease.assertHeld();
  }

  private clearTimers(): void {
    clearTimeout(this.refreshTimer);
    clearTimeout(this.expiryTimer);
    this.refreshTimer = undefined;
    this.expiryTimer = undefined;
  }

  lose(cause: unknown): LockLeaseLostError {
    if (this.released) return new LockLeaseLostError(cause);
    if (!this.loss) {
      this.loss = new LockLeaseLostError(cause);
      this.clearTimers();
      this.controller.abort(this.loss);
    }
    return this.loss;
  }

  private checkDeadline(): void {
    if (performance.now() >= this.deadline) this.lose(new Error("Lease validity window elapsed"));
  }

  assertHeld(): void {
    if (this.released) throw new LockLeaseLostError(new Error("Lease already released"));
    this.checkDeadline();
    if (this.loss) throw this.loss;
  }

  /** A restart or eviction can remove a live token earlier than its TTL. */
  async verifyOwner(): Promise<void> {
    this.assertHeld();
    try {
      if (!(await this.check())) throw new Error("Redis no longer recognizes this lock owner");
    } catch (cause) {
      if (!this.released) throw this.lose(cause);
    }
    if (!this.released) this.assertHeld();
  }

  private scheduleRenewal(): void {
    this.clearTimers();
    const remaining = this.deadline - performance.now();
    this.expiryTimer = setTimeout(() => this.lose(new Error("Lease validity window elapsed")), Math.ceil(remaining));
    this.refreshTimer = setTimeout(
      () => {
        this.refreshing = this.renew().finally(() => {
          this.refreshing = undefined;
        });
      },
      Math.ceil(remaining - VALIDITY_MS + LOCK_REFRESH_INTERVAL)
    );
  }

  private async renew(): Promise<void> {
    try {
      this.assertHeld();
      const sentAt = performance.now();
      if (!(await this.refresh())) throw new Error("Redis refused to renew this owner");
      // A late reply cannot bridge a gap in known ownership, even if the expiry timer hasn't run yet.
      this.assertHeld();
      this.deadline = sentAt + VALIDITY_MS;
      if (!this.closing) this.scheduleRenewal();
    } catch (cause) {
      this.lose(cause);
    }
  }

  private async finish(unlock: () => Promise<unknown>): Promise<void> {
    this.closing = true;
    this.clearTimers();
    await this.refreshing;
    this.checkDeadline();
    try {
      if (!(await unlock())) throw new Error("Redis refused to release this owner");
    } catch (cause) {
      if (this.loss) withCleanupError(this.loss, cause);
      else this.lose(cause);
    }
    this.checkDeadline();
    if (this.loss) throw this.loss;
    this.released = true;
  }

  async run<T>(callback: (lease: LockLease) => Promise<T>, unlock: () => Promise<unknown>): Promise<T> {
    let result: T;
    let failure: { error: unknown };
    try {
      const parents = LockLease.current();
      this.assertHeld();
      this.scheduleRenewal();
      const parentSignal = AbortSignal.any(parents.map(lease => lease.signal));
      const onParentLoss = () => this.lose(parentSignal.reason);
      parentSignal.addEventListener("abort", onParentLoss, { once: true });
      let onLoss: () => void;
      const lost = new Promise<never>((_, reject) => {
        onLoss = () => reject(this.loss);
        this.signal.addEventListener("abort", onLoss, { once: true });
      });
      try {
        // The losing callback can still resume. Its async context retains this lease and its original loss.
        const operation = LockLease.context.run([...parents, this], async () => await callback(this));
        result = await Promise.race([operation, lost]);
        this.assertHeld();
      } finally {
        this.signal.removeEventListener("abort", onLoss);
        parentSignal.removeEventListener("abort", onParentLoss);
      }
    } catch (error) {
      failure = { error };
    }

    try {
      await this.finish(unlock);
    } catch (cleanup) {
      throw failure ? withCleanupError(failure.error, cleanup) : cleanup;
    }
    if (failure) throw failure.error;
    return result;
  }
}

export function currentLockLeases(): readonly LockLease[] {
  return LockLease.current();
}

export function assertLockLeasesHeld(): void {
  LockLease.assertCurrent();
}

export type HeldLockLease = Pick<LockLease, "signal" | "assertHeld">;

export async function assertLockLeasesCurrent(): Promise<void> {
  const leases = currentLockLeases();
  if (leases.length) {
    await Promise.all(leases.map(lease => lease.verifyOwner()));
    assertLockLeasesHeld();
  }
}
