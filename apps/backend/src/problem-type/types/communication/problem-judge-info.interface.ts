import { ProblemJudgeInfoInteraction } from "../interaction/problem-judge-info.interface";

/** Two fresh contestant processes, connected only through the trusted manager. */
export interface ProblemJudgeInfoCommunication extends Omit<ProblemJudgeInfoInteraction, "interactor"> {
  manager: Omit<ProblemJudgeInfoInteraction["interactor"], "interface" | "sharedMemorySize"> & {
    interface: "run-twice";
  };
  /** A separate C++ translation unit implementing main and the public function API. */
  grader?: { filename: string };
}
