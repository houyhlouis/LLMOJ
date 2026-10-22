import { OmittableString, omittableStringToString, prependOmittableString } from "../omittableString";

// integers: check the equivalent of each integer in user's output and answer
export interface CheckerTypeIntegers {
  type: "integers";
}

// floats:   check each float in user's output and answer
//           allow output with relative or absolute error not exceeding [floats.precision].
export interface CheckerTypeFloats {
  type: "floats";
  precision: number;
}

// tokens: compare whitespace-delimited strings; never coerce numbers or ignore missing/excess tokens.
export interface CheckerTypeTokens {
  type: "tokens";
  caseSensitive: boolean;
}

// lines:    check the equivalent of text in each line (separated by "\n"), maybe case-insensitive
//           any space characters (space, \t, \r) in the end of a line will be ignored
//           any empty lines in the end of file will be ignored
export interface CheckerTypeLines {
  type: "lines";
  caseSensitive: boolean;
}

// binary:   check if the user's output and answer files are equal in binary
export interface CheckerTypeBinary {
  type: "binary";
}

// custom:   use a custom program to check the user's output
export interface CheckerTypeCustom {
  type: "custom";
  interface: string;
  language: string;
  compileAndRunOptions: unknown;
  filename: string;
  timeLimit?: number;
  memoryLimit?: number;
}

export type Checker =
  | CheckerTypeIntegers
  | CheckerTypeFloats
  | CheckerTypeLines
  | CheckerTypeTokens
  | CheckerTypeBinary
  | CheckerTypeCustom;

export interface CheckerResult {
  /**
   * `score == null` means JudgementFailed.
   */
  score?: number;
  checkerMessage?: OmittableString;
}

/**
 * A checker's score: the token at the start of `text` (after spaces), which ends with a space or the end of the text,
 * from 0 to 100. testlib's points may have a decimal part, as quitp prints them; Lemon and legacy checkers give a whole
 * number. "malformed": not such a number (37abc, 1e2, -5, NaN, Infinity, 37.5 for a whole number, nothing);
 * "range": a number above 100.
 */
export function parseCheckerScore(text: string, decimal: boolean): number | "malformed" | "range" {
  const token = /^[ \t\r\n]*(\S+)(?=\s|$)/.exec(text)?.[1];
  if (!token || !(decimal ? /^\d+(\.\d+)?$/ : /^\d+$/).test(token)) return "malformed";
  const score = Number(token);
  return score <= 100 ? score : "range";
}

/**
 * The verdict in testlib's message. "points X" is the score X (0 to 100, with a decimal part if it has one), and
 * "partially correct (N)" the score N / 2. A score that isn't a whole number or is out of range is the checker's
 * failure (Judgement Failed), never a truncated or capped score.
 */
export function parseTestlibMessage(message: OmittableString): CheckerResult | OmittableString {
  const friendlyMessage = message || "(empty)";
  const messagePlain = omittableStringToString(message);

  if (messagePlain.startsWith("ok")) {
    return {
      score: 100,
      checkerMessage: message
    };
  } else if (messagePlain.startsWith("wrong answer") || messagePlain.startsWith("wrong output format")) {
    return {
      score: 0,
      checkerMessage: message
    };
  } else if (messagePlain.startsWith("points")) {
    const score = messagePlain.startsWith("points ") ? parseCheckerScore(messagePlain.slice(7), true) : "malformed";
    if (score === "malformed") return prependOmittableString("Couldn't parse testlib's message: ", friendlyMessage);
    if (score === "range")
      return prependOmittableString("Got an invalid score from testlib's message: ", friendlyMessage);
    return {
      score,
      checkerMessage: message
    };
  } else if (messagePlain.startsWith("partially correct")) {
    const match = messagePlain.match(/^partially correct \((\d+)\)(?=\s|$)/);
    if (!match) return prependOmittableString("Couldn't parse testlib's message: ", friendlyMessage);
    const score = Number(match[1]);
    if (!(score >= 0 && score <= 200))
      return prependOmittableString(`Got invalid score ${match[1]} from testlib's message: `, friendlyMessage);
    return {
      score: score / 2,
      checkerMessage: message
    };
  } else if (messagePlain.startsWith("FAIL")) {
    return {
      checkerMessage: message
    };
  } else {
    return prependOmittableString("Couldn't parse testlib's message: ", friendlyMessage);
  }
}

/** The memory (MiB) a checker's sandbox may use: none for a built-in checker, which runs in the judge process. */
export function checkerMemory(judgeInfo: { memoryLimit?: number; checker: Checker }): number {
  return judgeInfo.checker.type === "custom" ? judgeInfo.checker.memoryLimit || judgeInfo.memoryLimit || 0 : 0;
}

export function getCheckerMeta<JudgeInfo extends { timeLimit?: number; memoryLimit?: number; checker: Checker }>(
  judgeInfo: JudgeInfo
): Checker {
  const { checker } = judgeInfo;

  if (checker.type !== "custom") return checker;

  return {
    ...checker,
    filename: null,
    timeLimit: checker.timeLimit || judgeInfo.timeLimit,
    memoryLimit: checker.memoryLimit || judgeInfo.memoryLimit
  };
}
