/**
 * The limits an interactor (or a communication manager) runs with, for a test case with this time limit: at least the
 * test case's time limit, and its own memory limit or the problem's. The AI runner's protocol checks run through the
 * same judging code, and its execution profiles are compared with this (aiProfile.test.cjs).
 */
export function interactorLimits(
  interactor: { timeLimit?: number; memoryLimit?: number },
  timeLimit: number,
  problemMemoryLimit: number
) {
  return {
    timeLimit: Math.max(timeLimit, interactor.timeLimit || timeLimit),
    memoryLimit: interactor.memoryLimit || problemMemoryLimit
  };
}
