import React, { useEffect } from "react";
import { Icon, Label, Message } from "semantic-ui-react";
import { observer } from "mobx-react";

import { CodeLanguage, getPreferredCompileAndRunOptions } from "@/interfaces/CodeLanguage";
import { useLocalizer } from "@/utils/hooks";
import CodeEditor from "@/components/LazyCodeEditor";

import { JudgeInfoCommunication } from "../../judge-settings/types/CommunicationProblemEditor";
import { ProblemTypeLabelsProps, ProblemTypeSubmitViewProps, ProblemTypeView } from "../common/interface";
import SubmitViewFrame from "../common/SubmitViewFrame";
import CodeLanguageAndOptions from "../common/CodeLanguageAndOptions";
import { getLimit, hasAnySubtaskTestcase } from "../common";

type CommunicationProblemLabelsProps = ProblemTypeLabelsProps<JudgeInfoCommunication>;

const CommunicationProblemLabels: React.FC<CommunicationProblemLabelsProps> = React.memo(props => {
  const timeLimit = getLimit(props.judgeInfo, "timeLimit");
  const memoryLimit = getLimit(props.judgeInfo, "memoryLimit");

  return (
    <>
      {timeLimit && (
        <Label size={props.size} color="pink">
          <Icon name="clock" />
          {timeLimit + " ms"}
        </Label>
      )}
      {memoryLimit && (
        <Label size={props.size} color="blue">
          <Icon name="microchip" />
          {memoryLimit + " MiB"}
        </Label>
      )}
    </>
  );
});

interface SubmissionContent {
  language: CodeLanguage;
  code: string;
  compileAndRunOptions: any;
  skipSamples?: boolean;
}

type CommunicationProblemSubmitViewProps = ProblemTypeSubmitViewProps<JudgeInfoCommunication, SubmissionContent>;

let CommunicationProblemSubmitView: React.FC<CommunicationProblemSubmitViewProps> = props => {
  const _ = useLocalizer("problem_judge_settings");
  const hasGrader = !!(props.judgeInfo.hasGrader || props.judgeInfo.grader);
  useEffect(() => {
    if (hasGrader && props.submissionContent.language !== CodeLanguage.Cpp) {
      props.onUpdateSubmissionContent("language", CodeLanguage.Cpp);
      props.onUpdateSubmissionContent("compileAndRunOptions", getPreferredCompileAndRunOptions(CodeLanguage.Cpp));
    }
  }, [hasGrader, props.submissionContent.language]);
  return (
    <>
      {hasGrader && <Message info content={_(".communication.submission_grader")} />}
      <SubmitViewFrame
        {...props}
        showSkipSamples={props.judgeInfo.runSamples}
        mainContent={
          <SubmitViewFrame.EditorWrapper>
            <CodeEditor
              language={props.submissionContent.language}
              value={props.submissionContent.code}
              onChange={newValue => props.onUpdateSubmissionContent("code", newValue)}
            />
          </SubmitViewFrame.EditorWrapper>
        }
        sidebarContent={
          <>
            <CodeLanguageAndOptions
              objectPath=""
              {...props}
              allowedLanguages={hasGrader ? [CodeLanguage.Cpp] : undefined}
            />
          </>
        }
        submitDisabled={
          !props.submissionContent.code || (hasGrader && props.submissionContent.language !== CodeLanguage.Cpp)
        }
      />
    </>
  );
};

CommunicationProblemSubmitView = observer(CommunicationProblemSubmitView);

const communicationProblemViews: ProblemTypeView<JudgeInfoCommunication> = {
  Labels: CommunicationProblemLabels,
  SubmitView: CommunicationProblemSubmitView,
  getDefaultSubmissionContent: () =>
    Object.assign(
      {
        code: ""
      },
      { language: CodeLanguage.Cpp, compileAndRunOptions: getPreferredCompileAndRunOptions(CodeLanguage.Cpp) }
    ),
  isSubmittable: hasAnySubtaskTestcase,
  enableStatistics: () => true
};

export default communicationProblemViews;
