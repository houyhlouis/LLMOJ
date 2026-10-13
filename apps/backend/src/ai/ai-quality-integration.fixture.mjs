/** Synthetic sum programs shared by isolated integration and offline fixture checks. */
import assert from "node:assert/strict";

export const sumQualityPlan = {
  version: 1,
  correctAlgorithms: [
    "Direct signed 64-bit addition",
    "Independent 128-bit accumulation with decimal formatting"
  ],
  oracleMethod: "Add or subtract unsigned magnitudes according to the operands' signs, then format the exact signed result.",
  smallInputStrategy: "Exercise zero, the official positive sample, negative inputs, cancellation and both numeric extremes, then random legal pairs in each subtask.",
  targets: [{
    id: "clamped-sum",
    kind: "wrong",
    algorithm: "Clamp the computed sum to the individual input range",
    reason: "The second subtask bounds each operand by 10^9, but the legal sum can reach 2*10^9 in magnitude.",
    subtasks: [2],
    construction: "Set both operands to 10^9, or both to -10^9. Preserve the individual input bounds."
  }]
};

export const sumMakeCode = String.raw`#include <iostream>
#include <random>
#include <string>
int main(int argc, char** argv) {
  if (argc < 3) return 1;
  int subtask = std::stoi(argv[1]), index = std::stoi(argv[2]);
  if ((subtask != 1 && subtask != 2) || index < 1) return 1;
  long long bound = subtask == 1 ? 10 : 1000000000LL, a, b;
  if (index == 1) { a = -bound; b = 0; }
  else if (index == 2) { a = bound; b = bound; }
  else if (index == 3) { a = -bound; b = -bound; }
  else if (index == 4) { a = bound; b = -bound; }
  else {
    std::random_device rd; const auto seed = rd(); std::mt19937_64 rnd(seed);
    std::uniform_int_distribution<long long> choose(-bound, bound);
    a = choose(rnd); b = choose(rnd);
  }
  std::cout << a << ' ' << b << '\n';
}`;

export const sumStdCode = String.raw`#include <iostream>
int main() {
  long long a, b;
  if (!(std::cin >> a >> b)) return 1;
  std::cout << a + b << '\n';
}`;

export const sumSmallMakeCode = String.raw`#include <iostream>
#include <random>
#include <string>
int main(int argc, char** argv) {
  if (argc < 3) return 1;
  int subtask = std::stoi(argv[1]), index = std::stoi(argv[2]);
  if ((subtask != 1 && subtask != 2) || index < 1) return 1;
  long long bound = subtask == 1 ? 10 : 1000000000LL, a, b;
  switch (index) {
    case 1: a = 0; b = 0; break;
    case 2: a = 1; b = 2; break;
    case 3: a = -bound; b = 0; break;
    case 4: a = bound; b = bound; break;
    case 5: a = -bound; b = -bound; break;
    case 6: a = bound; b = -bound; break;
    case 7: a = -1; b = 1; break;
    case 8: a = bound; b = -1; break;
    default: {
      std::random_device rd; const auto seed = rd(); std::mt19937_64 rnd(seed);
      std::uniform_int_distribution<long long> choose(-bound, bound);
      a = choose(rnd); b = choose(rnd);
    }
  }
  std::cout << a << ' ' << b << '\n';
}`;

export const sumOracleCode = String.raw`#include <iostream>
int main() {
  long long a, b;
  if (!(std::cin >> a >> b)) return 1;
  unsigned long long x = a < 0 ? -a : a, y = b < 0 ? -b : b;
  if ((a < 0) == (b < 0)) {
    if (a < 0 && x + y != 0) std::cout << '-';
    std::cout << x + y;
  } else if (x >= y) {
    if (a < 0 && x != y) std::cout << '-';
    std::cout << x - y;
  } else {
    if (b < 0) std::cout << '-';
    std::cout << y - x;
  }
  std::cout << '\n';
}`;

export const sumAlternativeCode = String.raw`#include <algorithm>
#include <iostream>
#include <string>
int main() {
  __int128 sum = 0;
  for (int i = 0; i < 2; ++i) {
    long long value;
    if (!(std::cin >> value)) return 1;
    sum += value;
  }
  bool negative = sum < 0;
  if (negative) sum = -sum;
  std::string digits;
  do { digits.push_back('0' + static_cast<int>(sum % 10)); sum /= 10; } while (sum);
  if (negative) digits.push_back('-');
  std::reverse(digits.begin(), digits.end());
  std::cout << digits << '\n';
}`;

export const sumChallengeCode = String.raw`#include <algorithm>
#include <iostream>
int main() {
  long long a, b;
  if (!(std::cin >> a >> b)) return 1;
  std::cout << std::clamp(a + b, -1000000000LL, 1000000000LL) << '\n';
}`;

const responses = [
  ["Independently analyze this programming problem", "qualityPlan", "quality-plan", sumQualityPlan],
  ["Generate ONLY small-make.cpp", "smallMakeCode", "small-make", sumSmallMakeCode],
  ["Generate ONLY oracle.cpp", "oracleCode", "oracle", sumOracleCode],
  ["Generate ONLY alternative.cpp", "alternativeCode", "alternative", sumAlternativeCode],
  ["Generate ONLY challenge.cpp", "challengeCode", "challenge", sumChallengeCode]
];

export function sumQualityResponse(prompt) {
  const entry = responses.find(([prefix]) => prompt.startsWith(prefix));
  if (!entry) return undefined;
  const [, field, stage, output] = entry;
  return { field, stage, output: typeof output === "string" ? output : structuredClone(output) };
}

export function assertSumQualityReceipt(quality, caseCount) {
  assert.equal(quality?.version, 1);
  assert.equal(quality.fuzzPassed, 64);
  assert.equal(quality.alternativeCount, 1);
  assert.equal(quality.alternativesPassed, caseCount);
  assert.equal(quality.challengeCount, 1);
  assert.equal(quality.challengesKilled, 1);
  assert.equal(quality.extraAttemptsUsed, 0, "the maximum cases already expose the clamped-sum defect");
  assert.equal(quality.challengeResults.length, 1);
  const witness = quality.challengeResults[0];
  assert.equal(witness.id, "clamped-sum");
  assert.equal(witness.kind, "wrong");
  assert.equal(witness.verdict, "WA");
  assert(Number.isSafeInteger(witness.killedBy) && witness.killedBy >= 1 && witness.killedBy <= caseCount);
}
