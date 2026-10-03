import { isVisibleProblemSection } from "../problem/visibleSections";
import React, { useEffect, useRef, useState } from "react";
import { Button, Divider, Form, Header, List, Message, Progress, Segment } from "semantic-ui-react";
import { defineRoute } from "@/AppRouter";
import { appState } from "@/appState";
import { useNavigationChecked, Link, useLocalizer } from "@/utils/hooks";
import MarkdownContent from "@/markdown/MarkdownContent";
import { callApiWithFileUpload } from "@/utils/callApiWithFileUpload";
import {
  CodeLanguage,
  compileAndRunOptions,
  getPreferredCompileAndRunOptions,
  normalizeContestLanguages
} from "@/interfaces/CodeLanguage";
import { callContest, contestRequest, submitContest, prepareContestUpload, tr } from "./api";
import ContestFrame from "./ContestFrame";
import style from "./ContestPages.module.less";

function initialOptions(value: string) {
  const [language, variant] = value.split(":");
  return {
    ...getPreferredCompileAndRunOptions(language as CodeLanguage),
    ...(variant ? { [language === "cpp" ? "std" : "version"]: variant } : {})
  };
}
function problemLanguages(data: any) {
  const languages = normalizeContestLanguages(data.contest.languages);
  return data.type === "Communication" && data.hasGrader
    ? languages.filter(language => language.split(":")[0] === CodeLanguage.Cpp)
    : languages;
}
function ContestProblemPage({ detail, initial }: { detail: any; initial: any }) {
  const navigation = useNavigationChecked(),
    _ = useLocalizer("code_language");
  const initialLanguages = problemLanguages(initial);
  const [data, setData] = useState(initial),
    [code, setCode] = useState(""),
    [language, setLanguage] = useState<CodeLanguage>(
      (initialLanguages[0] || CodeLanguage.Cpp).split(":")[0] as CodeLanguage
    ),
    [options, setOptions] = useState(initialOptions(initialLanguages[0] || CodeLanguage.Cpp));
  const [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [file, setFile] = useState<File>(null),
    [attachment, setAttachment] = useState<File>(null),
    [progress, setProgress] = useState<number>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const id = data.contest.id,
    problemId = data.problem.id;
  const selectedLanguages = problemLanguages(data);
  const allowedLanguages = [...new Set<string>(selectedLanguages.map(l => l.split(":")[0]))];
  useEffect(() => {
    if (allowedLanguages.length && !allowedLanguages.includes(language)) {
      setLanguage(allowedLanguages[0] as CodeLanguage);
      setOptions(initialOptions(selectedLanguages[0]));
    }
  }, [language, selectedLanguages.join(",")]);
  const allowedOptions = (name: string, values: string[]) => {
    if (
      selectedLanguages.includes(language) ||
      !((language === "cpp" && name === "std") || (language === "python" && name === "version"))
    )
      return values;
    return values.filter(v => selectedLanguages.includes(`${language}:${v}`));
  };
  const refresh = async () =>
    setData(await callContest("problem", { id, problemId, data: { locale: appState.locale } }));
  async function submit() {
    setPending(true);
    setError("");
    try {
      const content = data.type === "SubmitAnswer" ? {} : { language, code, compileAndRunOptions: options };
      const result =
        data.type === "SubmitAnswer"
          ? await callApiWithFileUpload<any, any>({
              api: request => submitContest({ id, problemId, data: { content, uploadInfo: request.uploadInfo } }),
              prepareUploadApi: (_, blob) =>
                prepareContestUpload({ id, problemId, data: { content, fileSize: blob.size } }),
              request: {},
              file,
              onProgress: p => setProgress(p.progress * 100)
            })
          : await submitContest({ id, problemId, data: { content } });
      if (result.requestError || result.response?.error || !result.response?.submissionId)
        throw new Error(
          tr(
            "提交失败，请检查代码语言或文件后重试。",
            "Submission failed. Check the language or answer file and retry."
          )
        );
      await navigation.navigate(`/contest/${id}/submission/${result.response.submissionId}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
      setProgress(null);
    }
  }
  async function upload() {
    if (!attachment) return;
    setPending(true);
    setError("");
    try {
      const result = await callApiWithFileUpload<any, any>({
        api: request =>
          contestRequest("attachment")({
            id,
            problemId,
            data: { filename: attachment.name, uploadInfo: request.uploadInfo }
          }),
        request: {},
        file: attachment,
        onProgress: p => setProgress(p.progress * 100)
      });
      if (result.requestError || result.response?.error || !result.response)
        throw new Error(tr("上传失败", "Upload failed"));
      setAttachment(null);
      if (attachmentInput.current) attachmentInput.current.value = "";
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
      setProgress(null);
    }
  }
  async function download(filename: string) {
    try {
      const r = await callContest("download", { id, problemId, data: { filename } });
      window.location.href = r.url;
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <ContestFrame detail={detail} tab="overview">
      <Header as="h2">{data.title}</Header>
      <Form>
        <Form.Select
          label={tr("题面语言", "Statement language")}
          value={data.locale}
          options={data.locales.map((locale: string) => ({
            value: locale,
            text: locale === "zh_CN" ? "简体中文" : "English"
          }))}
          onChange={async (_, v) => {
            try {
              setData(await callContest("problem", { id, problemId, data: { locale: v.value } }));
            } catch (e) {
              setError(e.message);
            }
          }}
        />
      </Form>
      <p>
        {tr("时间限制", "Time limit")}: {data.limits.timeLimit} ms · {tr("内存限制", "Memory limit")}:{" "}
        {data.limits.memoryLimit} MiB
      </p>
      <p>
        {data.type === "Communication"
          ? data.hasGrader
            ? tr("函数接口（C++ grader）", "Function interface (C++ grader)")
            : tr("通信（两次独立运行）", "Communication (two separate runs)")
          : data.problem.inputFilename
          ? `${tr("文件输入输出", "File I/O")}: ${data.problem.inputFilename} / ${data.problem.outputFilename}`
          : tr("标准输入输出", "Standard I/O")}
      </p>
      {data.content
        .filter((section: any) => isVisibleProblemSection(section, data.samples))
        .map((section: any, index: number) => (
          <React.Fragment key={index}>
            <Header as="h3">{section.sectionTitle}</Header>
            {section.type === "Sample" && data.samples?.[section.sampleId] && (
              <Segment>
                <pre>{data.samples[section.sampleId].inputData}</pre>
                <Divider />
                <pre>{data.samples[section.sampleId].outputData}</pre>
              </Segment>
            )}
            <MarkdownContent content={section.text || ""} />
          </React.Fragment>
        ))}
      {!!data.problem.attachments.length && (
        <>
          <Header as="h3">{tr("附加文件", "Attachments")}</Header>
          <List>
            {data.problem.attachments.map((a: any) => (
              <List.Item key={a.uuid}>
                <Button basic size="small" onClick={() => download(a.filename)}>
                  {a.filename}
                </Button>
                {data.manager && !a.derived && (
                  <Button
                    basic
                    size="small"
                    onClick={async () => {
                      try {
                        await callContest("removeAttachment", { id, problemId, data: { filename: a.filename } });
                        await refresh();
                      } catch (e) {
                        setError(e.message);
                      }
                    }}
                  >
                    {tr("删除", "Delete")}
                  </Button>
                )}
              </List.Item>
            ))}
          </List>
        </>
      )}
      {data.manager && (
        <div className={style.preview}>
          <Header as="h3">{tr("上传比赛专用附件", "Upload contest attachment")}</Header>
          <input ref={attachmentInput} type="file" onChange={e => setAttachment(e.target.files?.[0] ?? null)} />
          <Button disabled={!attachment || pending} onClick={upload}>
            {tr("上传", "Upload")}
          </Button>
        </div>
      )}
      {progress != null && pending && <Progress percent={Math.round(progress)} progress />}
      {error && <Message negative>{error}</Message>}
      <Divider />
      <Header as="h2">{tr("提交", "Submit")}</Header>
      {data.type === "Communication" && data.hasGrader && (
        <Message info>
          {tr(
            "请提交同时实现双方通信函数的 C++ 代码，不要定义 main；入口由 grader 提供。函数签名和头文件以题面及附件为准。",
            "Submit C++ implementations of both communication functions without main; the grader provides the entry point. Follow the function signatures and headers in the statement and attachments."
          )}
        </Message>
      )}
      {!appState.currentUser ? (
        <Message>
          <Link href="/login">{tr("请先登录", "Please sign in")}</Link>
        </Message>
      ) : !data.submittable || !allowedLanguages.length ? (
        <Message>{tr("当前不能提交此题", "Submissions are currently unavailable")}</Message>
      ) : (
        <Form onSubmit={submit} loading={pending}>
          {data.type === "SubmitAnswer" ? (
            <Form.Field required>
              <label>{tr("答案 ZIP 文件", "Answer ZIP file")}</label>
              <input type="file" accept=".zip" onChange={e => setFile(e.target.files?.[0] ?? null)} />
            </Form.Field>
          ) : (
            <>
              <Form.Select
                label={tr("语言", "Language")}
                value={language}
                options={allowedLanguages.map((l: string) => ({ value: l, text: _(`.${l}.name`) }))}
                onChange={(_, v) => {
                  setLanguage(v.value as CodeLanguage);
                  setOptions(initialOptions(selectedLanguages.find(l => l.split(":")[0] === v.value)));
                }}
              />
              <Form.Group widths="equal">
                {compileAndRunOptions[language]?.map(option => (
                  <Form.Select
                    key={option.name}
                    label={_(`.${language}.options.${option.name}.name`)}
                    value={options[option.name] as string}
                    options={allowedOptions(option.name, option.values).map(value => ({
                      value,
                      text: _(`.${language}.options.${option.name}.values.${value}`)
                    }))}
                    onChange={(_, v) => setOptions({ ...options, [option.name]: v.value })}
                  />
                ))}
              </Form.Group>
              <Form.TextArea
                label={tr("源代码", "Source code")}
                rows={18}
                value={code}
                onChange={(_, v) => setCode(String(v.value))}
                style={{ fontFamily: "monospace" }}
              />
            </>
          )}
          <Button primary type="submit" disabled={data.type === "SubmitAnswer" ? !file : !code}>
            {tr("提交", "Submit")}
          </Button>
        </Form>
      )}
    </ContestFrame>
  );
}
export default defineRoute(async req => {
  const id = Number(req.params.contestId),
    problemId = Number(req.params.problemId);
  const [detail, initial] = await Promise.all([
    callContest("detail", { id }),
    callContest("problem", { id, problemId, data: { locale: appState.locale } })
  ]);
  return <ContestProblemPage key={`${id}-${problemId}`} detail={detail} initial={initial} />;
});
