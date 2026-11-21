import { usePoll } from "@/utils/hooks/usePoll";

/**
 * Polls with at most one request in flight (review Part V, IV-11): `usePoll`, every `intervalMs`, and five times as
 * long in a hidden tab. Changing `deps` aborts the current request. Returns a function that polls again at once (or
 * right after the request in flight).
 */
export function useAiPoll(run: (signal: AbortSignal) => Promise<unknown>, deps: unknown[], intervalMs = 2000) {
  return usePoll(signal => run(signal), deps, { intervalMs });
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
