/** Stable stored names; NOI is the traditional OI format. */
export const CONTEST_RULES = ["noi", "ioi", "acm", "strictioi"] as const;
export type ContestRule = (typeof CONTEST_RULES)[number];

export interface ContestRuleOptions {
  hackEnabled?: boolean;
  hackStartTime?: string;
  hackEndTime?: string;
  selfEvalEnabled?: boolean;
  /** Per participant across the whole contest, including unfinished attempts. */
  selfEvalMaxAttempts?: number;
}

export function isContestRule(rule: unknown): rule is ContestRule {
  return typeof rule === "string" && (CONTEST_RULES as readonly string[]).includes(rule);
}

export function contestHasBlindFeedback(rule: ContestRule) {
  return rule === "noi";
}

export function contestHasLiveScoreboard(rule: ContestRule) {
  return rule === "ioi" || rule === "acm";
}

export function contestHasDetailedSelfFeedback(rule: ContestRule) {
  return rule === "ioi" || rule === "strictioi";
}

export function normalizeContestRuleOptions(
  value: unknown,
  startTime: Date,
  endTime: Date,
  rule: ContestRule = "noi"
): ContestRuleOptions {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid rule options");
  const input = value as Record<string, unknown>;
  const output: ContestRuleOptions = {};
  const keys = ["hackEnabled", "hackStartTime", "hackEndTime", "selfEvalEnabled", "selfEvalMaxAttempts"];
  if (Object.keys(input).some(key => !keys.includes(key))) throw new Error("Unknown rule option");
  for (const key of ["hackStartTime", "hackEndTime"] as const) {
    if (input[key] == null || input[key] === "") continue;
    if (typeof input[key] !== "string" || !Number.isFinite(+new Date(input[key] as string)))
      throw new Error("Invalid hack window time");
    output[key] = new Date(input[key] as string).toISOString();
  }
  const hackStart = output.hackStartTime ? +new Date(output.hackStartTime) : +endTime;
  if (hackStart < +startTime || (output.hackEndTime && +new Date(output.hackEndTime) <= hackStart))
    throw new Error("Invalid hack window");
  for (const key of ["hackEnabled", "selfEvalEnabled"] as const) {
    if (input[key] == null) continue;
    if (typeof input[key] !== "boolean") throw new Error("Invalid feature setting");
    output[key] = input[key] as boolean;
  }
  if (input.selfEvalMaxAttempts != null) {
    if (
      typeof input.selfEvalMaxAttempts !== "number" ||
      !Number.isInteger(input.selfEvalMaxAttempts) ||
      input.selfEvalMaxAttempts < 1 ||
      input.selfEvalMaxAttempts > 1000
    )
      throw new Error("Self-evaluation quota must be an integer between 1 and 1000");
    output.selfEvalMaxAttempts = input.selfEvalMaxAttempts;
  }
  if (rule !== "noi") {
    delete output.selfEvalEnabled;
    delete output.selfEvalMaxAttempts;
  }
  return output;
}
