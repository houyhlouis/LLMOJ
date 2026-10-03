import {
  SubmissionFinishedProgress as ProtocolSubmissionFinishedProgress,
  SubmissionProgress as ProtocolSubmissionProgress
} from "@libreoj/judge-protocol";

export { SubmissionProgressType } from "@libreoj/judge-protocol";

/** Public verdict fields shared by all problem types. */
export interface SubmissionTestcaseResult {
  status?: string;
  score?: number;
  time?: number;
  memory?: number;
  testcaseInfo?: { timeLimit?: number; memoryLimit?: number; inputFile?: string; outputFile?: string };
}

export type SubmissionProgress<TestcaseResult extends SubmissionTestcaseResult = SubmissionTestcaseResult> =
  ProtocolSubmissionProgress<TestcaseResult>;

export type SubmissionFinishedProgress<TestcaseResult extends SubmissionTestcaseResult = SubmissionTestcaseResult> =
  ProtocolSubmissionFinishedProgress<TestcaseResult>;
