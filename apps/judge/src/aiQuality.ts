/** Independent small-case differential testing and adversarial full-case validation. */
import { AI_MALFORMED_OUTPUT } from "@libreoj/judge-protocol";

import { describe, detailsOf, FailureDetails, reclassify, within } from "./aiFailure";

export interface QualityCase {
  subtask: number;
  seed: number;
}

export interface QualityRequest {
  version: 1;
  fuzzCases: QualityCase[];
  smallMakeCode: string;
  oracleCode: string;
  alternatives: { id: string; code: string }[];
  challenges: { id: string; code: string; kind: "wrong" | "slow"; subtasks: number[]; reason: string }[];
  extraAttempts: number;
}

export type QualityVerdict = "WA" | "RE" | "TLE" | "MLE";
export type QualityData = Buffer | { path: string };

export interface QualityResult {
  version: 1;
  fuzzPassed: number;
  alternativeCount: number;
  alternativesPassed: number;
  challengeCount: number;
  challengesKilled: number;
  challengeResults: { id: string; kind: "wrong" | "slow"; killedBy: number; verdict: QualityVerdict }[];
  extraAttemptsUsed: number;
}

// A small counterexample is kept up to this size: it's evidence, never an exported case
const MAX_COUNTEREXAMPLE = 1024 * 1024;
const bounded = (data: Buffer) => (data.length > MAX_COUNTEREXAMPLE ? data.subarray(0, MAX_COUNTEREXAMPLE) : data);

export interface QualityEnvironment {
  execute: (name: string, input: QualityData, parameters?: string[]) => Promise<Buffer>;
  validate: (input: QualityData, subtask: number, seed: number, label: string) => Promise<void>;
  compare: (input: QualityData, actual: QualityData, expected: QualityData, label: string) => Promise<void>;
  checkCanceled: () => void;
  progress: (phase: string, completed: number, total: number) => void;
  customChecker: boolean;
  verifySample?: (name: string, input: QualityData, expected: QualityData, label: string) => Promise<void>;
}

export function qualitySources(quality: QualityRequest): [string, string][] {
  return [
    ["quality-small-make", quality.smallMakeCode],
    ["quality-oracle", quality.oracleCode],
    ...quality.alternatives.map((alternative, index): [string, string] => [`quality-alt-${index}`, alternative.code]),
    ...quality.challenges.map((challenge, index): [string, string] => [`quality-challenge-${index}`, challenge.code])
  ];
}

export function validateQuality(quality: QualityRequest, cases: QualityCase[], stdCode: string) {
  if (!quality || quality.version !== 1) throw new Error("Traditional generation requires quality verification v1");
  const subtasks = new Set(cases.map(testcase => testcase.subtask));
  if (!Array.isArray(quality.fuzzCases) || quality.fuzzCases.length < 64 || quality.fuzzCases.length > 1000)
    throw new Error("Quality verification requires 64–1000 small differential cases");
  const fuzzSubtasks = new Set<number>();
  const fuzzKeys = new Set<string>();
  for (const testcase of quality.fuzzCases) {
    if (
      !testcase ||
      !Number.isSafeInteger(testcase.subtask) ||
      !subtasks.has(testcase.subtask) ||
      !Number.isSafeInteger(testcase.seed) ||
      testcase.seed < 0 ||
      testcase.seed > 2147483647
    )
      throw new Error("Invalid quality differential subtask or seed");
    const key = `${testcase.subtask}:${testcase.seed}`;
    if (fuzzKeys.has(key)) throw new Error("Quality differential case seeds must be distinct in each subtask");
    fuzzKeys.add(key);
    fuzzSubtasks.add(testcase.subtask);
  }
  if ([...subtasks].some(subtask => !fuzzSubtasks.has(subtask)))
    throw new Error("Small differential cases must cover every subtask");
  if (!Array.isArray(quality.alternatives) || quality.alternatives.length < 1 || quality.alternatives.length > 3)
    throw new Error("Quality verification requires 1–3 alternative correct solutions");
  if (!Array.isArray(quality.challenges) || quality.challenges.length < 1 || quality.challenges.length > 4)
    throw new Error("Quality verification requires 1–4 executable challenges");
  const ids = new Set<string>();
  for (const candidate of [...quality.alternatives, ...quality.challenges]) {
    if (!candidate || typeof candidate.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(candidate.id))
      throw new Error("Invalid quality candidate ID");
    if (ids.has(candidate.id)) throw new Error("Quality candidate IDs must be distinct");
    ids.add(candidate.id);
  }
  for (const challenge of quality.challenges) {
    if (
      !["wrong", "slow"].includes(challenge.kind) ||
      !Array.isArray(challenge.subtasks) ||
      !challenge.subtasks.length ||
      new Set(challenge.subtasks).size !== challenge.subtasks.length ||
      challenge.subtasks.some(subtask => !subtasks.has(subtask)) ||
      typeof challenge.reason !== "string" ||
      !challenge.reason.trim() ||
      challenge.reason.length > 2000
    )
      throw new Error("Invalid quality challenge metadata");
  }
  if (!quality.challenges.some(challenge => challenge.kind === "wrong"))
    throw new Error("Quality verification requires at least one incorrect-solution challenge");
  if (!Number.isSafeInteger(quality.extraAttempts) || quality.extraAttempts < 0 || quality.extraAttempts > 32)
    throw new Error("Quality adversarial search is limited to 32 additional attempts");
  const independent = new Set([stdCode.trim()]);
  for (const [name, source] of qualitySources(quality)) {
    if (typeof source !== "string" || !source.trim() || Buffer.byteLength(source) > 256 * 1024)
      throw new Error(`Invalid ${name} source code size`);
    if (name !== "quality-small-make") {
      if (independent.has(source.trim())) throw new Error("Quality solutions must have independently written sources");
      independent.add(source.trim());
    }
  }
}

function verdictOf(error: unknown): QualityVerdict | null {
  const verdict = (error as { qualityVerdict?: QualityVerdict })?.qualityVerdict;
  return ["WA", "RE", "TLE", "MLE"].includes(verdict) ? verdict : null;
}

export class AiQuality {
  private fuzzPassed = 0;

  private alternativesPassed = 0;

  private extraAttemptsUsed = 0;

  // Each witness is an actual exported full-case index, so an extra case cannot erase prior evidence.
  private readonly killed = new Map<number, { killedBy: number; verdict: QualityVerdict }>();

  private readonly smallPassed = new Map<number, Set<number>>();

  private readonly searchedSeeds = new Set<string>();

  // Why the extra search stopped, if it did before every challenge was rejected
  private searchStoppedBy: "budget" | "capacity" = null;

  // A wrong challenge's first small failure, by challenge: not an exported witness, but evidence when it survives
  private readonly smallCounterexamples = new Map<number, FailureDetails>();

  constructor(
    private readonly request: QualityRequest,
    private readonly environment: QualityEnvironment
  ) {}

  async checkSample(input: QualityData, expected: QualityData, number: number) {
    const verify = async (name: string, label: string, candidate: string) =>
      await within(
        { role: name, candidate, expectedBasis: "official_sample", subject: `sample ${number}` },
        async () => {
          if (this.environment.verifySample) await this.environment.verifySample(name, input, expected, label);
          else {
            const actual = await this.environment.execute(name, input);
            await this.environment.compare(input, actual, expected, label);
          }
        }
      );
    for (const [index, alternative] of this.request.alternatives.entries()) {
      this.environment.checkCanceled();
      await verify(`quality-alt-${index}`, `alternative ${alternative.id} sample ${number}`, alternative.id);
    }
    for (const [index, challenge] of this.request.challenges.entries()) {
      this.environment.checkCanceled();
      try {
        await verify(`quality-challenge-${index}`, `challenge ${challenge.id} sample ${number}`, challenge.id);
      } catch (error) {
        if (!verdictOf(error)) throw error;
        throw reclassify(
          new Error(`Challenge ${challenge.id} failed official sample ${number}; it is not a valid challenge`),
          error,
          { kind: "invalid_challenge" }
        );
      }
    }
  }

  async runDifferential() {
    const checkedCheckerSubtasks = new Set<number>();
    for (const [caseIndex, testcase] of this.request.fuzzCases.entries()) {
      this.environment.checkCanceled();
      const { subtask, seed } = testcase;
      const subject = `differential case ${caseIndex + 1}`;
      await within(
        { phase: "quality-differential", subject, subtask, scenarioIndex: seed, classification: "author-private" },
        async () => await this.differentialCase(caseIndex, subtask, seed, subject, checkedCheckerSubtasks)
      );
      this.fuzzPassed++;
      this.environment.progress("quality-differential", this.fuzzPassed, this.request.fuzzCases.length);
    }
    for (const [index, challenge] of this.request.challenges.entries()) {
      const missing = challenge.subtasks.filter(subtask => !this.smallPassed.get(index)?.has(subtask));
      if (missing.length)
        throw describe(
          new Error(`Challenge ${challenge.id} has no passing small case in subtasks ${missing.join(", ")}`),
          {
            kind: "invalid_challenge",
            phase: "quality-differential",
            role: `quality-challenge-${index}`,
            candidate: challenge.id
          }
        );
    }
  }

  private async differentialCase(
    caseIndex: number,
    subtask: number,
    seed: number,
    subject: string,
    checkedCheckerSubtasks: Set<number>
  ) {
    const input = await this.environment.execute("quality-small-make", Buffer.from(`${subtask} ${seed}\n`), [
      String(subtask),
      String(seed)
    ]);
    await this.environment.validate(input, subtask, seed, subject);
    this.environment.checkCanceled();
    const expected = await within(
      { role: "quality-oracle", expectedBasis: "candidate_oracle", data: { input } },
      async () => {
        const output = await this.environment.execute("quality-oracle", input);
        await this.environment.compare(input, output, output, `oracle differential case ${caseIndex + 1}`);
        return output;
      }
    );
    if (this.environment.customChecker && !checkedCheckerSubtasks.has(subtask)) {
      const malformed = Buffer.from(AI_MALFORMED_OUTPUT);
      try {
        await this.environment.compare(input, malformed, expected, `malformed checker probe for subtask ${subtask}`);
        throw describe(new Error(`Checker accepted malformed output for subtask ${subtask}`), {
          kind: "checker_failure",
          role: "checker",
          data: { input, actual: malformed, expected }
        });
      } catch (error) {
        if (verdictOf(error) !== "WA") throw describe(error, { role: "checker" });
      }
      checkedCheckerSubtasks.add(subtask);
    }
    await within({ role: "std", expectedBasis: "candidate_oracle", data: { input, expected } }, async () => {
      const standard = await this.environment.execute("std", input);
      await this.environment.compare(input, standard, expected, `standard differential case ${caseIndex + 1}`);
    });
    for (const [index, alternative] of this.request.alternatives.entries()) {
      this.environment.checkCanceled();
      await within(
        {
          role: `quality-alt-${index}`,
          candidate: alternative.id,
          expectedBasis: "candidate_oracle",
          data: { input, expected }
        },
        async () => {
          const actual = await this.environment.execute(`quality-alt-${index}`, input);
          await this.environment.compare(
            input,
            actual,
            expected,
            `alternative ${alternative.id} differential case ${caseIndex + 1}`
          );
        }
      );
    }
    for (const [index, challenge] of this.request.challenges.entries()) {
      if (
        !challenge.subtasks.includes(subtask) ||
        (challenge.kind === "wrong" && this.smallPassed.get(index)?.has(subtask))
      )
        continue;
      this.environment.checkCanceled();
      const role = `quality-challenge-${index}`;
      let actual: Buffer;
      try {
        actual = await this.environment.execute(role, input);
        await this.environment.compare(input, actual, expected, `challenge ${challenge.id} differential preflight`);
        if (!this.smallPassed.has(index)) this.smallPassed.set(index, new Set());
        this.smallPassed.get(index).add(subtask);
      } catch (error) {
        // Small-case failures establish no exported adversarial evidence; infrastructure failure remains fatal.
        if (!verdictOf(error)) throw error;
        if (challenge.kind === "slow")
          throw reclassify(
            new Error(`Slow challenge ${challenge.id} failed small differential case ${caseIndex + 1}`),
            error,
            { kind: "invalid_challenge", role, candidate: challenge.id, data: { input, expected } }
          );
        // Kept as evidence in case it survives the exported cases
        if (!this.smallCounterexamples.has(index)) {
          const details = detailsOf(error) || {};
          this.smallCounterexamples.set(index, {
            ...details,
            kind: details.kind || "solver_disagreement",
            relation: "small_counterexample",
            phase: "quality-differential",
            role,
            candidate: challenge.id,
            subject,
            subtask,
            scenarioIndex: seed,
            verdict: verdictOf(error),
            expectedBasis: "candidate_oracle",
            classification: "author-private",
            data: {
              ...details.data,
              input: bounded(input),
              expected: bounded(expected),
              ...(actual ? { actual: bounded(actual) } : {})
            }
          });
        }
      }
    }
  }

  async checkCorrect(input: QualityData, answer: QualityData, subtask: number, label: string) {
    this.environment.checkCanceled();
    await within({ role: "std", expectedBasis: "reference_output" }, async () => {
      await this.environment.compare(input, answer, answer, `${label} standard output`);
    });
    for (const [index, alternative] of this.request.alternatives.entries()) {
      this.environment.checkCanceled();
      await within(
        {
          role: `quality-alt-${index}`,
          candidate: alternative.id,
          expectedBasis: "reference_output",
          data: { input, expected: answer }
        },
        async () => {
          const actual = await this.environment.execute(`quality-alt-${index}`, input);
          await this.environment.compare(
            input,
            actual,
            answer,
            `${label} alternative ${alternative.id} (subtask ${subtask})`
          );
        }
      );
    }
  }

  async findKills(input: QualityData, answer: QualityData, subtask: number) {
    const kills: { index: number; verdict: QualityVerdict }[] = [];
    for (const [index, challenge] of this.request.challenges.entries()) {
      if (this.killed.has(index) || !challenge.subtasks.includes(subtask)) continue;
      this.environment.checkCanceled();
      try {
        const actual = await this.environment.execute(`quality-challenge-${index}`, input);
        await this.environment.compare(input, actual, answer, `challenge ${challenge.id}`);
      } catch (error) {
        const verdict = verdictOf(error);
        if (!verdict) throw error;
        if (challenge.kind === "slow" && verdict !== "TLE" && verdict !== "MLE")
          throw reclassify(
            new Error(`Slow challenge ${challenge.id} is incorrect on a full case (${verdict}); expected TLE or MLE`),
            error,
            {
              kind: "invalid_challenge",
              role: `quality-challenge-${index}`,
              candidate: challenge.id,
              expectedBasis: "reference_output",
              data: { input, expected: answer }
            }
          );
        kills.push({ index, verdict });
      }
    }
    return kills;
  }

  recordCase(index: number, kills: { index: number; verdict: QualityVerdict }[]) {
    for (const kill of kills) this.killed.set(kill.index, { killedBy: index + 1, verdict: kill.verdict });
    this.alternativesPassed += this.request.alternatives.length;
    this.environment.progress("quality-adversarial", this.killed.size, this.request.challenges.length);
  }

  replacementIndex(cases: QualityCase[], subtask: number) {
    const protectedCases = new Set([...this.killed.values()].map(witness => witness.killedBy - 1));
    return cases.findIndex(
      (testcase, index) => testcase.subtask === subtask && testcase.seed > 2 && !protectedCases.has(index)
    );
  }

  nextSearchCase(cases: QualityCase[]): QualityCase | null {
    if (this.killed.size === this.request.challenges.length) return null;
    if (this.extraAttemptsUsed >= this.request.extraAttempts) {
      this.searchStoppedBy = "budget";
      return null;
    }
    const available = [
      ...new Set(
        this.request.challenges.flatMap((challenge, index) => (this.killed.has(index) ? [] : challenge.subtasks))
      )
    ].filter(subtask => this.replacementIndex(cases, subtask) >= 0);
    if (!available.length) {
      // No exported case could be replaced: the search didn't fail, it couldn't run
      this.searchStoppedBy = "capacity";
      return null;
    }
    const subtask = available[this.extraAttemptsUsed % available.length];
    // Additional case indices outside the original range; saved exported inputs reproduce witnesses.
    let seed = 1000000000 + this.extraAttemptsUsed;
    const used = new Set(cases.filter(testcase => testcase.subtask === subtask).map(testcase => testcase.seed));
    while (used.has(seed) || this.searchedSeeds.has(`${subtask}:${seed}`)) seed++;
    this.searchedSeeds.add(`${subtask}:${seed}`);
    this.extraAttemptsUsed++;
    this.environment.progress("quality-search", this.extraAttemptsUsed, this.request.extraAttempts);
    return { subtask, seed };
  }

  recordReplacement(index: number, kills: { index: number; verdict: QualityVerdict }[]) {
    // Replacement preserves the number of verified exported cases.
    for (const kill of kills) this.killed.set(kill.index, { killedBy: index + 1, verdict: kill.verdict });
    this.environment.progress("quality-adversarial", this.killed.size, this.request.challenges.length);
  }

  result(): QualityResult {
    const surviving = this.request.challenges.flatMap((challenge, index) => (this.killed.has(index) ? [] : [index]));
    if (surviving.length)
      throw describe(
        new Error(
          `Data quality insufficient: challenges survived (${surviving
            .map(index => this.request.challenges[index].id)
            .join(", ")})`
        ),
        {
          kind: "challenge_survived",
          phase: "quality-adversarial",
          ...(surviving.length === 1
            ? { role: `quality-challenge-${surviving[0]}`, candidate: this.request.challenges[surviving[0]].id }
            : {}),
          search: {
            attempts: this.extraAttemptsUsed,
            budget: this.request.extraAttempts,
            stoppedBy: this.searchStoppedBy || "budget"
          },
          related: surviving.flatMap(index =>
            this.smallCounterexamples.has(index) ? [this.smallCounterexamples.get(index)] : []
          )
        }
      );
    return {
      version: 1,
      fuzzPassed: this.fuzzPassed,
      alternativeCount: this.request.alternatives.length,
      alternativesPassed: this.alternativesPassed,
      challengeCount: this.request.challenges.length,
      challengesKilled: this.killed.size,
      challengeResults: this.request.challenges.map((challenge, index) => ({
        id: challenge.id,
        kind: challenge.kind,
        ...this.killed.get(index)
      })),
      extraAttemptsUsed: this.extraAttemptsUsed
    };
  }
}
