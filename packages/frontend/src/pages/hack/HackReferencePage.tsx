import React, { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { Accordion, Button, Form, Header, Icon, Message } from "semantic-ui-react";
import { defineRoute } from "@/AppRouter";
import { appState } from "@/appState";
import { Link } from "@/utils/hooks";
import CodeEditor from "@/components/LazyCodeEditor";
import CodeLanguageAndOptions from "@/components/CodeLanguageAndOptions";
import { CodeLanguage, compileAndRunOptions } from "@/interfaces/CodeLanguage";
import { errorText, hackApi, tr } from "./api";
import style from "./HackPages.module.less";

interface ReferenceConfig {
  standardCode: string;
  standardLanguage: CodeLanguage;
  standardCompileAndRunOptions: Record<string, string>;
  standardFileIo: { inputFilename: string; outputFilename: string } | null;
  validatorCode: string;
  validatorLanguage: CodeLanguage;
  referenceSubmissionId?: number;
}
const HackReferencePage = observer(function HackReferencePage({
  problemId,
  initial
}: {
  problemId: number;
  initial: ReferenceConfig;
}) {
  const [value, setValue] = useState(initial),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [error, setError] = useState(""),
    [inputFilename, setInputFilename] = useState(initial.standardFileIo?.inputFilename || "input.txt"),
    [outputFilename, setOutputFilename] = useState(initial.standardFileIo?.outputFilename || "output.txt"),
    [validatorOpen, setValidatorOpen] = useState(!initial.validatorCode);
  useEffect(() => {
    appState.enterNewPage(`P${problemId} · STD`, "problem_set");
  }, [problemId, appState.locale]);
  function update<Key extends keyof ReferenceConfig>(key: Key, next: ReferenceConfig[Key]) {
    setValue(value => ({ ...value, [key]: next }));
    setSaved(false);
  }
  return (
    <div className={style.referencePage}>
      <div className={style.referenceHeader}>
        <Header as="h1" className="withIcon">
          <Icon name="code" />
          {tr("管理题目 STD", "Manage problem STD")} P{problemId}
        </Header>
        <div className={style.referenceHeaderActions}>
          <Button as={Link} href={`/p/id/${problemId}`} disabled={busy} content={tr("返回", "Back")} />
          <Button
            primary
            loading={busy}
            disabled={busy || !value.standardCode.trim()}
            content={tr("提交", "Submit")}
            onClick={async () => {
              setBusy(true);
              setError("");
              setSaved(false);
              try {
                await hackApi("saveConfig", {
                  problemId,
                  standardCode: value.standardCode,
                  standardLanguage: value.standardLanguage,
                  standardCompileAndRunOptions: value.standardCompileAndRunOptions,
                  standardFileIo: value.standardFileIo,
                  validatorCode: value.validatorCode,
                  validatorLanguage: value.validatorLanguage
                });
                setValue(await hackApi("config", { problemId }));
                setSaved(true);
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          />
        </div>
      </div>
      {error && <Message negative content={error} />}
      {saved && <Message positive content={tr("STD 和输入校验器已保存。", "STD and input validator saved.")} />}
      <p>
        {tr(
          "STD 用于生成 Hack 数据的正确答案，只有题目管理员可以设置。判题方式和 SPJ 沿用题目正式评测配置。",
          "The STD produces correct answers for hack input. Problem managers configure it; judging and the SPJ use the problem's formal configuration."
        )}
      </p>
      {value.referenceSubmissionId && (
        <p>
          {tr("来源提交：", "Source submission: ")}
          <Link href={`/s/${value.referenceSubmissionId}`}>#{value.referenceSubmissionId}</Link>
        </p>
      )}
      <Form loading={busy}>
        <Form.Group widths="equal">
          <CodeLanguageAndOptions
            pending={busy}
            language={value.standardLanguage}
            compileAndRunOptions={value.standardCompileAndRunOptions}
            onUpdateLanguage={language => update("standardLanguage", language)}
            onUpdateCompileAndRunOptions={options =>
              update("standardCompileAndRunOptions", options as Record<string, string>)
            }
          />
        </Form.Group>
        <Form.Checkbox
          label={tr("STD 使用文件输入输出", "STD uses file input/output")}
          checked={!!value.standardFileIo}
          disabled={busy}
          onChange={(_, next) => update("standardFileIo", next.checked ? { inputFilename, outputFilename } : null)}
        />
        <p>
          {tr(
            "默认使用标准输入输出。此设置只影响 STD；目标提交仍使用其题目或比赛的文件输入输出设置。",
            "STD uses stdin/stdout by default. This setting only affects the STD; the target retains its problem or contest file I/O settings."
          )}
        </p>
        {value.standardFileIo && (
          <Form.Group widths="equal">
            <Form.Input
              id="hack-std-input-filename"
              label={tr("STD 输入文件名", "STD input filename")}
              value={inputFilename}
              disabled={busy}
              onChange={(_, next) => {
                setInputFilename(next.value);
                update("standardFileIo", { inputFilename: next.value, outputFilename });
              }}
            />
            <Form.Input
              id="hack-std-output-filename"
              label={tr("STD 输出文件名", "STD output filename")}
              value={outputFilename}
              disabled={busy}
              onChange={(_, next) => {
                setOutputFilename(next.value);
                update("standardFileIo", { inputFilename, outputFilename: next.value });
              }}
            />
          </Form.Group>
        )}
        <Form.Field>
          <label>{tr("STD 源代码", "STD source code")}</label>
          <CodeEditor
            className={style.referenceEditor}
            language={value.standardLanguage}
            value={value.standardCode}
            onChange={code => update("standardCode", code)}
            options={{ readOnly: busy }}
          />
        </Form.Field>
        <Accordion>
          <Accordion.Title active={validatorOpen} onClick={() => setValidatorOpen(!validatorOpen)}>
            <Icon name="dropdown" />
            {tr("输入校验器", "Input validator")}
          </Accordion.Title>
          <Accordion.Content active={validatorOpen}>
            <p>
              {tr(
                "已有正式数据校验器时会自动载入。校验器读取输入，合法时返回 0，非法时返回非零值。",
                "An available formal-data validator is loaded automatically. It reads the input and exits with 0 for valid input or a nonzero code for invalid input."
              )}
            </p>
            <Form.Select
              label={tr("校验器语言", "Validator language")}
              value={value.validatorLanguage}
              options={Object.keys(compileAndRunOptions).map(language => ({ value: language, text: language }))}
              onChange={(_, next) => update("validatorLanguage", next.value as CodeLanguage)}
            />
            <CodeEditor
              className={style.referenceEditor}
              language={value.validatorLanguage}
              value={value.validatorCode}
              onChange={code => update("validatorCode", code)}
              options={{ readOnly: busy }}
            />
          </Accordion.Content>
        </Accordion>
      </Form>
    </div>
  );
});
export default defineRoute(async request => {
  const problemId = Number(request.params.id);
  return <HackReferencePage key={problemId} problemId={problemId} initial={await hackApi("config", { problemId })} />;
});
