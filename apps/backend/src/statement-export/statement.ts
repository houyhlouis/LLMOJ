/**
 * A problem's statement as people download it: what the problem page shows, in one structure the Markdown and PDF
 * writers share. Built only from what the viewer may already see on the page (title, limits, input and output,
 * statement sections, the samples they show, names of downloadable files); never from test data, checkers or other
 * judge-only settings.
 */

export type StatementLocale = "en_US" | "zh_CN";

export type StatementIo =
  | { kind: "standard" }
  | { kind: "file"; input: string; output: string }
  | { kind: "interactive" }
  | { kind: "grader" }
  | { kind: "communication" }
  | { kind: "answer" };

export interface StatementSample {
  /** Numbered from 1 in the order the statement shows them */
  number: number;
  input: string;
  output: string;
}

export type StatementSection =
  | { kind: "text"; title: string; text: string }
  | { kind: "sample"; title: string; text: string; sample: StatementSample };

export interface Statement {
  /** The labels' language (the viewer's), and the statement's own (which may differ when it has no translation) */
  locale: StatementLocale;
  contentLocale: string;
  /** "#1001" on the problem page, "A" in a contest */
  label: string;
  title: string;
  type: string;
  timeLimit: string | null;
  memoryLimit: string | null;
  io: StatementIo;
  /** The original problem (a URL or text), as the problem page shows it */
  source?: string;
  sections: StatementSection[];
  samples: StatementSample[];
  /** Names of files the viewer may download with the statement */
  files: string[];
}

const LABELS = {
  en_US: {
    timeLimit: "Time limit",
    memoryLimit: "Memory limit",
    io: "Input and output",
    standardIo: "Standard input and output",
    fileIo: "File input and output",
    inputFile: "Input file",
    outputFile: "Output file",
    interactive: "Interactive (with the interactor, through standard input and output)",
    grader: "Function interface (C++ grader)",
    communication: "Communication (two separate runs)",
    answer: "Submit answers (no program runs)",
    input: "Input",
    output: "Output",
    sample: "Sample",
    files: "Files",
    source: "Source",
    problem: "Problem",
    contents: "Problems",
    time: "Time",
    page: "Page",
    untitled: "Untitled",
    imageMissing: "Image not included",
    colon: ": ",
    comma: ", ",
    open: " (",
    close: ")"
  },
  zh_CN: {
    timeLimit: "时间限制",
    memoryLimit: "内存限制",
    io: "输入输出",
    standardIo: "标准输入输出",
    fileIo: "文件输入输出",
    inputFile: "输入文件",
    outputFile: "输出文件",
    interactive: "交互题（与交互库通过标准输入输出交互）",
    grader: "函数接口（C++ grader）",
    communication: "通信题（两次独立运行）",
    answer: "提交答案题（不运行程序）",
    input: "输入",
    output: "输出",
    sample: "样例",
    files: "附加文件",
    source: "来源",
    problem: "题目",
    contents: "题目列表",
    time: "时间",
    page: "页",
    untitled: "未命名",
    imageMissing: "图片未能包含",
    colon: "：",
    comma: "，",
    open: "（",
    close: "）"
  }
};

export type StatementLabels = (typeof LABELS)["en_US"];

export function statementLocale(locale: string): StatementLocale {
  return locale === "zh_CN" ? "zh_CN" : "en_US";
}

export function statementLabels(locale: string): StatementLabels {
  return LABELS[statementLocale(locale)];
}

/** What the problem page shows of the input and output (one line of text) */
export function describeIo(io: StatementIo, labels: StatementLabels): string {
  switch (io.kind) {
    case "file":
      return `${labels.fileIo}${labels.open}${labels.inputFile}${labels.colon}${io.input}${labels.comma}${labels.outputFile}${labels.colon}${io.output}${labels.close}`;
    case "interactive":
      return labels.interactive;
    case "grader":
      return labels.grader;
    case "communication":
      return labels.communication;
    case "answer":
      return labels.answer;
    default:
      return labels.standardIo;
  }
}

interface LimitedJudgeInfo {
  timeLimit?: unknown;
  memoryLimit?: unknown;
  subtasks?: {
    timeLimit?: unknown;
    memoryLimit?: unknown;
    testcases?: { timeLimit?: unknown; memoryLimit?: unknown }[];
  }[];
}

/**
 * A limit as the problem page shows it: the smallest and largest limit of any test case ("1000 - 2000"), or one
 * number when they're the same; null when no test case has one. Same rules as the page's `getLimit`.
 */
export function limitRange(judgeInfo: LimitedJudgeInfo | null | undefined, limit: "timeLimit" | "memoryLimit") {
  const valid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  if (!judgeInfo) return null;
  const taskLimit = valid(judgeInfo[limit]) ? judgeInfo[limit] : Infinity;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const subtask of Array.isArray(judgeInfo.subtasks) ? judgeInfo.subtasks : []) {
    const subtaskLimit = valid(subtask?.[limit]) ? (subtask[limit] as number) : taskLimit;
    for (const testcase of Array.isArray(subtask?.testcases) ? subtask.testcases : []) {
      const value = valid(testcase?.[limit]) ? (testcase[limit] as number) : subtaskLimit;
      if (value === 0) continue;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  // A problem without test data yet shows its task limits, which it will use
  if (!Number.isFinite(minimum)) return valid(judgeInfo[limit]) && judgeInfo[limit] ? String(judgeInfo[limit]) : null;
  return minimum === maximum ? String(minimum) : `${minimum} - ${maximum}`;
}

/** Empty editor placeholders are kept in drafts, but are not statement sections (as visibleSections.ts) */
function visible(section: RawSection, samples: RawSample[]) {
  if (section?.type === "Text") return !!section.text?.trim();
  const sample = samples[section?.sampleId];
  return !!(sample && (sample.inputData?.trim() || sample.outputData?.trim()));
}

interface RawSection {
  sectionTitle: string;
  type: string;
  sampleId?: number;
  text?: string;
}

interface RawSample {
  inputData: string;
  outputData: string;
}

export interface StatementParts {
  locale: string;
  contentLocale: string;
  label: string;
  title: string;
  type: string;
  judgeInfo:
    (LimitedJudgeInfo & { fileIo?: { inputFilename?: unknown; outputFilename?: unknown }; grader?: unknown }) | null;
  /**
   * In a contest, its own input and output files (empty for standard input and output): a contest never inherits the
   * problem's file input and output
   */
  contestFiles?: { input: string; output: string };
  source?: string | null;
  sections: RawSection[] | null;
  samples: RawSample[] | null;
  files?: string[];
}

function ioOf(parts: StatementParts): StatementIo {
  switch (parts.type) {
    case "Interaction":
      return { kind: "interactive" };
    case "Communication":
      return parts.judgeInfo?.grader ? { kind: "grader" } : { kind: "communication" };
    case "SubmitAnswer":
      return { kind: "answer" };
    default:
      break;
  }
  const files = parts.contestFiles
    ? parts.contestFiles
    : {
        input: String(parts.judgeInfo?.fileIo?.inputFilename ?? ""),
        output: String(parts.judgeInfo?.fileIo?.outputFilename ?? "")
      };
  return parts.judgeInfo?.fileIo || parts.contestFiles
    ? files.input && files.output
      ? { kind: "file", input: files.input, output: files.output }
      : { kind: "standard" }
    : { kind: "standard" };
}

export function buildStatement(parts: StatementParts): Statement {
  const labels = statementLabels(parts.locale);
  const samples = Array.isArray(parts.samples) ? parts.samples : [];
  const shown: StatementSample[] = [];
  const sections: StatementSection[] = [];
  for (const section of Array.isArray(parts.sections) ? parts.sections : []) {
    if (!visible(section, samples)) continue;
    const title = String(section.sectionTitle ?? "").trim();
    if (section.type === "Text") sections.push({ kind: "text", title, text: section.text });
    else {
      const data = samples[section.sampleId];
      const sample = {
        number: shown.length + 1,
        input: String(data.inputData ?? ""),
        output: String(data.outputData ?? "")
      };
      shown.push(sample);
      sections.push({
        kind: "sample",
        title: title || `${labels.sample} ${sample.number}`,
        text: section.text ?? "",
        sample
      });
    }
  }
  const answer = parts.type === "SubmitAnswer";
  return {
    locale: statementLocale(parts.locale),
    contentLocale: parts.contentLocale,
    label: parts.label,
    title: String(parts.title ?? "").trim() || labels.untitled,
    type: parts.type,
    timeLimit: answer ? null : limitRange(parts.judgeInfo, "timeLimit"),
    memoryLimit: answer ? null : limitRange(parts.judgeInfo, "memoryLimit"),
    io: ioOf(parts),
    source: parts.source ? String(parts.source) : undefined,
    sections,
    samples: shown,
    files: parts.files ?? []
  };
}
