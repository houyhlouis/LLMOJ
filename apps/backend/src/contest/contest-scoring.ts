import type { ContestRule } from "./contest-rules";

export interface ScoringSubmission {
  id: number;
  submitterId: number;
  contestProblemId: number;
  submitTime: Date;
  status: string;
  score: number;
  /** The problem data version it was judged with; null for a result from before data versions */
  problemDataVersionId?: number | null;
  subtasks?: { score: number; fullScore: number }[];
}

export interface ProblemScore {
  score?: number;
  status?: string;
  submissionId: number;
  minutes: number;
  seconds?: number;
  accepted?: boolean;
  wrong?: number;
  pending?: number;
  subtasks?: { score: number; fullScore: number; submissionId: number }[];
  /** Strict IOI: how many data versions the user has results for, when more than one: only one version's count */
  versions?: number;
}

interface StrictGroup {
  entry: ProblemScore;
  exact: number;
  full: boolean[];
}

const invalidated = (status: string) => status === "Fake" || status === "Hacked";
const noAttemptPenalty = (status: string) =>
  ["CompilationError", "FileError", "ConfigurationError", "SystemError", "JudgementFailed", "Canceled"].includes(
    status
  );
const effectiveScore = (s: ScoringSubmission) => (invalidated(s.status) ? 0 : (s.score ?? 0));

// A subtask's earned score counts as full credit despite floating-point error in the judge's normalization
const FULL_CREDIT_TOLERANCE = 1e-9;
const fullCredit = (subtask: { score: number; fullScore: number }) =>
  subtask.score >= subtask.fullScore - FULL_CREDIT_TOLERANCE * Math.max(1, subtask.fullScore);

/**
 * NOI: latest; IOI: best; strict IOI: per-subtask best; ICPC: solved count and penalty.
 *
 * Strict IOI combines the best result of each subtask only across submissions judged with the same data version and
 * the same subtask weights: a changed problem can reorder or redefine subtasks without changing their weights, so
 * results of different versions never add up. The user's problem score is the best such combination. It's shown
 * rounded to whole points, and the rounded points rank; it counts as Accepted only when every subtask has full
 * credit, never because it rounds to 100.
 */
export function scoreContest(
  rule: ContestRule,
  startTime: Date,
  problems: { id: number; weight: number }[],
  submissions: ScoringSubmission[]
) {
  const problemIds = new Set(problems.map(problem => problem.id));
  const users = new Map<
    number,
    { userId: number; score: number; penalty: number; problems: Record<number, ProblemScore> }
  >();
  const getUser = (userId: number) => {
    if (!users.has(userId)) users.set(userId, { userId, score: 0, penalty: 0, problems: {} });
    return users.get(userId);
  };
  // Strict IOI: each group of compatible results (see below) with its exact score (percent) and which subtasks have
  // full credit; the group each user's problem shows; the data versions each user has results for
  const strictGroups = new Map<string, StrictGroup>();
  const strictChosen = new Map<string, StrictGroup>();
  const strictVersions = new Map<string, Set<string>>();
  for (const s of [...submissions].sort((a, b) => +a.submitTime - +b.submitTime || a.id - b.id)) {
    if (!problemIds.has(s.contestProblemId)) continue;
    const row = getUser(s.submitterId);
    const prior = row.problems[s.contestProblemId];
    const seconds = Math.max(0, Math.floor((+s.submitTime - +startTime) / 1000));
    const minutes = Math.floor(seconds / 60);
    const score = effectiveScore(s);
    const makeEntry = (earned = score): ProblemScore => ({
      score: earned,
      status: s.status,
      submissionId: s.id,
      minutes,
      seconds
    });
    if (rule === "noi") {
      row.problems[s.contestProblemId] = makeEntry();
    } else if (rule === "ioi") {
      if (s.status !== "Pending" && (!prior || (score >= (prior.score ?? -1) && prior.status !== "Accepted")))
        row.problems[s.contestProblemId] = makeEntry();
    } else if (rule === "strictioi") {
      if (s.status === "Pending" || invalidated(s.status) || noAttemptPenalty(s.status)) {
        if (!prior) row.problems[s.contestProblemId] = makeEntry(0);
        continue;
      }
      if (!s.subtasks?.length && score === 0) {
        if (!prior) row.problems[s.contestProblemId] = makeEntry(0);
        continue;
      }
      // Results without subtasks (from before they were recorded) are one subtask, fully credited only if Accepted
      const incoming = s.subtasks?.length ? s.subtasks : [{ score, fullScore: 100 }];
      if (
        incoming.some(
          subtask =>
            !Number.isFinite(subtask.fullScore) ||
            subtask.fullScore < 0 ||
            (subtask.score != null && !Number.isFinite(subtask.score))
        )
      )
        continue;
      const version = s.problemDataVersionId ?? null;
      const userProblem = `${s.submitterId}:${s.contestProblemId}`;
      // Never merge results of different data versions, or of different subtask layouts in one version
      const group = `${userProblem}:${version ?? "legacy"}:${incoming.map(subtask => subtask.fullScore).join(",")}`;
      if (!strictVersions.has(userProblem)) strictVersions.set(userProblem, new Set());
      strictVersions.get(userProblem).add(String(version));
      const previous = strictGroups.get(group);
      const merged = [...(previous?.entry.subtasks ?? [])];
      const full = [...(previous?.full ?? [])];
      let improved = false;
      incoming.forEach((subtask, index) => {
        const earned = Math.max(0, Math.min(subtask.fullScore, subtask.score ?? 0));
        const credited = s.subtasks?.length
          ? fullCredit({ score: earned, fullScore: subtask.fullScore })
          : s.status === "Accepted";
        if (
          !merged[index] ||
          earned > merged[index].score ||
          (earned === merged[index].score && credited && !full[index])
        ) {
          merged[index] = { score: earned, fullScore: subtask.fullScore, submissionId: s.id };
          full[index] = credited;
          improved = true;
        }
      });
      if (previous && !improved) continue;
      const totalFull = merged.reduce((sum, subtask) => sum + subtask.fullScore, 0);
      const exact = totalFull ? (merged.reduce((sum, subtask) => sum + subtask.score, 0) / totalFull) * 100 : 0;
      const accepted = totalFull > 0 && full.every(Boolean);
      const state: StrictGroup = {
        entry: {
          ...makeEntry(Math.round(exact)),
          status: accepted ? "Accepted" : exact > 0 ? "PartiallyCorrect" : s.status,
          subtasks: merged
        },
        exact,
        full
      };
      strictGroups.set(group, state);
      // The user's problem shows the best group, compared exactly; on a tie the earlier one stays
      const chosen = strictChosen.get(userProblem);
      if (!chosen || chosen === previous || exact > chosen.exact) {
        row.problems[s.contestProblemId] = state.entry;
        strictChosen.set(userProblem, state);
      }
    } else {
      const entry = prior ?? { accepted: false, wrong: 0, pending: 0, minutes: 0, submissionId: s.id };
      if (!entry.accepted) {
        if (s.status === "Accepted") Object.assign(entry, { accepted: true, minutes, seconds, submissionId: s.id });
        else if (s.status === "Pending") entry.pending++;
        else if (!noAttemptPenalty(s.status) && s.score != null) entry.wrong++;
      }
      row.problems[s.contestProblemId] = entry;
    }
  }
  for (const [userProblem, versions] of strictVersions)
    if (versions.size > 1 && strictChosen.has(userProblem))
      strictChosen.get(userProblem).entry.versions = versions.size;
  for (const row of users.values())
    for (const problem of problems) {
      const entry = row.problems[problem.id];
      if (!entry) continue;
      if (rule === "acm") {
        if (entry.accepted) {
          row.score++;
          row.penalty += entry.seconds + entry.wrong * 20 * 60;
        }
      } else {
        row.score += Math.round((entry.score ?? 0) * problem.weight);
        // Keep the established NOI/IOI second-precision tiebreak. Strict IOI shares score-only ranks.
        if (rule === "noi" || rule === "ioi") row.penalty = Math.max(row.penalty, entry.seconds);
      }
    }
  const rows = [...users.values()].sort((a, b) => b.score - a.score || a.penalty - b.penalty || a.userId - b.userId);
  // Equal score and penalty share the rank of the first of them
  let rank = 0;
  return rows.map((row, index) => {
    const previous = rows[index - 1];
    if (!previous || previous.score !== row.score || previous.penalty !== row.penalty) rank = index + 1;
    return { ...row, rank };
  });
}
