import type { ContestRule } from "./contest-rules";

export interface ScoringSubmission {
  id: number;
  submitterId: number;
  contestProblemId: number;
  submitTime: Date;
  status: string;
  score: number;
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
}

const invalidated = (status: string) => status === "Fake" || status === "Hacked";
const noAttemptPenalty = (status: string) =>
  ["CompilationError", "FileError", "ConfigurationError", "SystemError", "JudgementFailed", "Canceled"].includes(
    status
  );
const effectiveScore = (s: ScoringSubmission) => (invalidated(s.status) ? 0 : s.score ?? 0);

/** NOI: latest; IOI: best; strict IOI: per-subtask best; ICPC: solved count and penalty. */
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
  const strictLayouts = new Map<string, ProblemScore>();
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
      // Never merge incompatible subtask layouts after an administrator changes judge settings.
      if (!s.subtasks?.length && score === 0) {
        if (!prior) row.problems[s.contestProblemId] = makeEntry(0);
        continue;
      }
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
      const layout = `${s.submitterId}:${s.contestProblemId}:${incoming.map(subtask => subtask.fullScore).join(",")}`;
      const priorLayout = strictLayouts.get(layout);
      const merged = [...(priorLayout?.subtasks ?? [])];
      let improved = false;
      incoming.forEach((subtask, index) => {
        const earned = Math.max(0, Math.min(subtask.fullScore, subtask.score ?? 0));
        if (!merged[index] || earned > merged[index].score) {
          merged[index] = { score: earned, fullScore: subtask.fullScore, submissionId: s.id };
          improved = true;
        }
      });
      const totalFull = merged.reduce((sum, subtask) => sum + subtask.fullScore, 0);
      const total = merged.reduce((sum, subtask) => sum + subtask.score, 0);
      const combined = totalFull ? Math.round((total / totalFull) * 100) : 0;
      const combinedEntry = {
        ...(improved || !priorLayout ? makeEntry(combined) : priorLayout),
        score: combined,
        status: combined === 100 ? "Accepted" : combined > 0 ? "PartiallyCorrect" : s.status,
        subtasks: merged
      };
      strictLayouts.set(layout, combinedEntry);
      if (!prior || combined > (prior.score ?? -1) || !prior.subtasks) row.problems[s.contestProblemId] = combinedEntry;
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
  return rows.map(row => ({
    ...row,
    rank: rows.findIndex(other => other.score === row.score && other.penalty === row.penalty) + 1
  }));
}
