import { useCallback, useEffect, useRef } from "react";

export interface PollOptions {
  /** Time from the end of one poll to the start of the next */
  intervalMs: number;
  /** The same in a hidden tab; `null` waits until the tab is shown again. By default 5 times `intervalMs`. */
  hiddenIntervalMs?: number | null;
}

/**
 * Polls with at most one request in flight. The next poll is scheduled only after the previous one settles, so a slow
 * reply can't be overtaken by a newer one. Changing `deps`, or unmounting, aborts the poll in flight: `run` gets the
 * signal and must not show anything it receives once it's aborted, so an answer to an earlier query never replaces the
 * current one. `first` is true for the first poll after `deps` changed. Returns a function that polls again at once (or
 * right after the poll in flight).
 */
export function usePoll(
  run: (signal: AbortSignal, first: boolean) => Promise<unknown>,
  deps: unknown[],
  options: PollOptions
) {
  const runRef = useRef(run);
  runRef.current = run;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const wake = useRef<() => void>(() => undefined);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>,
      busy = false,
      again = false,
      first = true;
    const tick = async () => {
      clearTimeout(timer);
      if (controller.signal.aborted) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      const isFirst = first;
      first = false;
      try {
        await runRef.current(controller.signal, isFirst);
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
      const { intervalMs, hiddenIntervalMs = intervalMs * 5 } = optionsRef.current;
      const delay = typeof document !== "undefined" && document.hidden ? hiddenIntervalMs : intervalMs;
      if (delay != null) timer = setTimeout(tick, delay);
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
