import React, { useEffect, useRef, useState } from "react";
import { Button, Form, Header, Message, Progress } from "semantic-ui-react";
import { observer } from "mobx-react";
import { appState } from "@/appState";
import { defineRoute } from "@/AppRouter";
import { Link } from "@/utils/hooks";
import { readBrowserFile } from "@/utils/readBrowserFile";
import { aiCall, aiText, uploadAiAttachment } from "./api";
import AiJobs from "./AiJobs";
import style from "./Ai.module.less";

export const AiImportPage = observer(function AiImportPage() {
  const [markdown, setMarkdown] = useState(""),
    [image, setImage] = useState(""),
    [filename, setFilename] = useState("");
  const [attachment, setAttachment] = useState<File>(null),
    [attachmentToken, setAttachmentToken] = useState<string>(null),
    [uploadProgress, setUploadProgress] = useState<number>(null),
    [uploadPhase, setUploadPhase] = useState("");
  const [problemType, setProblemType] = useState<"auto" | "Traditional" | "Interaction" | "Communication">("auto");
  const [communicationMode, setCommunicationMode] = useState<"auto" | "run-twice" | "grader">("auto");
  const [count, setCount] = useState(20),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [refreshKey, setRefreshKey] = useState(0);
  const [readingStatement, setReadingStatement] = useState(false),
    [readingAttachment, setReadingAttachment] = useState(false);
  const mounted = useRef(false);
  const reads = useRef<{ statement?: AbortController; attachment?: AbortController }>({});
  const activeImport = useRef<AbortController>(null);
  useEffect(() => {
    mounted.current = true;
    appState.enterNewPage(aiText("一键导入题目", "Import problem with AI"), "problem_set");
    const cancel = () => {
      activeImport.current?.abort();
      reads.current.statement?.abort();
      reads.current.attachment?.abort();
    };
    window.addEventListener("pagehide", cancel);
    return () => {
      mounted.current = false;
      cancel();
      window.removeEventListener("pagehide", cancel);
    };
  }, []);
  const readFile = async (input: HTMLInputElement, kind: "statement" | "attachment") => {
    const file = input.files?.[0];
    if (!file) return;
    reads.current[kind]?.abort();
    const controller = new AbortController();
    reads.current[kind] = controller;
    const isCurrent = () => mounted.current && !controller.signal.aborted && reads.current[kind] === controller;
    const setReading = kind === "statement" ? setReadingStatement : setReadingAttachment;
    setReading(true);
    setError("");
    try {
      if (kind === "attachment") {
        setAttachment(null);
        setAttachmentToken(null);
        if (!/\.zip$/i.test(file.name) || file.size > 64 * 1024 * 1024) {
          setError(aiText("请选择不超过 64 MiB 的 ZIP 压缩包。", "Select a ZIP archive no larger than 64 MiB."));
          return;
        }
        // Keep the input mounted and unchanged until Firefox has read the File.
        // A memory-backed copy remains valid after clearing/replacing the input.
        const bytes = await readBrowserFile(file, "arrayBuffer", { signal: controller.signal });
        if (isCurrent())
          setAttachment(new File([bytes], file.name, { type: file.type, lastModified: file.lastModified }));
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError(aiText("文件不能超过 10 MiB。", "File must not exceed 10 MiB."));
        return;
      }
      if (/\.(md|markdown|txt)$/i.test(file.name)) {
        const text = await readBrowserFile(file, "text", { signal: controller.signal });
        if (isCurrent()) {
          setMarkdown(text);
          setImage("");
          setFilename(file.name);
        }
        return;
      }
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
        setError(
          aiText(
            "仅支持 Markdown 和 PNG/JPEG/WebP/GIF 图片。",
            "Only Markdown and PNG/JPEG/WebP/GIF images are supported."
          )
        );
        return;
      }
      const imageData = await readBrowserFile(file, "dataURL", { signal: controller.signal });
      if (isCurrent()) {
        setImage(imageData);
        setFilename(file.name);
      }
    } catch {
      if (isCurrent())
        setError(aiText("无法读取文件，请重新选择文件后重试。", "Unable to read the file. Select it again and retry."));
    } finally {
      if (reads.current[kind] === controller) {
        reads.current[kind] = undefined;
        // Do not invalidate the original File while a read is in progress.
        input.value = "";
        if (mounted.current) setReading(false);
      }
    }
  };
  const start = async () => {
    // A ref also prevents a second click before React renders the loading state.
    if (activeImport.current || reads.current.statement || reads.current.attachment) return;
    const controller = new AbortController();
    activeImport.current = controller;
    const isCurrent = () => mounted.current && !controller.signal.aborted && activeImport.current === controller;
    setPending(true);
    setError("");
    try {
      let token = attachmentToken;
      if (attachment && !token) {
        token = await uploadAiAttachment(
          attachment,
          value => {
            if (isCurrent()) {
              setUploadProgress(Math.round(value.progress * 100));
              setUploadPhase(value.status);
            }
          },
          controller.signal
        );
        if (!isCurrent()) return;
        setAttachmentToken(token);
      }
      if (!isCurrent()) return;
      setUploadProgress(null);
      await aiCall(
        "start",
        {
          action: "import",
          markdown,
          image: image || undefined,
          count,
          ...(problemType !== "auto" ? { problemType } : {}),
          ...(problemType === "Communication" && communicationMode !== "auto" ? { communicationMode } : {}),
          ...(token ? { attachmentToken: token } : {})
        },
        { signal: controller.signal, timeout: 30000 }
      );
      if (!isCurrent()) return;
      setRefreshKey(value => value + 1);
      setMarkdown("");
      setImage("");
      setFilename("");
      setAttachment(null);
      setAttachmentToken(null);
    } catch (error) {
      if (isCurrent()) setError(error.message);
    } finally {
      if (activeImport.current === controller) {
        activeImport.current = null;
        if (mounted.current) {
          setPending(false);
          setUploadProgress(null);
        }
      }
    }
  };
  return (
    <>
      <Header as="h1">{aiText("一键导入题目", "Import problem with AI")}</Header>
      <p className={style.description}>
        {aiText(
          "上传题面图片或 Markdown，创建私人传统题、交互题或通信题，随后检索原题、翻译、生成标签、难度、题解和测试数据。图片识别需要支持图像输入的模型。",
          "Upload an image or Markdown to create a private traditional, interactive or communication problem, then find its source, translate, tag, rate, write a tutorial and generate test data. Images require a vision-capable model."
        )}
      </p>
      <p>
        <Link href="/ai/configuration">{aiText("AI API 配置", "AI API Configuration")}</Link>
      </p>
      {error && <Message negative>{error}</Message>}
      {(readingStatement || readingAttachment) && <Message info>{aiText("正在读取文件…", "Reading file…")}</Message>}
      {pending && uploadProgress != null && (
        <Button type="button" onClick={() => activeImport.current?.abort()}>
          {aiText("取消上传", "Cancel upload")}
        </Button>
      )}
      {pending && uploadProgress != null && (
        <Progress
          active
          percent={uploadProgress}
          progress={uploadPhase === "Uploading"}
          label={
            uploadPhase === "Uploading"
              ? aiText("上传附加文件", "Uploading attachments")
              : aiText("准备导入", "Preparing import")
          }
        />
      )}
      <Form onSubmit={e => e.preventDefault()} loading={pending}>
        <Form.Select
          label={aiText("题型", "Problem type")}
          value={problemType}
          options={[
            { value: "auto", text: aiText("自动识别", "Detect automatically") },
            { value: "Traditional", text: aiText("传统题", "Traditional") },
            { value: "Interaction", text: aiText("交互题", "Interactive") },
            { value: "Communication", text: aiText("通信题", "Communication") }
          ]}
          onChange={(_event, { value }) => setProblemType(value as typeof problemType)}
        />
        {problemType === "Communication" && (
          <Form.Select
            label={aiText("通信方式", "Communication mode")}
            value={communicationMode}
            options={[
              { value: "auto", text: aiText("自动识别", "Detect automatically") },
              { value: "run-twice", text: aiText("独立运行两轮（run-twice）", "Two separate runs (run-twice)") },
              {
                value: "grader",
                text: aiText("函数接口 grader（Alice/Bob，仅 C++）", "Function grader (Alice/Bob, C++ only)")
              }
            ]}
            onChange={(_event, { value }) => setCommunicationMode(value as typeof communicationMode)}
          />
        )}
        <p className={style.notes}>
          {aiText(
            "SPJ 是传统题的判题规则，会按题面和附件配置。交互题需要明确问答协议；通信题需要明确两轮协议或函数接口。请在附件中提供官方 checker、interactor、manager、grader 和头文件（如有）。",
            "SPJ is a checker for traditional problems and is configured from the statement and attachments. Interactive tasks need a query protocol; communication tasks need a two-run protocol or function interface. Attach official checker, interactor, manager, grader and header files when available."
          )}
        </p>
        <Form.Input
          type="file"
          label={aiText("题面文件", "Statement file")}
          accept=".md,.markdown,.txt,image/png,image/jpeg,image/webp,image/gif"
          disabled={pending || readingStatement}
          onChange={event => void readFile(event.currentTarget, "statement")}
        />
        {filename && (
          <p>
            {filename}{" "}
            <Button
              size="mini"
              type="button"
              onClick={() => {
                setImage("");
                setFilename("");
              }}
            >
              {aiText("移除", "Remove")}
            </Button>
          </p>
        )}
        <Form.TextArea
          rows={14}
          disabled={pending || readingStatement}
          label={aiText("Markdown 题面", "Markdown statement")}
          value={markdown}
          onChange={(_e, { value }) => setMarkdown(String(value))}
        />
        <p className={style.notes}>
          {aiText(
            "可在题面中注明 time limit: 2 s、memory limit: 256 MiB、fileio: a（表示 a.in / a.out）。",
            "You can include time limit: 2 s, memory limit: 256 MiB, and fileio: a (meaning a.in / a.out) in the statement."
          )}
        </p>
        <Form.Input
          type="file"
          accept=".zip,application/zip"
          label={aiText("附加文件 ZIP（可选，最多 64 MiB）", "Attachment ZIP (optional, up to 64 MiB)")}
          disabled={pending || readingAttachment}
          onChange={event => void readFile(event.currentTarget, "attachment")}
        />
        {attachment && (
          <p>
            {attachment.name}{" "}
            <Button
              size="mini"
              type="button"
              onClick={() => {
                setAttachment(null);
                setAttachmentToken(null);
              }}
            >
              {aiText("移除", "Remove")}
            </Button>
          </p>
        )}
        <p className={style.notes}>
          {aiText(
            "可包含官方评测程序、接口头文件和大样例。适用的样例会用于标程校验和提交时的样例评测，题面页面不会直接展开大样例。",
            "May include official judging programs, interface headers and large samples. Applicable samples validate the reference solution and are used in submission sample tests; large samples are not expanded in the statement."
          )}
        </p>
        <Form.Input
          className={style.importCount}
          type="number"
          min={5}
          max={1000}
          label={aiText("测试数据组数（5–1000）", "Test cases (5–1000)")}
          value={count}
          onChange={(_e, { value }) => setCount(Number(value))}
        />
        <Button
          primary
          type="button"
          disabled={
            pending ||
            readingStatement ||
            readingAttachment ||
            (!markdown.trim() && !image) ||
            !Number.isInteger(count) ||
            count < 5 ||
            count > 1000
          }
          onClick={start}
        >
          {aiText("导入并一键执行", "Import and run all")}
        </Button>
      </Form>
      <AiJobs refreshKey={refreshKey} heading={aiText("我的 AI 任务", "My AI jobs")} />
    </>
  );
});
export default defineRoute(async () => <AiImportPage />);
