import type { JudgeTaskPriorityType } from "../judge/judge-queue.service";

export function makeSubmissionPriority(
  id: number,
  userPendingCount: number,
  userOccupiedTimeRecently: number,
  avgEveryUsersOccupiedTimeRecently: number,
  stdEveryUsersOccupiedTimeRecently: number,
  priorityType: JudgeTaskPriorityType
): number {
  // For any `x` > 1, the larger `x` is, the smaller `1 / x` will be,
  // so the less `priority - (1 / x)` will increase the priority

  // Let `x` = `t_1` * `t_2` * `t_3` ....
  // For some `t_i` in [1, `n_i`], the smaller `n_i`, the more significantly it will influence `x`
  // Because, with the same `t_i`, increasing other `t_j`s will influence `x` less significantly

  // A submission by a user with more pending submissions will have much lower priority
  const t1 = userPendingCount + 1;
  // Multiple submissions, with the same number of pending submissions by their users will be compared by their IDs
  // We should make ID much larger and increase much slower to prevent it from influencing the priority more than pending count
  const t2 = id + 1000000;

  // The more time the user occupied recently, the lower the submission' priority will be
  // We assume the total time occupied by each user fits normal distribution
  // k: the user's occupied time = average + k * standard deviation
  const k = (userOccupiedTimeRecently - avgEveryUsersOccupiedTimeRecently) / stdEveryUsersOccupiedTimeRecently;

  // We map k ** 2 to a number in [1, 100] to have a more significant influence than ID but less than pending count
  const T3_MIN = 1;
  const T3_MAX = 100;
  const K_MIN = 1;
  const K_MAX = 3;
  let t3: number;
  // All time occupied recently is by this user means no other users are submitting, no need to decrease its priority
  if (Number.isNaN(k) || k < K_MIN) t3 = T3_MIN;
  // If a user's occupied time > average + 3 * standard deviation, we decrease its priotity to the lowest
  else if (k > K_MAX) t3 = T3_MAX;
  // If a user's occupied time > average + 1 * standard deviation, we start decreasing its priority
  // (k ** 2 in [K_MIN ** 2, K_MAX ** 2] maps linearly to [T3_MIN, T3_MAX], so t3 increases continuously with k)
  else t3 = ((k ** 2 - K_MIN ** 2) / (K_MAX ** 2 - K_MIN ** 2)) * (T3_MAX - T3_MIN) + T3_MIN;

  // So a larger `x` will lead to a lower priority as we use `priority - (1 / x)`
  const x = t1 * t2 * t3;

  return priorityType - 1 / x;
}
