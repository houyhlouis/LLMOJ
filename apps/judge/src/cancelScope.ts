/*
 * Cancellation of work that isn't a judge task of its own (review Part III, H09): an AI run. The run enters a scope;
 * every sandbox it starts meanwhile, through any number of calls and awaits, stops as soon as the scope is canceled, and
 * work still waiting for an execution slot leaves the queue. A judge task's sandboxes use its task ID instead.
 */
import { AsyncLocalStorage } from "async_hooks";

export interface CancelScope {
  isCanceled(): boolean;
  /** Calls `callback` once when the scope is canceled (at once if it is); returns a function that stops listening. */
  onCancel(callback: () => void): () => void;
  /** The error that canceled work throws. */
  error(): Error;
}

const storage = new AsyncLocalStorage<CancelScope>();

/** Runs `work` in `scope`: the sandboxes it starts stop when the scope is canceled. */
export function withCancelScope<T>(scope: CancelScope, work: () => Promise<T>): Promise<T> {
  return storage.run(scope, work);
}

/** The scope the current work runs in, or null. */
export function currentCancelScope(): CancelScope | null {
  return storage.getStore() || null;
}

/**
 * Runs `work` in `scope` when its turn comes in a queue (`add` queues a function, as promise-queue's does). Canceled
 * while it waits, it leaves at once, rejecting with the scope's error, and its turn does nothing when it comes; once
 * started, it ends as `work` does (its programs stop, and it cleans up before the caller goes on).
 */
export function runInTurn<T>(
  add: (run: () => Promise<T | void>) => Promise<T | void>,
  scope: CancelScope,
  work: () => Promise<T>
): Promise<T> {
  let started = false;
  const turn = add(() => {
    // Canceled while it waited: it has left already
    if (scope.isCanceled()) return Promise.resolve();
    started = true;
    return withCancelScope(scope, work);
  });
  return new Promise<T>((resolve, reject) => {
    const off = scope.onCancel(() => {
      if (!started) reject(scope.error());
    });
    turn.then(
      result => {
        off();
        resolve(result as T);
      },
      error => {
        off();
        reject(error);
      }
    );
  });
}
