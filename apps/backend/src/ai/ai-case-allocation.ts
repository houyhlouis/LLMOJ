import { AiError } from "./ai.types";

/** A subtask given more cases than its points' share, so that the targets it lists get a case built for them. */
export interface AiCaseCapacity {
  subtask: number;
  from: number;
  to: number;
  targets: string[];
}

/** Coverage, never decimal denominators, sets the workload. Every subtask keeps min/max and target capacity. */
function allocateCoverage(
  subtasks: { id: number; points: number }[],
  requested: number,
  targets: { id: string; subtasks: number[] }[]
) {
  if (
    subtasks.some(s => !Number.isFinite(s.points) || s.points <= 0) ||
    Math.abs(subtasks.reduce((sum, s) => sum + s.points, 0) - 100) > 1e-6
  )
    throw new AiError("INVALID_SUBTASK_SCORES");
  const counts = new Map(subtasks.map(s => [s.id, 2]));
  const assigned = new Map<number, string[]>();
  for (const target of targets) {
    const applicable = target.subtasks.filter(id => counts.has(id));
    if (!applicable.length) throw new AiError("INVALID_TEST_PLAN");
    const id = applicable.reduce((best, candidate) => (counts.get(candidate) < counts.get(best) ? candidate : best));
    counts.set(id, counts.get(id) + 1);
    assigned.set(id, [...(assigned.get(id) || []), target.id]);
  }
  const required = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const count = Math.max(requested, required);
  if (count > 1000) throw new AiError("TEST_COUNT_COVERAGE_EXCEEDED");
  for (let i = required; i < count; i++) {
    const id = subtasks.reduce((best, s) => (counts.get(s.id) < counts.get(best) ? s.id : best), subtasks[0].id);
    counts.set(id, counts.get(id) + 1);
  }
  const allocations = subtasks.map(s => ({
    id: s.id,
    points: s.points,
    count: counts.get(s.id),
    pointsPerCase: s.points / counts.get(s.id)
  }));
  return {
    mode: "coverage" as const,
    requested,
    count,
    pointsPerCase: null as number | null,
    allocations,
    cases: allocations.flatMap(s => Array.from({ length: s.count }, (_, i) => ({ subtask: s.id, seed: i + 1 }))),
    capacity: [...assigned].map(([subtask, ids]) => ({ subtask, from: 2, to: counts.get(subtask), targets: ids }))
  };
}

/**
 * The cases of each subtask: in proportion to the subtasks' points (each case then has the same share of the points),
 * at least `requested`. With the quality plan's `targets` (review Part III, W05): a target whose subtasks all have
 * fewer than 3 cases (1 is the minimum case, 2 the maximum, 3 on are built for targets and can be replaced) would never
 * get a case built for it, nor a case to replace: its subtask with the most cases gets one case for each such target.
 * A subtask's points don't change (its cases share them), so only the per-case share does; `capacity` says where.
 */
export function allocateAiTestcases(
  subtasks: { id: number; points: number }[],
  requested: number,
  targets: { id: string; subtasks: number[] }[] = [],
  mode: "coverage" | "score_ratio" = "score_ratio"
) {
  if (!Number.isInteger(requested) || requested < 5 || requested > 1000 || !subtasks.length)
    throw new AiError("INVALID_TEST_COUNT");
  if (new Set(subtasks.map(s => s.id)).size !== subtasks.length) throw new AiError("INVALID_TEST_PLAN");
  if (mode === "coverage") return allocateCoverage(subtasks, requested, targets);
  const scale = 1000000;
  const points = subtasks.map(s => Math.round(s.points * scale));
  if (
    subtasks.some(
      (s, i) => !Number.isFinite(s.points) || s.points <= 0 || Math.abs(points[i] / scale - s.points) > 1e-8
    ) ||
    points.reduce((a, b) => a + b, 0) !== 100 * scale
  )
    throw new AiError("INVALID_SUBTASK_SCORES");
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const divisor = points.reduce(gcd);
  const unit = (100 * scale) / divisor;
  const count = Math.ceil(requested / unit) * unit;
  if (count > 1000) throw new AiError("TEST_COUNT_RATIO_UNREPRESENTABLE");
  const multiplier = count / unit;
  const counts = new Map(subtasks.map((s, i) => [s.id, (points[i] / divisor) * multiplier]));
  // The targets without a case of their own, by the subtask that gets cases for them
  const assigned = new Map<number, string[]>();
  for (const target of targets) {
    const applicable = target.subtasks.filter(id => counts.has(id));
    if (!applicable.length || applicable.some(id => counts.get(id) >= 3)) continue;
    const subtask = applicable.reduce((best, id) => (counts.get(id) > counts.get(best) ? id : best));
    assigned.set(subtask, [...(assigned.get(subtask) || []), target.id]);
  }
  const capacity: AiCaseCapacity[] = [];
  for (const [subtask, ids] of assigned) {
    const from = counts.get(subtask);
    const to = Math.max(from, 2 + ids.length);
    if (to === from) continue;
    counts.set(subtask, to);
    capacity.push({ subtask, from, to, targets: ids });
  }
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  if (total > 1000) throw new AiError("TEST_COUNT_RATIO_UNREPRESENTABLE");
  const allocations = subtasks.map(s => ({
    id: s.id,
    points: s.points,
    count: counts.get(s.id),
    pointsPerCase: s.points / counts.get(s.id)
  }));
  const cases = allocations.flatMap(s => Array.from({ length: s.count }, (_, i) => ({ subtask: s.id, seed: i + 1 })));
  return {
    mode,
    requested,
    count: total,
    // The share of each case, when they all have the same
    pointsPerCase: capacity.length ? null : 100 / count,
    allocations,
    cases,
    capacity
  };
}
