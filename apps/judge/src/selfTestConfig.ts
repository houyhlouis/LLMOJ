import path from "path";

/**
 * The configuration the self-test runs with: the judge's own, with directories of its own under `root` and without
 * the judge's key or local AI runner, so that it never touches a running judge's directories or credentials.
 */
export function deriveSelfTestConfig(original: Record<string, unknown>, root: string): Record<string, unknown> {
  return {
    ...original,
    // Never needed: the self-test doesn't connect to the server
    key: "A".repeat(40),
    dataStore: path.join(root, "data"),
    binaryCacheStore: path.join(root, "cache"),
    taskWorkingDirectories: [path.join(root, "work/1"), path.join(root, "work/2")],
    maxConcurrentTasks: 2,
    taskConsumingThreads: 1,
    aiRunnerSocket: null,
    aiGeneratedDirectory: null
  };
}
