import { createHash } from "crypto";

import { autoMatchInputToOutput } from "../problem-type/common/auto-match-input-output";
import type { ProblemFileEntity } from "../problem/problem-file.entity";

/** Sum shares and GroupMul cardinality can change partial credit while preserving subtask totals. */
export function allocationReview(
  judgeInfo: { subtasks?: Array<{ scoringType?: string; points?: number; testcases?: Array<{ points?: number }> }> },
  allocation: { mode: string; allocations: Array<{ id: number; points: number; count: number; pointsPerCase: number }> }
) {
  if (!judgeInfo.subtasks?.length) return null;
  const changes = allocation.allocations.flatMap((next, index) => {
    const current = judgeInfo.subtasks[index];
    if (!current || current.scoringType === "GroupMin") return [];
    const previousCount = current.testcases?.length || 0;
    if (previousCount === next.count && !current.testcases?.some(c => c.points != null)) return [];
    return [
      {
        subtask: next.id,
        scoringType: current.scoringType || "Sum",
        previousCount,
        proposedCount: next.count,
        previousPoints: current.testcases?.map(c => c.points ?? null) || [],
        proposedPointsPerCase: (current.scoringType || "Sum") === "Sum" ? next.pointsPerCase : null
      }
    ];
  });
  if (!changes.length) return null;
  const review = { mode: allocation.mode, reason: "PARTIAL_CREDIT_ALLOCATION", changes };
  return {
    ...review,
    digest: createHash("sha256")
      .update(JSON.stringify({ current: judgeInfo.subtasks, allocation, review }))
      .digest("hex")
  };
}

/** The same automatic discovery as judging; staged AI generations are excluded by that shared matcher. */
export function automaticAllocationSnapshot<T extends { subtasks?: unknown }>(
  judgeInfo: T,
  files: ProblemFileEntity[],
  protocol: boolean
): { judgeInfo: Omit<T, "subtasks"> & { subtasks: ReturnType<typeof autoMatchInputToOutput> }; digest: string } {
  const subtasks = autoMatchInputToOutput(files, protocol);
  const names = new Set(
    subtasks
      .flatMap(subtask => subtask.testcases.flatMap(testcase => [testcase.inputFile, testcase.outputFile]))
      .filter(Boolean)
  );
  const identities = files
    .filter(file => names.has(file.filename))
    .map(file => ({ filename: file.filename, uuid: file.uuid }))
    .sort((a, b) => a.filename.localeCompare(b.filename));
  return {
    judgeInfo: { ...judgeInfo, subtasks },
    digest: createHash("sha256").update(JSON.stringify({ subtasks, identities })).digest("hex")
  };
}
