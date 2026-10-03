import { ContestRule } from "./contest.entity";

export interface ScoringSubmission {
  id: number;
  submitterId: number;
  contestProblemId: number;
  submitTime: Date;
  status: string;
  score: number;
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
}

// SYZOJ semantics: NOI last submission, IOI maximum score, ICPC accepted count and 20-minute penalties.
export function scoreContest(
  rule: ContestRule,
  startTime: Date,
  problems: { id: number; weight: number }[],
  submissions: ScoringSubmission[]
) {
  const users = new Map<
    number,
    { userId: number; score: number; penalty: number; problems: Record<number, ProblemScore> }
  >();
  for (const s of [...submissions].sort((a, b) => +a.submitTime - +b.submitTime || a.id - b.id)) {
    if (!users.has(s.submitterId))
      users.set(s.submitterId, { userId: s.submitterId, score: 0, penalty: 0, problems: {} });
    const row = users.get(s.submitterId);
    const prior = row.problems[s.contestProblemId];
    const seconds = Math.max(0, Math.floor((+s.submitTime - +startTime) / 1000));
    const minutes = Math.floor(seconds / 60);
    if (rule === "noi")
      row.problems[s.contestProblemId] = { score: s.score, status: s.status, submissionId: s.id, minutes, seconds };
    else if (rule === "ioi") {
      if (s.status !== "Pending" && (!prior || ((s.score ?? -1) >= (prior.score ?? -1) && prior.status !== "Accepted")))
        row.problems[s.contestProblemId] = { score: s.score, status: s.status, submissionId: s.id, minutes, seconds };
    } else {
      const entry = prior ?? { accepted: false, wrong: 0, pending: 0, minutes: 0, submissionId: s.id };
      if (!entry.accepted) {
        if (s.status === "Accepted") Object.assign(entry, { accepted: true, minutes, seconds, submissionId: s.id });
        else if (s.status === "Pending") entry.pending++;
        else if (s.status !== "CompilationError" && s.score != null) entry.wrong++;
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
        row.penalty = Math.max(row.penalty, entry.seconds);
      }
    }
  return [...users.values()]
    .sort((a, b) => b.score - a.score || a.penalty - b.penalty || a.userId - b.userId)
    .map((row, index, rows) => ({
      ...row,
      rank:
        index && rows[index - 1].score === row.score && rows[index - 1].penalty === row.penalty
          ? rows.findIndex(r => r.score === row.score && r.penalty === row.penalty) + 1
          : index + 1
    }));
}
