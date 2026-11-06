import config from "./config";
import { ensureDirectoryEmpty } from "./utils";
import { Disposer } from "./posixUtils";
import { ExecutionScheduler, ExecutionReservation } from "./executionScheduler";
import { currentCancelScope } from "./cancelScope";

const availableWorkingDirectories = config.taskWorkingDirectories;

export const executionScheduler = new ExecutionScheduler(
  Math.min(availableWorkingDirectories.length, config.maxConcurrentTasks),
  config.memoryBudget,
  config.aiExecutionSlots
);

/**
 * We have limited working directories and memory for tasks, so we couldn't run too many tasks in the same time.
 *
 * This function accepts a task that requires a working directory, and executes the task when a working
 * directory and the memory its sandboxes may use (`reservation`) are available.
 *
 * A `Disposer` is passed to task callback to ensure any POSIX resources could be disposed safely even if
 * there're exceptions.
 */
export async function runTaskQueued<T>(
  reservation: ExecutionReservation,
  task: (taskWorkingDirectory: string, disposer?: Disposer) => Promise<T>
) {
  // Work of a canceled AI run leaves the queue, and never starts once admitted (review Part III, H09)
  const scope = currentCancelScope();
  const release = await executionScheduler.acquire(reservation, scope);
  if (scope?.isCanceled()) {
    release();
    throw scope.error();
  }
  const taskWorkingDirectory = availableWorkingDirectories.pop();
  const disposer = new Disposer();
  try {
    await ensureDirectoryEmpty(taskWorkingDirectory);
    return await task(taskWorkingDirectory, disposer);
  } finally {
    availableWorkingDirectories.push(taskWorkingDirectory);
    disposer.dispose();
    release();
  }
}
