import { useCallback, useEffect, useRef } from "react";

/**
 * Polls with at most one request in flight (review Part V, IV-11). The next request is scheduled only after the
 * previous one settles, so a slow reply can't be overtaken by a newer one; changing `deps` aborts the current request.
 * Returns a function that polls again at once (or right after the request in flight).
 */
export function useAiPoll(run: (signal: AbortSignal) => Promise<unknown>, deps: unknown[], intervalMs = 2000) {
  const runRef = useRef(run);
  runRef.current = run;
  const wake = useRef<() => void>(() => undefined);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>,
      busy = false,
      again = false;
    const tick = async () => {
      clearTimeout(timer);
      if (controller.signal.aborted) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        await runRef.current(controller.signal);
      } catch {
        // `run` reports its own errors; polling continues
      }
      busy = false;
      if (controller.signal.aborted) return;
      if (again) {
        again = false;
        void tick();
        return;
      }
      // A hidden tab polls less often
      timer = setTimeout(tick, typeof document !== "undefined" && document.hidden ? intervalMs * 5 : intervalMs);
    };
    wake.current = () => void tick();
    const visible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", visible);
    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      wake.current = () => undefined;
    };
  }, deps);
  return useCallback(() => wake.current(), []);
}

/** Keeps the newest revision of each job, so an older reply can't move a job's state back. */
export function newestRevisions<T extends { id: string; revision: number }>(known: Map<string, T>, rows: T[]) {
  return rows.map(row => {
    const previous = known.get(row.id);
    if (previous && previous.revision > row.revision) return previous;
    known.set(row.id, row);
    return row;
  });
}
