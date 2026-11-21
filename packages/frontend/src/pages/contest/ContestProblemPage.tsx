import { isVisibleProblemSection } from "../problem/visibleSections";
import React, { useEffect, useRef, useState } from "react";
import { Button, Divider, Form, Header, List, Message, Progress, Segment } from "semantic-ui-react";
import { defineRoute } from "@/AppRouter";
import { appState } from "@/appState";
import { useNavigationChecked, Link, useLocalizer } from "@/utils/hooks";
import MarkdownContent from "@/markdown/MarkdownContent";
import CodeEditor from "@/components/LazyCodeEditor";
import { callApiWithFileUpload } from "@/utils/callApiWithFileUpload";
import {
  CodeLanguage,
  compileAndRunOptions,
  filterValidCompileAndRunOptions,
  getPreferredCompileAndRunOptions,
  normalizeContestLanguages
} from "@/interfaces/CodeLanguage";
import {
  DRAFT_RETENTION_DAYS,
  DraftOwner,
  latestDraftLanguage,
  loadDraft,
  removeDraft,
  saveDraft
} from "@/utils/contestDrafts";
import formatDateTime from "@/utils/formatDateTime";
import { callContest, contestRequest, submitContest, prepareContestUpload, tr } from "./api";
import ContestFrame from "./ContestFrame";
import { virtualRunActive } from "./VirtualRun";
import style from "./ContestPages.module.less";
import SelfEvalButton from "@/pages/self-eval/SelfEvalButton";
import { saveBlob } from "@/utils/downloadFile";

/** How long typing pauses before the draft is saved; leaving the page saves it at once. */
const DRAFT_SAVE_DELAY = 500;

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
/** The values of an option this contest allows: C++ standards and Python versions are chosen per contest. */
function allowedOptionValues(selectedLanguages: string[], language: string, name: string, values: string[]) {
  if (
    selectedLanguages.includes(language) ||
    !((language === "cpp" && name === "std") || (language === "python" && name === "version"))
  )
    return values;
  return values.filter(v => selectedLanguages.includes(`${language}:${v}`));
}
/** A draft's options, where they are still valid and allowed in this contest; the defaults otherwise. */
function draftOptions(selectedLanguages: string[], language: CodeLanguage, saved: Record<string, unknown>) {
  const defaults = initialOptions(selectedLanguages.find(l => l.split(":")[0] === language) || language);
  const valid = filterValidCompileAndRunOptions(language, saved);
  return Object.fromEntries(
    Object.entries(defaults).map(([name, value]) => {
      const option = compileAndRunOptions[language]?.find(o => o.name === name);
      const allowed = option ? allowedOptionValues(selectedLanguages, language, name, option.values) : [];
      return [name, name in saved && allowed.includes(valid[name] as string) ? valid[name] : value];
    })
  );
}
type DraftStatus = { savedAt: number; restored?: boolean } | "not-kept" | null;

export function ContestProblemPage({ detail, initial }: { detail: any; initial: any }) {
  const navigation = useNavigationChecked(),
    _ = useLocalizer("code_language");
  const initialLanguages = problemLanguages(initial);
  // Code is kept as a draft in this browser, per account, contest, problem and language
  const draftOwner: DraftOwner =
    appState.currentUser && initial.type !== "SubmitAnswer"
      ? { userId: appState.currentUser.id, contestId: initial.contest.id, problemId: initial.problem.id }
      : null;
  // The page opens with the draft changed last, in a language the contest still allows
  const [start] = useState(() => {
    const languages = [...new Set(initialLanguages.map(l => l.split(":")[0]))];
    const draftLanguage = latestDraftLanguage(draftOwner, languages) as CodeLanguage;
    const draft = draftLanguage && loadDraft(draftOwner, draftLanguage);
    if (draft)
      return {
        language: draftLanguage,
        code: draft.code,
        options: draftOptions(initialLanguages, draftLanguage, draft.options),
        status: { savedAt: draft.savedAt, restored: true } as DraftStatus
      };
    return {
      language: (initialLanguages[0] || CodeLanguage.Cpp).split(":")[0] as CodeLanguage,
      code: "",
      options: initialOptions(initialLanguages[0] || CodeLanguage.Cpp),
      status: null as DraftStatus
    };
  });
  const [data, setData] = useState(initial),
    [code, setCode] = useState(start.code),
    [language, setLanguage] = useState<CodeLanguage>(start.language),
    [options, setOptions] = useState<Record<string, unknown>>(start.options),
    [draftStatus, setDraftStatus] = useState<DraftStatus>(start.status);
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

  // The draft waiting to be saved: typing saves it after a pause, and leaving the page right away
  const pendingDraft = useRef<{ language: string; code: string; options: Record<string, unknown> }>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout>>(null);
  function saveDraftNow() {
    if (draftTimer.current != null) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    const next = pendingDraft.current;
    pendingDraft.current = null;
    if (!next || !draftOwner) return;
    const result = saveDraft(draftOwner, next.language, next.code, next.options);
    setDraftStatus(result === "saved" ? { savedAt: Date.now() } : result === "not-kept" ? "not-kept" : null);
  }
  function keepDraft(next: { language: string; code: string; options: Record<string, unknown> }) {
    if (!draftOwner) return;
    pendingDraft.current = next;
    if (draftTimer.current != null) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => saveDraftNow(), DRAFT_SAVE_DELAY);
  }
  const saveDraftOnExit = useRef(saveDraftNow);
  saveDraftOnExit.current = saveDraftNow;
  useEffect(() => {
    const save = () => saveDraftOnExit.current();
    const saveWhenHidden = () => document.visibilityState === "hidden" && save();
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", saveWhenHidden);
    return () => {
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", saveWhenHidden);
      save();
    };
  }, []);

  function changeCode(value: string) {
    setCode(value);
    keepDraft({ language, code: value, options });
  }
  function changeOptions(value: Record<string, unknown>) {
    setOptions(value);
    if (code) keepDraft({ language, code, options: value });
  }
  // Each language has its own draft. Choosing a language without one keeps the code in the editor, and its draft moves
  // to that language.
  function changeLanguage(next: CodeLanguage) {
    if (next === language) return;
    saveDraftNow();
    const draft = loadDraft(draftOwner, next);
    setLanguage(next);
    if (draft) {
      setCode(draft.code);
      setOptions(draftOptions(selectedLanguages, next, draft.options));
      setDraftStatus({ savedAt: draft.savedAt, restored: true });
      return;
    }
    const nextOptions = initialOptions(selectedLanguages.find(l => l.split(":")[0] === next) || next);
    setOptions(nextOptions);
    if (draftOwner && code) {
      removeDraft(draftOwner, language);
      pendingDraft.current = { language: next, code, options: nextOptions };
      saveDraftNow();
    }
  }
  function discardDraft() {
    if (!window.confirm(tr("删除这份草稿并清空编辑器？", "Delete this draft and empty the editor?"))) return;
    if (draftTimer.current != null) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    pendingDraft.current = null;
    removeDraft(draftOwner, language);
    setCode("");
    setDraftStatus(null);
  }

  useEffect(() => {
    if (allowedLanguages.length && !allowedLanguages.includes(language))
      changeLanguage(allowedLanguages[0] as CodeLanguage);
  }, [language, selectedLanguages.join(",")]);
  const allowedOptions = (name: string, values: string[]) =>
    allowedOptionValues(selectedLanguages, language, name, values);
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
      // The draft stays, to fix after a wrong answer
      saveDraftNow();
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
  const [statementPending, setStatementPending] = useState(false);
  async function downloadStatement() {
    setStatementPending(true);
    try {
      const result = await callContest("statement", { id, problemId, data: { locale: data.locale } });
      saveBlob(new Blob([result.markdown], { type: "text/markdown;charset=utf-8" }), result.filename);
    } catch (e) {
      setError(e.message);
    } finally {
      setStatementPending(false);
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
      <div className={style.sectionToolbar}>
        <Header as="h2">{data.title}</Header>
        <div className={style.headerRightControls}>
          <Button
            basic
            className="labeled icon"
            icon="download"
            loading={statementPending}
            disabled={statementPending}
            onClick={downloadStatement}
            content={tr("下载题面（Markdown）", "Download statement (Markdown)")}
          />
        </div>
      </div>
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
      {data.type === "Traditional" &&
        data.contest.rule === "noi" &&
        data.contest.ruleOptions?.selfEvalEnabled === true &&
        !virtualRunActive(detail) && (
          <SelfEvalButton
            problemId={data.problem.problemId}
            contestId={id}
            initialContent={{ language, code, compileAndRunOptions: options }}
          />
        )}
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
        <>
          <Message>{tr("当前不能提交此题", "Submissions are currently unavailable")}</Message>
          {draftOwner && code && (
            // A draft written before submissions closed can still be read and copied
            <Form>
              <Form.Field>
                <label>
                  {tr("你在此浏览器中的草稿", "Your draft in this browser")} ({_(`.${language}.name`)})
                </label>
                <div className={style.codeEditor}>
                  <CodeEditor language={language} value={code} options={{ readOnly: true }} />
                </div>
              </Form.Field>
              <DraftNotice status={draftStatus} onDiscard={discardDraft} />
            </Form>
          )}
        </>
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
                onChange={(_, v) => changeLanguage(v.value as CodeLanguage)}
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
                    onChange={(_, v) => changeOptions({ ...options, [option.name]: v.value })}
                  />
                ))}
              </Form.Group>
              <Form.Field required>
                <label>{tr("源代码", "Source code")}</label>
                <div className={style.codeEditor}>
                  <CodeEditor language={language} value={code} onChange={changeCode} />
                </div>
              </Form.Field>
              <DraftNotice status={draftStatus} onDiscard={discardDraft} />
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
/** Where the code is kept: its draft in this browser, with the rules for deleting it and a way to delete it now */
function DraftNotice(props: { status: DraftStatus; onDiscard: () => void }) {
  if (!props.status) return null;
  if (props.status === "not-kept")
    return (
      <Message warning size="small">
        {tr(
          "此浏览器无法保存这段代码的草稿：代码超过 1 MiB，或浏览器的存储已满或已停用。",
          "This browser can't keep a draft of this code: it's over 1 MiB, or the browser's storage is full or turned off."
        )}
      </Message>
    );
  const time = formatDateTime(props.status.savedAt)[1];
  return (
    <p className={style.draftNotice}>
      {props.status.restored
        ? tr(`已恢复你在此浏览器中保存的草稿（${time}）。`, `Restored your draft from this browser (saved ${time}).`)
        : tr(`草稿已保存在此浏览器中（${time}）。`, `Draft saved in this browser at ${time}.`)}{" "}
      {tr(
        `退出登录、其他账号在此浏览器登录，或 ${DRAFT_RETENTION_DAYS} 天未修改时，草稿会被删除。`,
        `It's deleted when you sign out, when another account signs in on this browser, or after ${DRAFT_RETENTION_DAYS} days without changes.`
      )}{" "}
      <Button type="button" basic compact size="mini" onClick={props.onDiscard}>
        {tr("删除草稿", "Discard draft")}
      </Button>
    </p>
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
