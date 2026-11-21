import { interactorLimits } from "./interaction/limits";

import { Checker, checkerMemory } from "../../checkers";

interface Limits {
  timeLimit?: number;
  memoryLimit?: number;
}

interface JudgeInfoLimits extends Limits {
  checker?: Checker;
  interactor?: Limits;
  manager?: Limits;
}

/** The limits of each role, and the most sandbox memory a testcase uses at once (MiB). */
export function testcaseResources(judgeInfo: JudgeInfoLimits, testcase?: Limits, subtask?: Limits) {
  const program = {
    timeLimit: testcase?.timeLimit || subtask?.timeLimit || judgeInfo.timeLimit,
    memoryLimit: testcase?.memoryLimit || subtask?.memoryLimit || judgeInfo.memoryLimit
  };
  // A Communication manager runs beside the contestant in each of two sequential stages.
  const helper = judgeInfo.manager || judgeInfo.interactor;
  const interactor = helper && interactorLimits(helper, program.timeLimit, judgeInfo.memoryLimit);
  const checker = judgeInfo.manager ? undefined : judgeInfo.checker;
  const checkerMemoryLimit = checker ? checkerMemory({ checker, memoryLimit: judgeInfo.memoryLimit }) : 0;
  return {
    program,
    interactor,
    checkerMemory: checkerMemoryLimit,
    peakMemory: Math.max((program.memoryLimit || 0) + (interactor?.memoryLimit || 0), checkerMemoryLimit)
  };
}

export type TestcaseResources = ReturnType<typeof testcaseResources>;
