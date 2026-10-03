/**
 * Native sandbox waits occupy libuv workers until the child exits. Interaction
 * needs two live children per task, plus workers for filesystem setup/cleanup.
 * Check the environment before startup; changing it after Node starts is unsafe.
 */
export function assertExecutionCapacity(
  maxConcurrentTasks: number,
  workingDirectoryCount: number,
  configuredThreadPoolSize = process.env.UV_THREADPOOL_SIZE
): void {
  const slots = Math.min(maxConcurrentTasks, workingDirectoryCount);
  const threads = configuredThreadPoolSize === undefined ? 4 : Number(configuredThreadPoolSize);
  const required = slots * 2 + 2;
  if (!Number.isSafeInteger(threads) || threads < required || threads > 1024) {
    throw new Error(
      `UV_THREADPOOL_SIZE must be set before starting Node to an integer from ${required} to 1024 for ${slots} concurrent judge tasks (two sandbox waits per task and two filesystem workers). ` +
        `Set the service environment and restart the judge; the Node default of 4 is sufficient only for one task.`
    );
  }
}
