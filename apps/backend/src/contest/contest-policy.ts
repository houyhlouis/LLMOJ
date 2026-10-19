import type { ContestEntity } from "./contest.entity";
import { contestHasBlindFeedback, contestHasDetailedSelfFeedback, contestHasLiveScoreboard } from "./contest-rules";

/*
 * What a contest shows to whom, and when. A contest's rule decides its secrecy: a running NOI contest shows
 * participants only whether their submissions compiled, Strict IOI keeps the scoreboard hidden but shows participants
 * their own results, and IOI and ACM have live scoreboards. Managers see everything at any time.
 *
 * These are plain functions of the contest, the time and whether the viewer manages the contest.
 * ContestAccessService adds the privilege checks on top of them.
 */

type Timing = Pick<ContestEntity, "startTime" | "endTime">;

export function contestStarted(contest: Timing, now = Date.now()) {
  return now >= +contest.startTime;
}

export function contestEnded(contest: Timing, now = Date.now()) {
  return now >= +contest.endTime;
}

/** Managers may open a contest's problems before it starts; everyone else from its start. */
export function contestProblemsOpen(contest: Timing, manager: boolean, now = Date.now()) {
  return manager || contestStarted(contest, now);
}

/** Managers may submit at any time; everyone else only while the contest runs. */
export function contestSubmissionsOpen(contest: Timing, manager: boolean, now = Date.now()) {
  return manager || (contestStarted(contest, now) && !contestEnded(contest, now));
}

/**
 * Whether the contest page shows how many attempted and solved each problem. Running NOI and Strict IOI contests
 * keep them hidden, and so does a contest that hides its statistics.
 */
export function contestStatisticsVisible(
  contest: Timing & Pick<ContestEntity, "rule" | "hideStatistics">,
  manager: boolean,
  now = Date.now()
) {
  return manager || contestEnded(contest, now) || (contestHasLiveScoreboard(contest.rule) && !contest.hideStatistics);
}

/**
 * Whether the scoreboard is open to anyone who may view scoreboards. A hidden scoreboard is open only to users with
 * the privilege to view hidden scoreboards.
 */
export function contestScoreboardOpen(
  contest: Timing & Pick<ContestEntity, "rule">,
  manager: boolean,
  now = Date.now()
) {
  return manager || contestEnded(contest, now) || contestHasLiveScoreboard(contest.rule);
}

/**
 * Whether a viewer sees everyone's submissions in the contest, rather than only their own: managers, everyone after
 * the end, and everyone during an ACM contest.
 */
export function contestSubmissionsPublic(
  contest: Timing & Pick<ContestEntity, "rule">,
  manager: boolean,
  now = Date.now()
) {
  return manager || contestEnded(contest, now) || contest.rule === "acm";
}

/** What a viewer may see of a contest submission. */
export function contestSubmissionVisibility(
  contest: Timing & Pick<ContestEntity, "rule">,
  submission: { submitterId: number; status: string },
  viewer: { manager: boolean; userId?: number },
  now = Date.now()
) {
  const own = viewer.userId === submission.submitterId;
  const code = viewer.manager || own;
  return {
    /** The submission at all */
    visible: contestSubmissionsPublic(contest, viewer.manager, now) || own,
    /** Its code */
    code,
    /** Its subtask and test case results */
    results: viewer.manager || contestEnded(contest, now) || (contestHasDetailedSelfFeedback(contest.rule) && code),
    /** The compiler's output: participants see it only when compilation failed */
    compile: code && (viewer.manager || submission.status === "CompilationError")
  };
}

/** A participant's own result on a problem, as the contest page shows it: in a running NOI contest, only whether it compiled. */
export function contestOwnResult<T extends { submissionId: number; status?: string }>(
  entry: T,
  contest: Timing & Pick<ContestEntity, "rule">,
  manager: boolean,
  now = Date.now()
): T | { submissionId: number; status: string } {
  if (contestHasBlindFeedback(contest.rule) && !manager && !contestEnded(contest, now))
    return {
      submissionId: entry.submissionId,
      status: entry.status === "CompilationError" || entry.status === "Pending" ? entry.status : "Compiled"
    };
  return entry;
}

/**
 * Whether a hack's input, messages and results stay with its hacker and the contest's managers: while a contest
 * without a live scoreboard hasn't ended.
 */
export function contestHackDetailsHidden(contest: Timing & Pick<ContestEntity, "rule">, now = Date.now()) {
  return !contestEnded(contest, now) && !contestHasLiveScoreboard(contest.rule);
}

/** Whether hacks may be made in the contest now, and if not, why. */
export function contestHackWindow(
  contest: Pick<ContestEntity, "rule" | "endTime" | "ruleOptions">,
  manager: boolean,
  now = Date.now()
): { allowed: boolean; reason?: string } {
  const options = contest.ruleOptions ?? {};
  if (options.hackEnabled !== true) return { allowed: false, reason: "Hacks are disabled for this contest" };
  if (manager) return { allowed: true };
  // Hidden-score formats cannot leak competitors' results through live hack attempts.
  if (now < +contest.endTime && !contestHasLiveScoreboard(contest.rule))
    return { allowed: false, reason: "Hacks open after the contest ends" };
  const begin = options.hackStartTime ? +new Date(options.hackStartTime) : +contest.endTime;
  const end = options.hackEndTime ? +new Date(options.hackEndTime) : Infinity;
  if (now < begin || now >= end) return { allowed: false, reason: "The hack window is closed" };
  return { allowed: true };
}
