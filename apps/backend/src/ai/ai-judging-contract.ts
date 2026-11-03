/*
 * The judging contract an AI test-data job works within (review Part III, W02): how each program is compiled and run
 * (H03), and how the problem awards points (H04). It is resolved once, from the problem's judging settings, before the
 * job spends anything on programs; the AI runner checks the programs with it, and the judging settings the job
 * publishes give them the same.
 */
import {
  AI_DEFAULT_COMPILE_OPTIONS,
  AI_PROFILE_LIMITS,
  AI_PROFILE_VERSION,
  aiContractDigest,
  isAiCompileOptions,
  type AiCompileOptions,
  type AiExecutionProfiles,
  type AiRoleProfile
} from "@libreoj/judge-protocol";

import { AiError } from "./ai.types";

/* eslint-disable @typescript-eslint/no-explicit-any -- Judging settings are read from stored JSON and checked here. */

// The budget of the job's own programs: the generators, the validator and the brute-force oracle. The generator and
// validator are published only for Self Eval pretests, which run them with the same limits.
export const AI_AUXILIARY_LIMITS = Object.freeze({ timeLimitMs: 5000, memoryLimitMiB: 512 });

/** The explicit limits a checker, interactor or manager the AI job wrote is published (and checked) with. */
export function generatedHelperLimits(problem: { timeLimitMs: number; memoryLimitMiB: number }) {
  return { timeLimitMs: Math.max(5000, problem.timeLimitMs), memoryLimitMiB: Math.max(256, problem.memoryLimitMiB) };
}

export interface AiProfileInput {
  problemType: "Traditional" | "Interaction" | "Communication";
  // The problem's judging settings when the job started (its snapshot)
  judgeInfo: any;
  // The problem's limits and file I/O, as the job's plan keeps them
  timeLimitMs: number;
  memoryLimitMiB: number;
  fileIo?: { inputFilename: string; outputFilename: string } | null;
  // Whether the run has a checker program
  checker: boolean;
}

const program = (
  options: AiCompileOptions,
  limits: { timeLimitMs: number; memoryLimitMiB: number },
  cpu: AiRoleProfile["cpu"],
  extraSources: boolean,
  origin: AiRoleProfile["origin"]
): AiRoleProfile => ({
  language: "cpp",
  compileAndRunOptions: { ...options },
  timeLimitMs: limits.timeLimitMs,
  memoryLimitMiB: limits.memoryLimitMiB,
  cpu,
  testlib: true,
  extraSources,
  origin
});

// A helper program the problem already has, with its own compile options and limits (the problem's where it has none)
function problemHelper(
  helper: any,
  problem: { timeLimitMs: number; memoryLimitMiB: number },
  cpu: AiRoleProfile["cpu"],
  extraSources: boolean
): AiRoleProfile {
  const limits = {
    timeLimitMs: helper.timeLimit || problem.timeLimitMs,
    memoryLimitMiB: helper.memoryLimit || problem.memoryLimitMiB
  };
  if (
    !isAiCompileOptions(helper.compileAndRunOptions) ||
    limits.timeLimitMs > AI_PROFILE_LIMITS.timeLimitMs ||
    limits.memoryLimitMiB > AI_PROFILE_LIMITS.memoryLimitMiB ||
    (helper.sharedMemorySize != null &&
      !(
        Number.isSafeInteger(helper.sharedMemorySize) &&
        helper.sharedMemorySize >= 1 &&
        helper.sharedMemorySize <= AI_PROFILE_LIMITS.sharedMemorySize
      ))
  )
    throw new AiError("AI_HELPER_SETTINGS_UNSUPPORTED");
  return {
    ...program(helper.compileAndRunOptions, limits, cpu, extraSources, "problem"),
    ...(helper.sharedMemorySize ? { sharedMemorySize: helper.sharedMemorySize } : {})
  };
}

/**
 * The problem's own checker, interactor or manager, as the job reads it (readExistingAiHelpers): one with a file and a
 * language. Without one the job writes its own.
 */
export function problemHelperSettings(judgeInfo: any, role: "checker" | "interactor" | "manager") {
  const value = judgeInfo?.[role];
  if (!value?.filename || !value.language || (role === "checker" && value.type !== "custom")) return null;
  return value;
}

/**
 * The execution profile of each role. A helper the problem already has (custom checker, interactor, manager) keeps its
 * compile options and limits; one the job writes gets the defaults and generatedHelperLimits. Solutions run with the
 * problem's limits, the job's own programs with AI_AUXILIARY_LIMITS.
 */
export function resolveAiProfiles(input: AiProfileInput): AiExecutionProfiles {
  const problem = { timeLimitMs: input.timeLimitMs, memoryLimitMiB: input.memoryLimitMiB };
  const defaults = AI_DEFAULT_COMPILE_OPTIONS;
  const solution = program(defaults, problem, "UserProgram", true, "ai");
  const auxiliary = (cpu: AiRoleProfile["cpu"] = "UserProgram") =>
    program(defaults, AI_AUXILIARY_LIMITS, cpu, false, "ai");
  const roles: AiExecutionProfiles["roles"] = {
    std: input.problemType === "Traditional" && input.fileIo ? { ...solution, fileIo: { ...input.fileIo } } : solution,
    alternative: solution,
    challenge: solution,
    oracle: auxiliary(),
    generator: auxiliary(),
    validator: auxiliary()
  };
  if (input.checker) {
    const checker = problemHelperSettings(input.judgeInfo, "checker");
    roles.checker = checker
      ? problemHelper(checker, problem, "Checker", false)
      : program(defaults, generatedHelperLimits(problem), "Checker", false, "ai");
  }
  if (input.problemType !== "Traditional") {
    const role = input.problemType === "Interaction" ? "interactor" : "manager";
    const helper = problemHelperSettings(input.judgeInfo, role);
    roles[role] = helper
      ? problemHelper(helper, problem, "Interactor", true)
      : program(defaults, generatedHelperLimits(problem), "Interactor", true, "ai");
  }
  return { version: AI_PROFILE_VERSION, roles };
}

/** The settings a published checker gets: the problem's own as they were, or the generated one's explicit limits. */
export function publishedChecker(profiles: AiExecutionProfiles, previous: any, filename: string) {
  const profile = profiles.roles.checker;
  if (profile.origin === "problem") return { ...previous, filename };
  return {
    type: "custom",
    interface: "testlib",
    language: "cpp",
    compileAndRunOptions: { ...profile.compileAndRunOptions },
    filename,
    timeLimit: profile.timeLimitMs,
    memoryLimit: profile.memoryLimitMiB
  };
}

/** The settings a published interactor or manager gets, as publishedChecker. */
export function publishedProtocolHelper(
  profiles: AiExecutionProfiles,
  role: "interactor" | "manager",
  previous: any,
  filename: string
) {
  const profile = profiles.roles[role];
  if (profile.origin === "problem") return { ...previous, filename };
  return {
    interface: role === "interactor" ? "stdio" : "run-twice",
    language: "cpp",
    compileAndRunOptions: { ...profile.compileAndRunOptions },
    filename,
    timeLimit: profile.timeLimitMs,
    memoryLimit: profile.memoryLimitMiB
  };
}

/** Self Eval's limits of the published generator and validator: the ones the job checked them with. */
export function selfEvalLimits(profiles: AiExecutionProfiles) {
  const limits = (profile: AiRoleProfile) => ({ timeLimit: profile.timeLimitMs, memoryLimit: profile.memoryLimitMiB });
  return { generator: limits(profiles.roles.generator), validator: limits(profiles.roles.validator) };
}

const sameOptions = (a: AiCompileOptions, b: unknown) =>
  isAiCompileOptions(b) && a.compiler === b.compiler && a.std === b.std && a.O === b.O && a.m === b.m;

/**
 * How published judging settings would run each published program, compared with the profile the job checked it
 * with, the way the judge reads those settings: the differences, none if they agree. A checker with no limits of its own
 * gets the problem's; an interactor or manager gets at least the problem's time limit.
 */
export function profileDifferences(profiles: AiExecutionProfiles, judgeInfo: any, problemType: string): string[] {
  const differences: string[] = [];
  const { roles } = profiles;
  const time = judgeInfo.timeLimit;
  const memory = judgeInfo.memoryLimit;
  if (roles.std && (roles.std.timeLimitMs !== time || roles.std.memoryLimitMiB !== memory))
    differences.push("std limits");
  for (const subtask of judgeInfo.subtasks || [])
    if ((subtask.timeLimit && subtask.timeLimit !== time) || (subtask.memoryLimit && subtask.memoryLimit !== memory))
      differences.push("subtask limits");
  if (judgeInfo.checker?.type === "custom") {
    const { checker } = judgeInfo;
    const profile = roles.checker;
    if (!profile) differences.push("checker profile");
    else {
      if (!sameOptions(profile.compileAndRunOptions, checker.compileAndRunOptions)) differences.push("checker options");
      if (
        (checker.timeLimit || time) !== profile.timeLimitMs ||
        (checker.memoryLimit || memory) !== profile.memoryLimitMiB
      )
        differences.push("checker limits");
      if (checker.interface !== "testlib" || profile.cpu !== "Checker") differences.push("checker interface");
    }
  } else if (roles.checker) differences.push("checker unpublished");
  if (problemType !== "Traditional") {
    const role = problemType === "Interaction" ? "interactor" : "manager";
    const helper = judgeInfo[role];
    const profile = roles[role];
    if (!helper || !profile) differences.push(`${role} profile`);
    else {
      if (!sameOptions(profile.compileAndRunOptions, helper.compileAndRunOptions)) differences.push(`${role} options`);
      if (
        Math.max(time, helper.timeLimit || time) !== Math.max(time, profile.timeLimitMs) ||
        (helper.memoryLimit || memory) !== profile.memoryLimitMiB ||
        (helper.sharedMemorySize || undefined) !== profile.sharedMemorySize
      )
        differences.push(`${role} limits`);
    }
  }
  const recipe = judgeInfo.selfEval;
  if (recipe) {
    const io = recipe.standardFileIo;
    const expected = roles.std?.fileIo;
    if (io?.inputFilename !== expected?.inputFilename || io?.outputFilename !== expected?.outputFilename)
      differences.push("std file IO");
    for (const role of ["generator", "validator"] as const) {
      if (role === "validator" && !recipe.validatorFile) continue;
      const limits = recipe.limits?.[role];
      if (limits?.timeLimit !== roles[role]?.timeLimitMs || limits?.memoryLimit !== roles[role]?.memoryLimitMiB)
        differences.push(`${role} limits`);
    }
  }
  return differences;
}

/** What a role's profile is, in a job's result: for the helpers a problem judges with. */
export function helperSummaries(profiles: AiExecutionProfiles) {
  return (["checker", "interactor", "manager"] as const).flatMap(role => {
    const profile = profiles.roles[role];
    if (!profile) return [];
    const { compiler, std, O, m } = profile.compileAndRunOptions;
    return [
      {
        role,
        origin: profile.origin,
        options: `${compiler} -std=${std} -O${O}${m === "64" ? "" : ` -m${m}`}`,
        timeLimitMs: profile.timeLimitMs,
        memoryLimitMiB: profile.memoryLimitMiB
      }
    ];
  });
}

/* ------------------------------------------------------------------------------------------------------------------ */

export type AiScoringType = "Sum" | "GroupMin" | "GroupMul";

/** How a problem awards points: what the scoring digest covers. */
export interface AiScoringPolicy {
  version: 1;
  // Whether a submission that fails a sample gets no points
  runSamples: boolean;
  subtasks: {
    // Its full score, with automatic points worked out as the judge does
    points: number;
    scoringType: AiScoringType;
    // 0-based, as the judging settings store them
    dependencies: number[];
    // Its own limits, where they differ from the problem's
    timeLimit?: number;
    memoryLimit?: number;
  }[];
}

/** Why a job can't keep the problem's scoring as it is. */
export type AiScoringReason =
  | { code: "SUBTASK_COUNT"; current: number; proposed: number }
  | { code: "SUBTASK_POINTS"; subtask: number; current: number; proposed: number }
  | { code: "SUBTASK_ORDER" }
  // Settings bound to the cases a job replaces, or limits its checks can't reproduce
  | { code: "SUBTASK_LIMITS"; subtask: number }
  | { code: "CASE_LIMITS"; subtask: number }
  | { code: "CASE_POINTS"; subtask: number };

/** The scoring a problem's judging settings establish, as the job keeps it. */
export interface AiExistingScoring {
  policy: AiScoringPolicy;
  digest: string;
  // Each subtask's settings without its cases, as they are stored, for publishing them again
  settings: any[];
  // What regenerating the cases can't keep
  unsupported: AiScoringReason[];
}

const POINTS_TOLERANCE = 0.01;

// A copy of an object without some of its fields
function without<T extends object>(object: T, keys: string[]): T {
  const copy = { ...object };
  for (const key of keys) delete copy[key as keyof T];
  return copy;
}

// The judge's automatic points: what the subtasks without points share of what's left of 100
function effectivePoints(subtasks: { points?: number }[]) {
  const specified = subtasks.filter(subtask => subtask.points != null);
  const left = 100 - specified.reduce((sum, subtask) => sum + subtask.points, 0);
  const share = left / (subtasks.length - specified.length || 1);
  return subtasks.map(subtask => (subtask.points != null ? subtask.points : share));
}

/** The digest of a scoring policy: unchanged by regenerated cases that keep it. */
export function scoringDigest(policy: AiScoringPolicy): string {
  return aiContractDigest(policy);
}

/**
 * The scoring a problem's judging settings establish: none if they have no subtasks of their own (the judge then makes
 * one from the test data files, and there's no policy to keep).
 */
export function existingScoring(judgeInfo: any): AiExistingScoring | null {
  if (!Array.isArray(judgeInfo?.subtasks) || !judgeInfo.subtasks.length) return null;
  const { timeLimit, memoryLimit } = judgeInfo;
  const points = effectivePoints(judgeInfo.subtasks);
  const unsupported: AiScoringReason[] = [];
  const policy: AiScoringPolicy = {
    version: 1,
    runSamples: judgeInfo.runSamples === true,
    subtasks: judgeInfo.subtasks.map((subtask: any, index: number) => {
      const own = {
        ...(subtask.timeLimit && subtask.timeLimit !== timeLimit ? { timeLimit: subtask.timeLimit } : {}),
        ...(subtask.memoryLimit && subtask.memoryLimit !== memoryLimit ? { memoryLimit: subtask.memoryLimit } : {})
      };
      if (Object.keys(own).length) unsupported.push({ code: "SUBTASK_LIMITS", subtask: index + 1 });
      const cases = subtask.testcases || [];
      if (
        cases.some(
          (testcase: any) =>
            (testcase.timeLimit && testcase.timeLimit !== (subtask.timeLimit || timeLimit)) ||
            (testcase.memoryLimit && testcase.memoryLimit !== (subtask.memoryLimit || memoryLimit))
        )
      )
        unsupported.push({ code: "CASE_LIMITS", subtask: index + 1 });
      const scoringType: AiScoringType = subtask.scoringType || "Sum";
      if (scoringType === "Sum" && cases.some((testcase: any) => testcase.points != null))
        unsupported.push({ code: "CASE_POINTS", subtask: index + 1 });
      return {
        points: points[index],
        scoringType,
        dependencies: Array.isArray(subtask.dependencies) ? [...subtask.dependencies].sort((a, b) => a - b) : [],
        ...own
      };
    })
  };
  const settings = judgeInfo.subtasks.map((subtask: any) => without(subtask, ["testcases"]));
  return { policy, digest: scoringDigest(policy), settings, unsupported };
}

interface PlanSubtask {
  id: number;
  points: number;
}

/** The policy of subtasks the job planned itself: each worth its planned points, summed over its cases. */
export function plannedScoring(subtasks: PlanSubtask[], runSamples: boolean): AiScoringPolicy {
  return {
    version: 1,
    runSamples,
    subtasks: subtasks.map(subtask => ({ points: subtask.points, scoringType: "Sum", dependencies: [] }))
  };
}

/** How a plan's subtasks differ from the problem's: in order, ids 1, 2, …, with the same points. */
export function planDifferences(existing: AiExistingScoring, subtasks: PlanSubtask[]): AiScoringReason[] {
  const current = existing.policy.subtasks;
  if (current.length !== subtasks.length)
    return [{ code: "SUBTASK_COUNT", current: current.length, proposed: subtasks.length }];
  if (subtasks.some((subtask, index) => subtask.id !== index + 1)) return [{ code: "SUBTASK_ORDER" }];
  return subtasks.flatMap((subtask, index) =>
    Math.abs(subtask.points - current[index].points) > POINTS_TOLERANCE
      ? [
          {
            code: "SUBTASK_POINTS" as const,
            subtask: index + 1,
            current: current[index].points,
            proposed: subtask.points
          }
        ]
      : []
  );
}

/** What a job publishes: the policy and the subtask settings it publishes it with. */
export interface AiScoringDecision {
  // "kept": the problem's; "new": the plan's, for a problem without subtasks; "replaced": a change the owner approved
  status: "kept" | "new" | "replaced";
  policy: AiScoringPolicy;
  digest: string;
  previousDigest?: string;
  // Whether these are the problem's subtasks (their points are then the problem's)
  problemSubtasks: boolean;
  // Each subtask's settings without its cases
  settings: any[];
}

/** A change of scoring the job's owner must approve before the job goes on. */
export interface AiScoringReview {
  current: AiScoringPolicy;
  proposed: AiScoringPolicy;
  currentDigest: string;
  proposedDigest: string;
  reasons: AiScoringReason[];
}

/**
 * Decides the scoring a job publishes. The problem's own is kept when the plan's subtasks match it (their points then
 * come from it); otherwise the change needs the owner's approval of exactly the reviewed policies (`approval`), and
 * without it the result is the review. A problem without subtasks of its own gets the plan's.
 */
export function decideScoring(
  existing: AiExistingScoring | null,
  subtasks: PlanSubtask[],
  defaultRunSamples: boolean,
  approval?: { currentDigest: string; proposedDigest: string }
): { decision: AiScoringDecision } | { review: AiScoringReview } {
  const planned = plannedScoring(subtasks, defaultRunSamples);
  const plannedSettings = () => subtasks.map(subtask => ({ points: subtask.points, scoringType: "Sum" }));
  if (!existing)
    return {
      decision: {
        status: "new",
        policy: planned,
        digest: scoringDigest(planned),
        problemSubtasks: false,
        settings: plannedSettings()
      }
    };
  const differences = planDifferences(existing, subtasks);
  if (!differences.length && !existing.unsupported.length)
    return {
      decision: {
        status: "kept",
        policy: existing.policy,
        digest: existing.digest,
        problemSubtasks: true,
        settings: existing.settings
      }
    };
  // The problem's policy without what can't be kept, when the plan matches it; the plan's otherwise
  const proposed: AiScoringPolicy = differences.length
    ? planned
    : {
        ...existing.policy,
        subtasks: existing.policy.subtasks.map(subtask => without(subtask, ["timeLimit", "memoryLimit"]))
      };
  const proposedDigest = scoringDigest(proposed);
  if (approval?.currentDigest === existing.digest && approval.proposedDigest === proposedDigest)
    return {
      decision: {
        status: "replaced",
        policy: proposed,
        digest: proposedDigest,
        previousDigest: existing.digest,
        problemSubtasks: !differences.length,
        settings: differences.length
          ? plannedSettings()
          : existing.settings.map(subtask => without(subtask, ["timeLimit", "memoryLimit"]))
      }
    };
  return {
    review: {
      current: existing.policy,
      proposed,
      currentDigest: existing.digest,
      proposedDigest,
      reasons: [...differences, ...existing.unsupported]
    }
  };
}

/**
 * The subtasks a job publishes, for the traditional and protocol paths alike: each subtask's decided settings and its
 * new cases. `ids` are the plan's subtask IDs in order, as the cases name them; `testcase(index)` names case `index`'s
 * files.
 */
export function publishedSubtasks(
  decision: AiScoringDecision,
  ids: number[],
  cases: { subtask: number }[],
  testcase: (index: number) => Record<string, string>
) {
  if (ids.length !== decision.settings.length) throw new AiError("INVALID_TEST_PLAN");
  return decision.settings.map((settings, position) => ({
    ...settings,
    ...(settings.dependencies ? { dependencies: [...settings.dependencies] } : {}),
    testcases: cases.flatMap((item, index) => (item.subtask === ids[position] ? [testcase(index)] : []))
  }));
}
