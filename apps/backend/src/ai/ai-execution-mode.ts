import { statSync } from "fs";

export type AiExecutionMode = "local" | "judges";

export const localRunnerSocket = () => process.env.HYHOJ_AI_RUNNER_SOCKET || "/opt/LLMOJ/data/judge/ai-runner.sock";

/** Where a job started on this server will run. Existing jobs keep the mode chosen at start. */
export function defaultAiExecutionMode(): AiExecutionMode {
  const forced = process.env.LLMOJ_AI_EXECUTION;
  if (forced === "local" || forced === "judges") return forced;
  try {
    return statSync(localRunnerSocket()).isSocket() ? "local" : "judges";
  } catch {
    return "judges";
  }
}
