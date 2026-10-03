import React, { useEffect, useState } from "react";
import { Button, Form, Header, Message, Progress } from "semantic-ui-react";
import { observer } from "mobx-react";
import { appState } from "@/appState";
import { defineRoute } from "@/AppRouter";
import { Link } from "@/utils/hooks";
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
  useEffect(() => {
    appState.enterNewPage(aiText("一键导入题目", "Import problem with AI"), "problem_set");
  }, []);
  const readFile = async (file: File) => {
    if (!file) return;
    setError("");
    if (file.size > 10 * 1024 * 1024) {
      setError(aiText("文件不能超过 10 MiB。", "File must not exceed 10 MiB."));
      return;
    }
    if (/\.(md|markdown|txt)$/i.test(file.name)) {
      setMarkdown(await file.text());
      setImage("");
      setFilename(file.name);
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
    const reader = new FileReader();
    reader.onload = () => {
      setImage(String(reader.result));
      setFilename(file.name);
    };
    reader.readAsDataURL(file);
  };
  const start = async () => {
    setPending(true);
    setError("");
    try {
      let token = attachmentToken;
      if (attachment && !token) {
        token = await uploadAiAttachment(attachment, value => {
          setUploadProgress(Math.round(value.progress * 100));
          setUploadPhase(value.status);
        });
        setAttachmentToken(token);
      }
      await aiCall("start", {
        action: "import",
        markdown,
        image: image || undefined,
        count,
        ...(problemType !== "auto" ? { problemType } : {}),
        ...(problemType === "Communication" && communicationMode !== "auto" ? { communicationMode } : {}),
        ...(token ? { attachmentToken: token } : {})
      });
      setRefreshKey(value => value + 1);
      setMarkdown("");
      setImage("");
      setFilename("");
      setAttachment(null);
      setAttachmentToken(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
      setUploadProgress(null);
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
          onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            void readFile(file);
          }}
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
          key={attachment?.name || "no-attachment"}
          type="file"
          accept=".zip,application/zip"
          label={aiText("附加文件 ZIP（可选，最多 64 MiB）", "Attachment ZIP (optional, up to 64 MiB)")}
          onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            if (!/\.zip$/i.test(file.name) || file.size > 64 * 1024 * 1024) {
              setError(aiText("请选择不超过 64 MiB 的 ZIP 压缩包。", "Select a ZIP archive no larger than 64 MiB."));
              return;
            }
            setError("");
            setAttachment(file);
            setAttachmentToken(null);
          }}
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
          disabled={(!markdown.trim() && !image) || !Number.isInteger(count) || count < 5 || count > 1000}
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
