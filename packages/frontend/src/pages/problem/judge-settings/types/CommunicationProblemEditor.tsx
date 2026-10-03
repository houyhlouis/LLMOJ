import React from "react";
import { observer } from "mobx-react";
import { Form, Header, Input, Message, Segment } from "semantic-ui-react";
import { useLocalizer } from "@/utils/hooks";
import {
  CodeLanguage,
  checkCodeFileExtension,
  filterValidCompileAndRunOptions,
  getPreferredCompileAndRunOptions
} from "@/interfaces/CodeLanguage";
import CodeLanguageAndOptions from "@/components/CodeLanguageAndOptions";
import { JudgeInfoProcessor, EditorComponentProps, Options } from "../common/interface";
import MetaEditor, { JudgeInfoWithMeta } from "../common/MetaEditor";
import SubtasksEditor, { JudgeInfoWithSubtasks } from "../common/SubtasksEditor";
import ExtraSourceFilesEditor, { JudgeInfoWithExtraSourceFiles } from "../common/ExtraSourceFilesEditor";
import TestDataFileSelector from "../common/TestDataFileSelector";
import style from "./InteractionProblemEditor.module.less";

const metaOptions: Options<typeof MetaEditor> = {
  enableTimeMemoryLimit: true,
  enableFileIo: false,
  enableRunSamples: true
};
const subtaskOptions: Options<typeof SubtasksEditor> = {
  enableTimeMemoryLimit: true,
  enableInputFile: true,
  enableOutputFile: false,
  enableUserOutputFilename: false
};
export interface CommunicationManager {
  interface: "run-twice";
  filename: string;
  language: CodeLanguage;
  compileAndRunOptions: Record<string, unknown>;
  timeLimit?: number;
  memoryLimit?: number;
}
export type JudgeInfoCommunication = JudgeInfoWithMeta &
  JudgeInfoWithSubtasks &
  JudgeInfoWithExtraSourceFiles & {
    manager: CommunicationManager;
    grader?: { filename: string };
    hasGrader?: boolean;
  };

const CommunicationProblemEditor = observer(function CommunicationProblemEditor(
  props: EditorComponentProps<JudgeInfoCommunication>
) {
  const _ = useLocalizer("problem_judge_settings");
  const { manager, grader } = props.judgeInfo;
  const updateManager = (delta: Partial<CommunicationManager>) =>
    props.onUpdateJudgeInfo(current => ({ manager: { ...current.manager, ...delta } }));
  return (
    <>
      <MetaEditor {...props} options={metaOptions} />
      <Form className={style.wrapper}>
        <Header size="tiny">{_(".communication.manager")}</Header>
        <Message info content={_(".communication.description")} />
        <Segment className={style.checkerConfig}>
          <div className={style.custom}>
            <TestDataFileSelector
              type="FormSelect"
              label={_(".communication.filename")}
              placeholder={_(".interactor.filename_no_file")}
              value={manager.filename}
              testData={props.testData}
              onChange={filename => !props.pending && updateManager({ filename })}
            />
            <div className={style.compileAndRunOptions}>
              <CodeLanguageAndOptions
                pending={props.pending}
                language={manager.language}
                compileAndRunOptions={manager.compileAndRunOptions}
                onUpdateLanguage={language => updateManager({ language })}
                onUpdateCompileAndRunOptions={compileAndRunOptions => updateManager({ compileAndRunOptions })}
              />
            </div>
            <Form.Group widths="equal">
              {(["timeLimit", "memoryLimit"] as const).map(key => (
                <Form.Field key={key}>
                  <label>{_(key === "timeLimit" ? ".meta.time_limit" : ".meta.memory_limit")}</label>
                  <Input
                    disabled={props.pending}
                    placeholder={String(props.judgeInfo[key] ?? "")}
                    value={manager[key] ?? ""}
                    label={key === "timeLimit" ? "ms" : "MiB"}
                    labelPosition="right"
                    onChange={(_event, { value }) => {
                      if (value === "" || (Number.isSafeInteger(Number(value)) && Number(value) >= 1))
                        updateManager({ [key]: value === "" ? null : Number(value) });
                    }}
                  />
                </Form.Field>
              ))}
            </Form.Group>
          </div>
        </Segment>
        <Form.Checkbox
          disabled={props.pending}
          label={_(".communication.use_grader")}
          checked={!!grader}
          onChange={(_event, { checked }) =>
            props.onUpdateJudgeInfo({
              grader: checked ? { filename: "" } : null
            })
          }
        />
        {grader && (
          <>
            <Message info content={_(".communication.grader_description")} />
            <TestDataFileSelector
              type="FormSelect"
              label={_(".communication.grader_filename")}
              placeholder={_(".interactor.filename_no_file")}
              value={grader.filename}
              testData={props.testData}
              onChange={filename => !props.pending && props.onUpdateJudgeInfo({ grader: { filename } })}
            />
          </>
        )}
      </Form>
      <SubtasksEditor {...props} options={subtaskOptions} />
      <ExtraSourceFilesEditor {...props} />
    </>
  );
});

const processor: JudgeInfoProcessor<JudgeInfoCommunication> = {
  parseJudgeInfo(raw, testData) {
    const manager = raw.manager || {};
    const language = Object.values(CodeLanguage).includes(manager.language) ? manager.language : CodeLanguage.Cpp;
    return {
      ...MetaEditor.parseJudgeInfo(raw, testData, metaOptions),
      manager: {
        interface: "run-twice",
        language,
        filename:
          typeof manager.filename === "string"
            ? manager.filename
            : testData.find(file => checkCodeFileExtension(language, file.filename))?.filename || "",
        compileAndRunOptions:
          language === manager.language
            ? filterValidCompileAndRunOptions(language, manager.compileAndRunOptions)
            : getPreferredCompileAndRunOptions(language),
        timeLimit: Number.isSafeInteger(manager.timeLimit) ? manager.timeLimit : null,
        memoryLimit: Number.isSafeInteger(manager.memoryLimit) ? manager.memoryLimit : null
      },
      ...(raw.grader
        ? { grader: { filename: typeof raw.grader.filename === "string" ? raw.grader.filename : "" } }
        : {}),
      ...SubtasksEditor.parseJudgeInfo(raw, testData, subtaskOptions),
      ...ExtraSourceFilesEditor.parseJudgeInfo(raw, testData)
    };
  },
  normalizeJudgeInfo(judgeInfo) {
    MetaEditor.normalizeJudgeInfo(judgeInfo, metaOptions);
    judgeInfo.manager.interface = "run-twice";
    if (judgeInfo.manager.timeLimit == null) delete judgeInfo.manager.timeLimit;
    if (judgeInfo.manager.memoryLimit == null) delete judgeInfo.manager.memoryLimit;
    if (!judgeInfo.grader) delete judgeInfo.grader;
    SubtasksEditor.normalizeJudgeInfo(judgeInfo, subtaskOptions);
    ExtraSourceFilesEditor.normalizeJudgeInfo(judgeInfo);
  }
};
export default Object.assign(CommunicationProblemEditor, processor);
