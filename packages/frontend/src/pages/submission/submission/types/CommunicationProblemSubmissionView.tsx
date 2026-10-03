import React from "react";

import style from "../SubmissionPage.module.less";

import { useLocalizer } from "@/utils/hooks";
import { CodeLanguage } from "@/interfaces/CodeLanguage";
import { OmittableAnsiCodeBox, OmittableString } from "@/components/CodeBox";
import { ProblemTypeSubmissionViewProps, ProblemTypeSubmissionViewHelper } from "../common/interface";
import FormattableCodeBox from "../common/FormattableCodeBox";

interface SubmissionTestcaseResultCommunication {
  testcaseInfo: {
    timeLimit: number;
    memoryLimit: number;
    inputFile: string;
    outputFile: string;
  };
  status: string;
  score: number;
  time?: number;
  memory?: number;
  input?: OmittableString;
  userError?: OmittableString;
  interactorMessage?: OmittableString;
  systemMessage?: OmittableString;
}

interface SubmissionContentCommunication {
  language: CodeLanguage;
  code: string;
  compileAndRunOptions: Record<string, string>;
}

type CommunicationProblemSubmissionViewProps = ProblemTypeSubmissionViewProps<
  SubmissionTestcaseResultCommunication,
  SubmissionContentCommunication
>;

const CommunicationProblemSubmissionView: React.FC<CommunicationProblemSubmissionViewProps> = props => {
  const _ = useLocalizer("submission");

  return (
    <>
      {props.getCompilationMessage()}
      {props.getSystemMessage()}
      {props.getSubtasksView(testcaseResult => (
        <OmittableAnsiCodeBox title={_(".testcase.manager_message")} ansiMessage={testcaseResult.interactorMessage} />
      ))}
      <FormattableCodeBox
        className={style.answerCodeBox}
        code={props.content.code}
        language={props.content.language}
        ref={props.refDefaultCopyCodeBox}
      />
    </>
  );
};

const helper: ProblemTypeSubmissionViewHelper<SubmissionContentCommunication> = {
  getAnswerInfo(content, _) {
    const entires = Object.entries(content.compileAndRunOptions);
    return entires.length ? (
      <>
        <table className={style.compileAndRunOptions}>
          <tbody>
            {entires.map(([name, value]) => (
              <tr key={name}>
                <td align="right" className={style.compileAndRunOptionsName}>
                  <strong>{_(`code_language.${content.language}.options.${name}.name`)}</strong>
                </td>
                <td>{_(`code_language.${content.language}.options.${name}.values.${value}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    ) : null;
  },
  getHighlightLanguageList(content) {
    return [content.language];
  }
};

export default Object.assign(CommunicationProblemSubmissionView, helper);
