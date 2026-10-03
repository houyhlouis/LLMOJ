import { AiError } from "./ai.types";

export function allocateAiTestcases(subtasks: { id: number; points: number }[], requested: number) {
  if (!Number.isInteger(requested) || requested < 5 || requested > 1000 || !subtasks.length)
    throw new AiError("INVALID_TEST_COUNT");
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
  const allocations = subtasks.map((s, i) => ({
    id: s.id,
    points: s.points,
    count: (points[i] / divisor) * multiplier
  }));
  const cases = allocations.flatMap(s => Array.from({ length: s.count }, (_, i) => ({ subtask: s.id, seed: i + 1 })));
  return { requested, count, pointsPerCase: 100 / count, allocations, cases };
}
