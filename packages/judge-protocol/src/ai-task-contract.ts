/** Public task semantics, independent of a generated simulator or private test data. */
export type AiTaskMode = "batch" | "interactive_stdio" | "sequential_communication" | "persistent_duplex";
export interface AiTaskInterface {
  headers: { name: string; identity: string }[];
  functions: { name: string; signature: string; owner: "contestant" | "grader"; role: string }[];
}
export type AiTaskContract = {
  version: 1;
  interface: AiTaskInterface;
  roles: { name: string; permittedInformation: string[] }[];
  framing: string;
  scoring: { scope: "case" | "subtask"; reduction: "binary" | "sum" | "min" | "max"; metric: string };
} & (
  | { mode: "batch"; lifetime: "single_process" }
  | { mode: "interactive_stdio"; lifetime: "single_session" }
  | { mode: "sequential_communication"; lifetime: "two_fresh_processes" }
  | { mode: "persistent_duplex"; lifetime: "two_live_isolated_roles" }
);
export interface AiRunnerCapabilities {
  version: 1;
  modes: AiTaskMode[];
  lifetimes: AiTaskContract["lifetime"][];
  scoring: string[];
  compileLink: boolean;
  qualification: boolean;
  receipts: boolean;
}
/** No persistent duplex or cross-case communication-length reducer is implemented. */
export const AI_RUNNER_CAPABILITIES: AiRunnerCapabilities = {
  version: 1,
  modes: ["batch", "interactive_stdio", "sequential_communication"],
  lifetimes: ["single_process", "single_session", "two_fresh_processes"],
  scoring: ["case:binary"],
  compileLink: true,
  qualification: true,
  receipts: true
};
export function taskCapabilityGaps(contract: AiTaskContract, available?: AiRunnerCapabilities): string[] {
  const missing: string[] = [];
  if (available?.version !== 1) return ["runner_capabilities_v1"];
  if (!available.modes?.includes(contract.mode)) missing.push(`mode:${contract.mode}`);
  if (!available.lifetimes?.includes(contract.lifetime)) missing.push(`lifetime:${contract.lifetime}`);
  const scoring = `${contract.scoring.scope}:${contract.scoring.reduction}`;
  if (!available.scoring?.includes(scoring)) missing.push(`scoring:${scoring}`);
  for (const feature of ["compileLink", "qualification", "receipts"] as const)
    if (available[feature] !== true) missing.push(feature);
  return missing;
}

export function currentRunnerCapabilities(value: unknown): value is AiRunnerCapabilities {
  const c = value as AiRunnerCapabilities;
  return (
    c?.version === 1 &&
    c.compileLink === true &&
    c.qualification === true &&
    c.receipts === true &&
    Array.isArray(c.modes) &&
    AI_RUNNER_CAPABILITIES.modes.every(mode => c.modes.includes(mode)) &&
    Array.isArray(c.lifetimes) &&
    AI_RUNNER_CAPABILITIES.lifetimes.every(mode => c.lifetimes.includes(mode)) &&
    Array.isArray(c.scoring) &&
    c.scoring.includes("case:binary")
  );
}
