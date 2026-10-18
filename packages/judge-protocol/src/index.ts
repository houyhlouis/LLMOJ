export enum JudgeTaskType {
  Submission = "Submission",
  Hack = "Hack",
  SelfEvalPrepare = "SelfEvalPrepare",
  SelfEval = "SelfEval"
}

// Raised when judge clients announce something new to the server. Judge clients that announce nothing are version 1.
// Version 3 announces the judge's runtime and checks the files of a task against their SHA-256.
export const JUDGE_PROTOCOL_VERSION = 3;

/** What a judge judges with, as recorded with each result. */
export interface JudgeRuntimeInfo {
  // SHA-256 of the judge program's source files
  judgeProgram: string;
  // The sandbox image (rootfs) ID, which identifies its compilers and interpreters
  sandboxImage: string;
  node: string;
  os: string;
  kernel: string;
  arch: string;
  cpu: string;
}

/** Sent by a judge client after "ready", as the "capabilities" event. */
export interface JudgeClientCapabilities {
  protocolVersion: number;
  // The task types it can judge; it's sent no others
  taskTypes: JudgeTaskType[];
  consumerThreads: number;
  executionSlots: number;
  // MiB the sandboxes of concurrent work may reserve together
  memoryBudget: number;
  aiExecutionSlots: number;
  // Since protocol version 3
  runtime?: JudgeRuntimeInfo;
}

export interface JudgeTaskMeta {
  taskId: string;
  type: JudgeTaskType;
}

export interface JudgeTaskPayload<ExtraInfo> extends JudgeTaskMeta {
  priorityType: number;
  priority: number;
  extraInfo: ExtraInfo;
  // The SHA-256 of the stored files the task uses, by UUID, for those whose content hash is recorded. A judge checks
  // each file against it before using it, also a file it has kept from an earlier task.
  fileHashes?: Record<string, string>;
}

export type OmittableString =
  | string
  | {
      data: string;
      omittedLength: number;
    };

export enum SubmissionStatus {
  Pending = "Pending",
  ConfigurationError = "ConfigurationError",
  SystemError = "SystemError",
  Canceled = "Canceled",
  CompilationError = "CompilationError",
  FileError = "FileError",
  RuntimeError = "RuntimeError",
  TimeLimitExceeded = "TimeLimitExceeded",
  MemoryLimitExceeded = "MemoryLimitExceeded",
  OutputLimitExceeded = "OutputLimitExceeded",
  PartiallyCorrect = "PartiallyCorrect",
  WrongAnswer = "WrongAnswer",
  Accepted = "Accepted",
  JudgementFailed = "JudgementFailed",
  Fake = "Fake",
  Hacked = "Hacked"
}

export enum HackStatus {
  Pending = "Pending",
  Running = "Running",
  Success = "Success",
  Failed = "Failed",
  InvalidInput = "InvalidInput",
  ConfigurationError = "ConfigurationError",
  SystemError = "SystemError",
  Canceled = "Canceled"
}

export interface HackProgress {
  status: HackStatus;
  finished: boolean;
  message?: string;
  timeUsed?: number;
  memoryUsed?: number;
  // Safe target-testcase feedback. Compiler/checker diagnostics and program output stay private.
  targetExecuted?: boolean;
  targetStatus?: SubmissionStatus;
  targetScore?: number;
}

export interface SelfEvalCase {
  subtask: number;
  input: string;
  output: string;
}

export interface SelfEvalProgress {
  status: string;
  finished: boolean;
  score?: number;
  timeUsed?: number;
  memoryUsed?: number;
  subtasks?: { score: number; fullScore: number }[];
  cases?: SelfEvalCase[];
  message?: string;
}

export enum SubmissionProgressType {
  Preparing = "Preparing",
  Compiling = "Compiling",
  Running = "Running",
  Finished = "Finished"
}

export interface SubmissionTestcaseProgressReference {
  waiting?: boolean;
  running?: boolean;
  testcaseHash?: string;
}

export interface SubmissionProgressDetails<TestcaseResult> {
  compile?: {
    success: boolean;
    message: OmittableString;
  };
  systemMessage?: OmittableString;
  testcaseResult?: Record<string, TestcaseResult>;
  samples?: SubmissionTestcaseProgressReference[];
  subtasks?: {
    score: number;
    fullScore: number;
    testcases: SubmissionTestcaseProgressReference[];
  }[];
}

export type SubmissionActiveProgress<TestcaseResult> = SubmissionProgressDetails<TestcaseResult> & {
  progressType: SubmissionProgressType.Preparing | SubmissionProgressType.Compiling | SubmissionProgressType.Running;
};

export type SubmissionFinishedProgress<TestcaseResult> = SubmissionProgressDetails<TestcaseResult> & {
  progressType: SubmissionProgressType.Finished;
  status: SubmissionStatus;
  score: number;
  totalOccupiedTime: number;
};

export type SubmissionProgress<TestcaseResult = unknown> =
  | SubmissionActiveProgress<TestcaseResult>
  | SubmissionFinishedProgress<TestcaseResult>;

export interface JudgeClientSystemInfo {
  os: string;
  kernel: string;
  arch: string;
  cpu: {
    model: string;
    flags: string;
    cache: Record<string, number>;
  };
  memory: {
    size: number;
    description: string;
  };
  languages: Record<
    string,
    {
      name: string;
      version: string;
    }[]
  >;
  extraInfo: string;
}
