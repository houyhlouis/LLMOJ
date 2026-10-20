/** Independent small-case differential testing and adversarial full-case validation. */
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

  constructor(
    private readonly request: QualityRequest,
    private readonly environment: QualityEnvironment
  ) {}

  async checkSample(input: QualityData, expected: QualityData, number: number) {
    const verify = async (name: string, label: string) => {
      if (this.environment.verifySample) await this.environment.verifySample(name, input, expected, label);
      else {
        const actual = await this.environment.execute(name, input);
        await this.environment.compare(input, actual, expected, label);
      }
    };
    for (const [index, alternative] of this.request.alternatives.entries()) {
      this.environment.checkCanceled();
      await verify(`quality-alt-${index}`, `alternative ${alternative.id} sample ${number}`);
    }
    for (const [index, challenge] of this.request.challenges.entries()) {
      this.environment.checkCanceled();
      try {
        await verify(`quality-challenge-${index}`, `challenge ${challenge.id} sample ${number}`);
      } catch (error) {
        if (!verdictOf(error)) throw error;
        throw new Error(`Challenge ${challenge.id} failed official sample ${number}; it is not a valid challenge`);
      }
    }
  }

  async runDifferential() {
    const checkedCheckerSubtasks = new Set<number>();
    for (const [caseIndex, testcase] of this.request.fuzzCases.entries()) {
      this.environment.checkCanceled();
      const { subtask, seed } = testcase;
      const input = await this.environment.execute("quality-small-make", Buffer.from(`${subtask} ${seed}\n`), [
        String(subtask),
        String(seed)
      ]);
      await this.environment.validate(input, subtask, seed, `differential case ${caseIndex + 1}`);
      this.environment.checkCanceled();
      const expected = await this.environment.execute("quality-oracle", input);
      await this.environment.compare(input, expected, expected, `oracle differential case ${caseIndex + 1}`);
      if (this.environment.customChecker && !checkedCheckerSubtasks.has(subtask)) {
        try {
          await this.environment.compare(
            input,
            Buffer.from("\0LLMOJ_INVALID_OUTPUT_!@#\xff\n"),
            expected,
            `malformed checker probe for subtask ${subtask}`
          );
          throw new Error(`Checker accepted malformed output for subtask ${subtask}`);
        } catch (error) {
          if (verdictOf(error) !== "WA") throw error;
        }
        checkedCheckerSubtasks.add(subtask);
      }
      const standard = await this.environment.execute("std", input);
      await this.environment.compare(input, standard, expected, `standard differential case ${caseIndex + 1}`);
      for (const [index, alternative] of this.request.alternatives.entries()) {
        this.environment.checkCanceled();
        const actual = await this.environment.execute(`quality-alt-${index}`, input);
        await this.environment.compare(
          input,
          actual,
          expected,
          `alternative ${alternative.id} differential case ${caseIndex + 1}`
        );
      }
      for (const [index, challenge] of this.request.challenges.entries()) {
        if (
          !challenge.subtasks.includes(subtask) ||
          (challenge.kind === "wrong" && this.smallPassed.get(index)?.has(subtask))
        )
          continue;
        this.environment.checkCanceled();
        try {
          const actual = await this.environment.execute(`quality-challenge-${index}`, input);
          await this.environment.compare(input, actual, expected, `challenge ${challenge.id} differential preflight`);
          if (!this.smallPassed.has(index)) this.smallPassed.set(index, new Set());
          this.smallPassed.get(index).add(subtask);
        } catch (error) {
          // Small-case failures establish no exported adversarial evidence; infrastructure failure remains fatal.
          if (!verdictOf(error)) throw error;
          if (challenge.kind === "slow")
            throw new Error(`Slow challenge ${challenge.id} failed small differential case ${caseIndex + 1}`);
        }
      }
      this.fuzzPassed++;
      this.environment.progress("quality-differential", this.fuzzPassed, this.request.fuzzCases.length);
    }
    for (const [index, challenge] of this.request.challenges.entries()) {
      const missing = challenge.subtasks.filter(subtask => !this.smallPassed.get(index)?.has(subtask));
      if (missing.length)
        throw new Error(`Challenge ${challenge.id} has no passing small case in subtasks ${missing.join(", ")}`);
    }
  }

  async checkCorrect(input: QualityData, answer: QualityData, subtask: number, label: string) {
    this.environment.checkCanceled();
    await this.environment.compare(input, answer, answer, `${label} standard output`);
    for (const [index, alternative] of this.request.alternatives.entries()) {
      this.environment.checkCanceled();
      const actual = await this.environment.execute(`quality-alt-${index}`, input);
      await this.environment.compare(
        input,
        actual,
        answer,
        `${label} alternative ${alternative.id} (subtask ${subtask})`
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
          throw new Error(
            `Slow challenge ${challenge.id} is incorrect on a full case (${verdict}); expected TLE or MLE`
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
    if (this.killed.size === this.request.challenges.length || this.extraAttemptsUsed >= this.request.extraAttempts)
      return null;
    const available = [
      ...new Set(
        this.request.challenges.flatMap((challenge, index) => (this.killed.has(index) ? [] : challenge.subtasks))
      )
    ].filter(subtask => this.replacementIndex(cases, subtask) >= 0);
    if (!available.length) return null;
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
    const surviving = this.request.challenges.filter((challenge, index) => !this.killed.has(index));
    if (surviving.length)
      throw new Error(
        `Data quality insufficient: challenges survived (${surviving.map(challenge => challenge.id).join(", ")})`
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
