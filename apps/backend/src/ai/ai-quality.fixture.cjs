/* Explicit synthetic quality state for mocks concerned with other service behavior.
   These receipts are only returned by test-local sandbox doubles. */
const assert = require("node:assert/strict");
const cpp = "#include <iostream>\nint main(){long long a,b;if(std::cin>>a>>b)std::cout<<a+b<<'\\n';}";
function qualityState(subtaskIds = [1]) {
  const target = { id: "misses_boundary", kind: "wrong", algorithm: "Boundary-assumption fixture solution",
    reason: "A legal boundary input disproves the assumption", subtasks: [...subtaskIds],
    construction: "Generate the legal boundary counterexample before random cases" };
  return {
    qualityPlan: { version: 1, correctAlgorithms: ["Exact direct fixture algorithm", "Independently derived fixture algorithm"],
      oracleMethod: "Exact exhaustive fixture oracle", smallInputStrategy: "Legal minimum, boundary and tiny random fixture inputs", targets: [target] },
    qualityArtifacts: { version: 1, smallMakeCode: cpp, oracleCode: cpp,
      alternatives: [{ id: "independent", code: cpp }],
      challenges: [{ id: target.id, code: cpp, kind: target.kind, subtasks: [...target.subtasks], reason: target.reason }] }
  };
}
function qualityReceipt(request, cases = request.cases) {
  const quality = request.quality;
  assert(quality, "traditional fixture must request the real quality gate");
  return { version: 1, fuzzPassed: quality.fuzzCases.length,
    alternativeCount: quality.alternatives.length, alternativesPassed: quality.alternatives.length * cases.length,
    challengeCount: quality.challenges.length, challengesKilled: quality.challenges.length, extraAttemptsUsed: 0,
    challengeResults: quality.challenges.map(target => {
      const index = cases.findIndex(item => target.subtasks.includes(item.subtask));
      assert(index >= 0, "each synthetic challenge needs an applicable final case");
      return { id: target.id, kind: target.kind, killedBy: index + 1, verdict: target.kind === "slow" ? "TLE" : "WA" };
    }) };
}
module.exports = { qualityState, qualityReceipt };
