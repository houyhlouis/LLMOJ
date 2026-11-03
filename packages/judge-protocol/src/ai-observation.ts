/*
 * Typed observations of failed AI program runs (review Part III, H01/W01). The judge captures them, with the exact
 * bytes involved, before it cleans up a run's workspace; the backend keeps them with their evidence for the job's owner.
 *
 * A judge machine is trusted to run programs, not to write the backend's records: the backend accepts only what
 * `parseAiRunFailure` accepts, and reads evidence only by the names this module allows.
 */
import { TextDecoder } from "util";

export const AI_FAILURE_KINDS = [
  // A program didn't compile
  "compile_error",
  // The input validator rejected an input (a sample's, or one a generator made)
  "validator_rejection",
  // A program's output differs from the output it's compared with (see `expectedBasis`)
  "solver_disagreement",
  "runtime_error",
  "time_limit",
  "memory_limit",
  "output_limit",
  // A checker crashed, gave no valid verdict, or accepted malformed output
  "checker_failure",
  // A challenge program isn't the realistic wrong or slow attempt it should be (e.g. it fails an official sample)
  "invalid_challenge",
  // A wrong or slow challenge passed every exported case
  "challenge_survived",
  // An adversarial input was found but no case could be replaced with it
  "insufficient_case_capacity",
  // The run used its whole execution budget
  "budget_exhausted",
  // Storage, disk space, the sandbox itself or the connection: not the programs
  "infrastructure_error",
  "canceled",
  // A judge machine too old to classify its failures (judge protocol version 5 or earlier)
  "unclassified"
] as const;
export type AiFailureKind = (typeof AI_FAILURE_KINDS)[number];

export const AI_ARTIFACT_ROLES = ["input", "actual", "expected", "diagnostics"] as const;
export type AiArtifactRole = (typeof AI_ARTIFACT_ROLES)[number];

// Who may see an artifact's content: a statement's sample, the author's own material, or (part of) hidden test data
export const AI_ARTIFACT_CLASSIFICATIONS = ["public", "author-private", "hidden-test"] as const;
export type AiArtifactClassification = (typeof AI_ARTIFACT_CLASSIFICATIONS)[number];

// What an output was compared with. Only an official sample is authoritative; the others are other programs' outputs.
export const AI_EXPECTED_BASES = ["official_sample", "candidate_oracle", "reference_output"] as const;
export type AiExpectedBasis = (typeof AI_EXPECTED_BASES)[number];

export const AI_FAILURE_VERDICTS = ["WA", "RE", "TLE", "MLE", "OLE"] as const;
export type AiFailureVerdict = (typeof AI_FAILURE_VERDICTS)[number];

export const AI_EXECUTION_STATUSES = [
  "Unknown",
  "OK",
  "TimeLimitExceeded",
  "MemoryLimitExceeded",
  "RuntimeError",
  "Cancelled",
  "OutputLimitExceeded"
] as const;

export const AI_EVIDENCE_LIMITS = Object.freeze({
  // Observations of one run: the one that ended it and related ones (e.g. small counterexamples of surviving
  // challenges)
  observations: 8,
  // Bytes kept of one artifact, and of all of a run's. A larger artifact keeps its start (`size < originalSize`).
  artifactBytes: 16 * 1024 * 1024,
  runBytes: 64 * 1024 * 1024,
  // Bytes of an artifact shown as its preview
  previewBytes: 2048,
  summary: 2000,
  label: 200
});

/** An artifact kept with an observation: the bytes as the programs read or wrote them. */
export interface AiArtifactRef {
  // Its file among the run's evidence: "<observation index>.<role>"
  name: string;
  role: AiArtifactRole;
  classification: AiArtifactClassification;
  // The bytes kept, and their SHA-256
  size: number;
  sha256: string;
  // The artifact's whole size: more than `size` when only its start was kept
  originalSize: number;
  // Its first bytes as text (see `textPreview`)
  preview: string;
  binary: boolean;
}

/** How a program run ended, as the sandbox measured it. */
export interface AiExecutionMeasure {
  status: (typeof AI_EXECUTION_STATUSES)[number];
  exitCode?: number;
  termination?: "exited" | "signaled";
  timeMs?: number;
  memoryBytes?: number;
  timeLimitMs?: number;
  memoryLimitBytes?: number;
}

/** Where an output first differs from what it was compared with, as text (or bytes) compares them. */
export interface AiOutputDifference {
  unit: "token" | "line" | "byte";
  // The token or line number (from 1), or the byte offset (from 0)
  index: number;
  actualLine?: number;
  expectedLine?: number;
  // Short excerpts; empty where an output has ended
  actual: string;
  expected: string;
}

export interface AiFailureObservation {
  kind: AiFailureKind;
  // Whether it ended the run. A related observation (a small counterexample of a challenge that survived) didn't.
  fatal: boolean;
  relation?: "small_counterexample";
  // The runner's phase, e.g. "compile-make", "validate-samples", "quality-differential", "generate"
  phase: string;
  // The program whose behaviour failed: "make", "std", "checker", "validator", "quality-oracle", "quality-alt-0", …
  role?: string;
  // An alternative's or a challenge's ID
  candidate?: string;
  // What was being checked, e.g. "sample 2" or "case 3 (subtask 1, case index 3)"
  subject?: string;
  subtask?: number;
  // The case index a generator was run with. It's not a seed: generators draw fresh randomness each time, so only
  // the kept input reproduces a failure.
  scenarioIndex?: number;
  verdict?: AiFailureVerdict;
  expectedBasis?: AiExpectedBasis;
  execution?: AiExecutionMeasure;
  difference?: AiOutputDifference;
  // challenge_survived: the extra search for adversarial cases, and why it stopped (its budget, or no case that
  // could be replaced)
  search?: { attempts: number; budget: number; stoppedBy: "budget" | "capacity" };
  summary: string;
  artifacts: AiArtifactRef[];
  // Why some or all of its evidence wasn't kept
  evidenceError?: string;
}

/** Identifies how a run's programs were built and run. */
export interface AiExecutionProfile {
  // SHA-256 of the rest
  hash: string;
  architecture: string;
  compiler: string;
  auxiliary: { timeLimitMs: number; memoryLimitMiB: number };
  solution: { timeLimitMs: number; memoryLimitMiB: number };
  oracle: { timeLimitMs: number; memoryLimitMiB: number };
  checker: string;
  // SHA-256 of the run's execution profiles (see ai-profile.ts); absent from judges of protocol version 6
  executionProfiles?: string;
}

/** A failed AI run: what failed, the sources and limits it ran with, and its evidence. */
export interface AiRunFailure {
  schemaVersion: 2;
  // A new UUID for each run of the local AI runner; the task ID on a judge machine
  attemptId: string;
  operation: "generate" | "validate-reference";
  // SHA-256 of each program's source, by role (and of each extra source file, by "file:<name>")
  sourceHashes: Record<string, string>;
  profile: AiExecutionProfile;
  // The first is the one that ended the run
  observations: AiFailureObservation[];
}

export const AI_EVIDENCE_FILE = /^([0-7])\.(input|actual|expected|diagnostics)$/;
export const aiEvidenceFileName = (observation: number, role: AiArtifactRole) => `${observation}.${role}`;

// Bytes of an incomplete UTF-8 sequence at the end of `bytes` (cut off by a limit)
function incompleteTail(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return length > back ? back : 0;
  }
  return 0;
}

/**
 * The start of `data` as text to show: control characters (other than tabs and line feeds) escaped as `\xNN`, and
 * carriage returns as `\r`, so that a CRLF difference is visible. Data that doesn't look like text is shown as hex
 * (`hexLimit` bytes of it). `bytes` is how many bytes are shown: the next part starts there. `plain` leaves out terminal
 * colours (a compiler's diagnostics); the bytes kept still have them.
 */
export function textPreview(
  data: Uint8Array,
  limit: number = AI_EVIDENCE_LIMITS.previewBytes,
  hexLimit = 512,
  plain = false
) {
  const bytes = data.subarray(0, limit);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text: string | null = null;
  const shown = data.length > limit ? bytes.length - incompleteTail(bytes) : bytes.length;
  try {
    text = decoder.decode(bytes.subarray(0, shown));
    // eslint-disable-next-line no-control-regex
    if (plain) text = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  } catch {
    text = null;
  }
  // eslint-disable-next-line no-control-regex
  const control = text == null ? 0 : (text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g) || []).length;
  if (text == null || control > Math.max(4, text.length / 10)) {
    const hex: string[] = [];
    for (let offset = 0; offset < Math.min(bytes.length, hexLimit); offset += 16)
      hex.push(
        `${offset.toString(16).padStart(8, "0")}  ${Array.from(
          bytes.subarray(offset, Math.min(offset + 16, hexLimit)),
          byte => byte.toString(16).padStart(2, "0")
        ).join(" ")}`
      );
    return { text: hex.join("\n"), binary: true, bytes: Math.min(bytes.length, hexLimit) };
  }
  return {
    text: text
      .replace(/\r/g, "\\r")
      // eslint-disable-next-line no-control-regex
      .replace(
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
        char => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`
      ),
    binary: false,
    bytes: shown
  };
}

// The builtin comparisons (see the judge's builtin checkers), as far as finding the first difference goes
export type AiOutputComparison =
  | { type: "tokens" | "lines"; caseSensitive: boolean }
  | { type: "integers" | "binary" }
  | { type: "floats"; precision: number };

const isSpace = (byte: number) => byte === 32 || (byte >= 9 && byte <= 13);
const EXCERPT = 120;

function excerpt(data: Uint8Array, start: number, end: number) {
  const { text } = textPreview(data.subarray(start, Math.min(end, start + EXCERPT)), EXCERPT);
  return end - start > EXCERPT ? `${text}…` : text;
}

// Tokens (or lines) one at a time, with the line each starts on
function* units(data: Uint8Array, lines: boolean) {
  let position = 0;
  let line = 1;
  while (position < data.length) {
    if (lines) {
      let end = position;
      while (end < data.length && data[end] !== 10) end++;
      let trimmed = end;
      while (trimmed > position && isSpace(data[trimmed - 1])) trimmed--;
      yield { start: position, end: trimmed, line };
      position = end + 1;
      line++;
    } else {
      while (position < data.length && isSpace(data[position])) {
        if (data[position] === 10) line++;
        position++;
      }
      if (position >= data.length) return;
      const start = position;
      while (position < data.length && !isSpace(data[position])) position++;
      yield { start, end: position, line };
    }
  }
}

function sameUnit(
  actual: Uint8Array,
  a: { start: number; end: number },
  expected: Uint8Array,
  b: { start: number; end: number },
  comparison: AiOutputComparison
) {
  const left = Buffer.from(actual.buffer, actual.byteOffset + a.start, a.end - a.start).toString("utf8");
  const right = Buffer.from(expected.buffer, expected.byteOffset + b.start, b.end - b.start).toString("utf8");
  if (comparison.type === "floats") {
    const x = Number(left);
    const y = Number(right);
    if (left.trim() && right.trim() && Number.isFinite(x) && Number.isFinite(y)) {
      const eps = 10 ** -comparison.precision;
      return Math.abs(x - y) <= eps || Math.abs(x - y) <= eps * Math.abs(y);
    }
  }
  if ("caseSensitive" in comparison && !comparison.caseSensitive) return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

/**
 * Where `actual` first differs from `expected` under a builtin comparison, approximately as the builtin checker sees it
 * (the checker's own message is kept as well). Null when no difference is found in the bytes given.
 */
export function firstDifference(
  actual: Uint8Array,
  expected: Uint8Array,
  comparison: AiOutputComparison
): AiOutputDifference | null {
  if (comparison.type === "binary") {
    const length = Math.min(actual.length, expected.length);
    let offset = 0;
    while (offset < length && actual[offset] === expected[offset]) offset++;
    if (offset === actual.length && offset === expected.length) return null;
    return {
      unit: "byte",
      index: offset,
      actual: excerpt(actual, offset, actual.length),
      expected: excerpt(expected, offset, expected.length)
    };
  }
  const lines = comparison.type === "lines";
  const left = units(actual, lines);
  const right = units(expected, lines);
  for (let index = 1; ; index++) {
    let a = left.next();
    let b = right.next();
    if (lines && (a.done || b.done)) {
      // Trailing empty lines don't count
      while (!a.done && a.value.start === a.value.end) a = left.next();
      while (!b.done && b.value.start === b.value.end) b = right.next();
    }
    if (a.done && b.done) return null;
    if (a.done || b.done || !sameUnit(actual, a.value, expected, b.value, comparison))
      return {
        unit: lines ? "line" : "token",
        index,
        ...(a.done ? {} : { actualLine: a.value.line }),
        ...(b.done ? {} : { expectedLine: b.value.line }),
        actual: a.done ? "" : excerpt(actual, a.value.start, a.value.end),
        expected: b.done ? "" : excerpt(expected, b.value.start, b.value.end)
      };
  }
}

// Validation of what a judge sends

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
const isNumber = (value: unknown, maximum: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
const text = (value: unknown, maximum: number) => (typeof value === "string" && value.length <= maximum ? value : null);
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T | null =>
  typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : null;

class Invalid extends Error {}
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Invalid();
  return value;
};
// An optional field: absent, or valid
function optional<T>(object: Record<string, unknown>, key: string, parse: (value: unknown) => T | null) {
  if (object[key] == null) return {};
  return { [key]: required(parse(object[key])) };
}

function parseLimits(value: unknown) {
  if (!isObject(value) || !isCount(value.timeLimitMs, 3600000) || !isCount(value.memoryLimitMiB, 1048576))
    throw new Invalid();
  return { timeLimitMs: value.timeLimitMs, memoryLimitMiB: value.memoryLimitMiB };
}

function parseArtifact(value: unknown, observation: number): AiArtifactRef {
  if (!isObject(value)) throw new Invalid();
  const role = required(oneOf(value.role, AI_ARTIFACT_ROLES));
  if (
    value.name !== aiEvidenceFileName(observation, role) ||
    !isCount(value.size, AI_EVIDENCE_LIMITS.artifactBytes) ||
    !isCount(value.originalSize) ||
    value.originalSize < value.size ||
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256) ||
    typeof value.binary !== "boolean"
  )
    throw new Invalid();
  return {
    name: value.name,
    role,
    classification: required(oneOf(value.classification, AI_ARTIFACT_CLASSIFICATIONS)),
    size: value.size,
    sha256: value.sha256,
    originalSize: value.originalSize,
    // Escaping expands each byte to at most four characters
    preview: required(text(value.preview, AI_EVIDENCE_LIMITS.previewBytes * 4 + 1024)),
    binary: value.binary
  };
}

function parseExecution(value: unknown): AiExecutionMeasure {
  if (!isObject(value)) throw new Invalid();
  return {
    status: required(oneOf(value.status, AI_EXECUTION_STATUSES)),
    ...optional(value, "exitCode", code => (Number.isSafeInteger(code) ? (code as number) : null)),
    ...optional(value, "termination", termination => oneOf(termination, ["exited", "signaled"] as const)),
    ...optional(value, "timeMs", time => (isNumber(time, 1e9) ? time : null)),
    ...optional(value, "memoryBytes", memory => (isNumber(memory, 2 ** 50) ? memory : null)),
    ...optional(value, "timeLimitMs", time => (isNumber(time, 1e9) ? time : null)),
    ...optional(value, "memoryLimitBytes", memory => (isNumber(memory, 2 ** 50) ? memory : null))
  };
}

function parseDifference(value: unknown): AiOutputDifference {
  if (!isObject(value) || !isCount(value.index)) throw new Invalid();
  return {
    unit: required(oneOf(value.unit, ["token", "line", "byte"] as const)),
    index: value.index,
    ...optional(value, "actualLine", line => (isCount(line) ? line : null)),
    ...optional(value, "expectedLine", line => (isCount(line) ? line : null)),
    actual: required(text(value.actual, EXCERPT * 4 + 8)),
    expected: required(text(value.expected, EXCERPT * 4 + 8))
  };
}

function parseObservation(value: unknown, index: number): AiFailureObservation {
  if (!isObject(value) || typeof value.fatal !== "boolean" || !Array.isArray(value.artifacts)) throw new Invalid();
  const artifacts = value.artifacts.map(artifact => parseArtifact(artifact, index));
  if (
    artifacts.length > AI_ARTIFACT_ROLES.length ||
    new Set(artifacts.map(artifact => artifact.role)).size !== artifacts.length
  )
    throw new Invalid();
  return {
    kind: required(oneOf(value.kind, AI_FAILURE_KINDS)),
    fatal: value.fatal,
    ...optional(value, "relation", relation => oneOf(relation, ["small_counterexample"] as const)),
    phase: required(text(value.phase, 64)),
    ...optional(value, "role", role => (typeof role === "string" && NAME.test(role) ? role : null)),
    ...optional(value, "candidate", candidate => text(candidate, 64)),
    ...optional(value, "subject", subject => text(subject, AI_EVIDENCE_LIMITS.label)),
    ...optional(value, "subtask", subtask => (isCount(subtask, 1000) ? subtask : null)),
    ...optional(value, "scenarioIndex", scenario => (isCount(scenario, 2 ** 31) ? scenario : null)),
    ...optional(value, "verdict", verdict => oneOf(verdict, AI_FAILURE_VERDICTS)),
    ...optional(value, "expectedBasis", basis => oneOf(basis, AI_EXPECTED_BASES)),
    ...optional(value, "execution", parseExecution),
    ...optional(value, "difference", parseDifference),
    ...optional(value, "search", search => {
      if (!isObject(search) || !isCount(search.attempts, 1000) || !isCount(search.budget, 1000)) return null;
      return {
        attempts: search.attempts,
        budget: search.budget,
        stoppedBy: required(oneOf(search.stoppedBy, ["budget", "capacity"] as const))
      };
    }),
    summary: required(text(value.summary, AI_EVIDENCE_LIMITS.summary)),
    artifacts,
    ...optional(value, "evidenceError", error => text(error, AI_EVIDENCE_LIMITS.label))
  };
}

/** What a judge sent as a failed run, checked and copied field by field; null if it isn't one. */
export function parseAiRunFailure(value: unknown): AiRunFailure | null {
  try {
    if (
      !isObject(value) ||
      value.schemaVersion !== 2 ||
      typeof value.attemptId !== "string" ||
      !UUID.test(value.attemptId) ||
      !isObject(value.sourceHashes) ||
      !isObject(value.profile) ||
      !Array.isArray(value.observations) ||
      !value.observations.length ||
      value.observations.length > AI_EVIDENCE_LIMITS.observations
    )
      return null;
    const sourceHashes: Record<string, string> = {};
    const entries = Object.entries(value.sourceHashes);
    if (entries.length > 48) return null;
    for (const [role, hash] of entries) {
      if (!NAME.test(role) || typeof hash !== "string" || !SHA256.test(hash)) return null;
      sourceHashes[role] = hash;
    }
    const { profile } = value;
    if (typeof profile.hash !== "string" || !SHA256.test(profile.hash)) return null;
    const observations = value.observations.map(parseObservation);
    if (!observations[0].fatal || observations.slice(1).some(observation => observation.fatal)) return null;
    const total = observations.reduce(
      (sum, observation) => sum + observation.artifacts.reduce((bytes, artifact) => bytes + artifact.size, 0),
      0
    );
    if (total > AI_EVIDENCE_LIMITS.runBytes) return null;
    return {
      schemaVersion: 2,
      attemptId: value.attemptId,
      operation: required(oneOf(value.operation, ["generate", "validate-reference"] as const)),
      sourceHashes,
      profile: {
        hash: profile.hash,
        architecture: required(text(profile.architecture, 32)),
        compiler: required(text(profile.compiler, AI_EVIDENCE_LIMITS.label)),
        auxiliary: parseLimits(profile.auxiliary),
        solution: parseLimits(profile.solution),
        oracle: parseLimits(profile.oracle),
        checker: required(text(profile.checker, AI_EVIDENCE_LIMITS.label)),
        ...optional(profile, "executionProfiles", digest =>
          typeof digest === "string" && SHA256.test(digest) ? digest : null
        )
      },
      observations
    };
  } catch (error) {
    if (error instanceof Invalid) return null;
    throw error;
  }
}
