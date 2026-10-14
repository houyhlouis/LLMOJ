import React, { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { Button, Form, Header, Label, Loader, Message, Pagination, Table } from "semantic-ui-react";
import { extensionApi } from "@/utils/extensionApi";
import { appState } from "@/appState";
import CodeEditor from "@/components/LazyCodeEditor";
import AiJobs from "@/pages/ai/AiJobs";
import { aiCall } from "@/pages/ai/api";
import CodeLanguageAndOptions from "@/components/CodeLanguageAndOptions";
import { CodeLanguage, getPreferredCodeLanguage, getPreferredCompileAndRunOptions } from "@/interfaces/CodeLanguage";
import { errorText, reasonText, tr } from "@/pages/hack/api";
import { contestStatusText } from "@/pages/contest/api";
import style from "./SelfEvalPage.module.less";

export interface SelfEvalContent {
  language: CodeLanguage;
  code: string;
  compileAndRunOptions: Record<string, unknown>;
}
const selfEvalApi = (action: string, body: any) => extensionApi("selfEval/" + action, body);
const isPending = (record: any) => record && ["Pending", "Running", "Preparing", "Compiling"].includes(record.status);

export default observer(function SelfEvalPanel({
  problemId,
  contestId,
  initialContent
}: {
  problemId: number;
  contestId: number;
  initialContent?: Partial<SelfEvalContent>;
}) {
  const defaultLanguage = initialContent?.language || getPreferredCodeLanguage(),
    context = { problemId, contestId };
  const [info, setInfo] = useState<any>(),
    [records, setRecords] = useState<any[]>([]),
    [recordTotal, setRecordTotal] = useState(0),
    [recordPageSize, setRecordPageSize] = useState(30),
    [recordPage, setRecordPage] = useState(1),
    [result, setResult] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [language, setLanguage] = useState(defaultLanguage),
    [code, setCode] = useState(initialContent?.code || ""),
    [options, setOptions] = useState(
      initialContent?.compileAndRunOptions || getPreferredCompileAndRunOptions(defaultLanguage)
    ),
    [generatorCode, setGeneratorCode] = useState(""),
    [standardCode, setStandardCode] = useState(""),
    [aiRefreshKey, setAiRefreshKey] = useState(0),
    [aiCount, setAiCount] = useState(20),
    [subtaskIds, setSubtaskIds] = useState(""),
    [standardUsesFileIo, setStandardUsesFileIo] = useState(false),
    [standardInputFilename, setStandardInputFilename] = useState(""),
    [standardOutputFilename, setStandardOutputFilename] = useState(""),
    [attested, setAttested] = useState(false);
  async function refresh() {
    const [nextInfo, list] = await Promise.all([
      selfEvalApi("info", context),
      selfEvalApi("list", { ...context, page: recordPage })
    ]);
    setInfo(nextInfo);
    setRecords(list.records || []);
    setRecordTotal(list.total || 0);
    setRecordPageSize(list.pageSize || 30);
    if (nextInfo.canManage && nextInfo.profile) {
      setGeneratorCode(nextInfo.programs?.generatorCode || "");
      setStandardCode(nextInfo.programs?.standardCode || "");
      setSubtaskIds((nextInfo.profile.subtaskIds || []).join(", "));
      setStandardUsesFileIo(!!nextInfo.profile.standardFileIo);
      setStandardInputFilename(nextInfo.profile.standardFileIo?.inputFilename || "");
      setStandardOutputFilename(nextInfo.profile.standardFileIo?.outputFilename || "");
    } else if (nextInfo.canManage && nextInfo.subtaskIds) setSubtaskIds(nextInfo.subtaskIds.join(", "));
  }
  useEffect(() => {
    setBusy(true);
    refresh()
      .catch(e => setError(errorText(e)))
      .finally(() => setBusy(false));
  }, [problemId, contestId, recordPage]);
  useEffect(() => {
    if (!isPending(result)) return;
    let live = true;
    const interval = setInterval(async () => {
      try {
        const next = await selfEvalApi("get", { id: result.id });
        if (!live) return;
        setResult(next);
        if (!isPending(next)) await refresh();
      } catch (e) {
        if (live) setError(errorText(e));
      }
    }, 3000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [result?.id, result?.status]);
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const created = await selfEvalApi("create", {
        ...context,
        content: { language, code, compileAndRunOptions: options }
      });
      setResult(await selfEvalApi("get", { id: created.id }));
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Message
        info
        content={tr(
          "Self Eval 仅用于已开启此功能的 NOI / OI 比赛。预测试输入由正式数据的 make.cpp 生成、std.cpp 生成答案，并沿用题目的正式 SPJ。次数全场共用，默认 30 次；不影响正式成绩。",
          "Self Eval is available only in enabled NOI / OI contests. The fixed hidden set uses the official make.cpp and std.cpp, with the problem's official checker. Attempts are shared across the contest (30 by default), without affecting official scores."
        )}
      />
      {error && <Message negative content={error} />}
      {!info && busy && <Loader active inline="centered" />}
      {info && (
        <>
          <div className={style.quota}>
            <Label
              icon="lab"
              content={tr("剩余自测次数", "Remaining attempts") + ": " + info.remaining + " / " + info.limit}
            />
            <Button
              basic
              size="small"
              icon="refresh"
              loading={busy}
              onClick={() => refresh().catch(e => setError(errorText(e)))}
              content={tr("刷新", "Refresh")}
            />
          </div>
          {(!info.enabled || info.reason) && (
            <Message
              warning
              content={reasonText(info.reason) || tr("当前未开启自测。", "Self-evaluation is currently disabled.")}
            />
          )}
          {info.setStatus && !["Ready", "ready"].includes(info.setStatus) && (
            <Message
              content={tr(
                "预测试数据尚未就绪。请管理员在赛前保存 make.cpp、std.cpp 并准备数据。",
                "The pretest set is not ready. A manager must save make.cpp and std.cpp and prepare it before the contest."
              )}
            />
          )}
          {info.canManage && (
            <section className={style.management}>
              <Header as="h3">{tr("配置 Self Eval", "Configure Self Eval")}</Header>
              <p>
                {tr(
                  "填写用于当前正式数据的 C++17 生成器和标准程序。预测试直接沿用正式评测的 SPJ / checker，不需要另填 SPJ。保存并准备数据必须在比赛开始前完成。",
                  "Enter the C++17 generator and standard solution used for the current official data. Self Eval uses the official checker / SPJ automatically. Save and prepare the set before the contest starts."
                )}
              </p>
              <Form>
                <Form.Field>
                  <label>make.cpp</label>
                  <div className={style.managerEditor}>
                    <CodeEditor language={CodeLanguage.Cpp} value={generatorCode} onChange={setGeneratorCode} />
                  </div>
                </Form.Field>
                <Form.Field>
                  <label>std.cpp</label>
                  <div className={style.managerEditor}>
                    <CodeEditor language={CodeLanguage.Cpp} value={standardCode} onChange={setStandardCode} />
                  </div>
                </Form.Field>
                <Form.Input
                  label={tr("子任务 ID（用逗号分隔）", "Subtask IDs (comma separated)")}
                  value={subtaskIds}
                  onChange={(_, value) => setSubtaskIds(value.value)}
                />
                <Form.Checkbox
                  checked={standardUsesFileIo}
                  onChange={(_, value) => setStandardUsesFileIo(value.checked)}
                  label={tr("std.cpp 使用文件输入输出", "std.cpp uses file I/O")}
                />
                {standardUsesFileIo && (
                  <Form.Group widths="equal">
                    <Form.Input
                      label={tr("输入文件名", "Input filename")}
                      value={standardInputFilename}
                      onChange={(_, value) => setStandardInputFilename(value.value)}
                    />
                    <Form.Input
                      label={tr("输出文件名", "Output filename")}
                      value={standardOutputFilename}
                      onChange={(_, value) => setStandardOutputFilename(value.value)}
                    />
                  </Form.Group>
                )}
                <Form.Checkbox
                  checked={attested}
                  onChange={(_, value) => setAttested(value.checked)}
                  label={tr(
                    "我确认 make.cpp 和 std.cpp 用于生成当前正式数据。",
                    "I confirm make.cpp and std.cpp generated the current official data."
                  )}
                />
                <div className={style.actions}>
                  <Button
                    type="button"
                    primary
                    disabled={busy || !attested || !generatorCode.trim() || !standardCode.trim()}
                    loading={busy}
                    onClick={async () => {
                      const ids = subtaskIds
                        .trim()
                        .split(/[\s,，]+/)
                        .map(Number);
                      if (
                        !ids.length ||
                        ids.some(id => !Number.isSafeInteger(id) || id <= 0) ||
                        new Set(ids).size !== ids.length
                      ) {
                        setError(tr("请输入有效且不重复的子任务 ID。", "Enter valid, distinct subtask IDs."));
                        return;
                      }
                      setBusy(true);
                      setError("");
                      try {
                        await selfEvalApi("configureProfile", {
                          ...context,
                          generatorCode,
                          standardCode,
                          subtaskIds: ids,
                          attestSameGenerator: true,
                          ...(standardUsesFileIo
                            ? {
                                standardFileIo: {
                                  inputFilename: standardInputFilename,
                                  outputFilename: standardOutputFilename
                                }
                              }
                            : {})
                        });
                        await refresh();
                        setAttested(false);
                      } catch (e) {
                        setError(errorText(e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {tr("保存 make.cpp / std.cpp", "Save make.cpp / std.cpp")}
                  </Button>
                  <Button
                    type="button"
                    loading={busy}
                    disabled={busy || !info.profile}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        await selfEvalApi("prepare", context);
                        await refresh();
                      } catch (e) {
                        setError(errorText(e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {tr("准备预测试数据", "Prepare pretest data")}
                  </Button>
                </div>
              </Form>
              {appState.currentUserHasPrivilege("UseAi") && appState.currentUserHasPrivilege("GenerateTestdata") && (
                <div className={style.ai}>
                  <p>
                    {tr(
                      "AI 可以生成正式数据并自动绑定同版本的 Self Eval 程序。这会更新此题的正式评测数据；完成后再点击“准备预测试数据”。",
                      "AI can regenerate the official test data and bind matching Self Eval programs automatically. This updates this problem's official data. Prepare the pretest set after the job completes."
                    )}
                  </p>
                  <Form>
                    <Form.Input
                      type="number"
                      min={5}
                      max={1000}
                      label={tr("正式数据组数", "Official test cases")}
                      value={aiCount}
                      onChange={(_, value) => setAiCount(Number(value.value))}
                    />
                    <Button
                      type="button"
                      disabled={busy || !Number.isInteger(aiCount) || aiCount < 5 || aiCount > 1000}
                      loading={busy}
                      onClick={async () => {
                        setBusy(true);
                        setError("");
                        try {
                          await aiCall("start", { problemId, action: "testdata", count: aiCount });
                          setAiRefreshKey(x => x + 1);
                        } catch (e) {
                          setError(errorText(e));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {tr("AI 生成正式数据与 Self Eval 程序", "AI: generate official data and Self Eval programs")}
                    </Button>
                  </Form>
                  <AiJobs
                    problemId={problemId}
                    refreshKey={aiRefreshKey}
                    onCompleted={() => {
                      void refresh().catch(e => setError(errorText(e)));
                    }}
                  />
                </div>
              )}
            </section>
          )}
          {info.enabled && (
            <section className={style.participant}>
              <Header as="h3">{tr("运行 Self Eval", "Run Self Eval")}</Header>
              <Form onSubmit={submit}>
                <CodeLanguageAndOptions
                  pending={busy}
                  allowedLanguages={info.languages?.map((value: string) => value.split(":")[0])}
                  allowedVariants={info.languages}
                  language={language}
                  compileAndRunOptions={options}
                  onUpdateLanguage={setLanguage}
                  onUpdateCompileAndRunOptions={setOptions}
                />
                <div className={style.editor}>
                  <CodeEditor language={language} value={code} onChange={setCode} />
                </div>
                <Button
                  primary
                  type="submit"
                  icon="lab"
                  loading={busy || isPending(result)}
                  disabled={
                    busy ||
                    isPending(result) ||
                    info.remaining <= 0 ||
                    !code.trim() ||
                    info.setStatus !== "Ready" ||
                    !appState.currentUserHasPrivilege("CreateSelfEval")
                  }
                  content={tr("运行 Self Eval", "Run Self Eval")}
                />
              </Form>
            </section>
          )}
        </>
      )}
      {result && (
        <>
          <Header as="h2">
            {tr("自测结果", "Self-evaluation result")} #{result.id}
          </Header>
          <Message>
            <strong>{contestStatusText(result.status)}</strong>
            {result.score == null ? "" : " · " + tr("得分", "Score") + ": " + result.score} ·{" "}
            {result.timeUsed == null ? "—" : result.timeUsed + " ms"} ·{" "}
            {result.memoryUsed == null ? "—" : result.memoryUsed + " KiB"}
          </Message>
          {!!result.feedback?.subtasks?.length && (
            <Table basic="very">
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{tr("子任务", "Subtask")}</Table.HeaderCell>
                  <Table.HeaderCell>{tr("得分", "Score")}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {result.feedback.subtasks.map((subtask: any, index: number) => (
                  <Table.Row key={index}>
                    <Table.Cell>#{index + 1}</Table.Cell>
                    <Table.Cell>
                      {subtask.score} / {subtask.fullScore}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          )}
        </>
      )}
      {!!records.length && (
        <>
          <Header as="h2">{tr("我的自测记录", "My self-evaluations")}</Header>
          <Table basic="very">
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>ID</Table.HeaderCell>
                <Table.HeaderCell>{tr("状态", "Status")}</Table.HeaderCell>
                <Table.HeaderCell>{tr("得分", "Score")}</Table.HeaderCell>
                <Table.HeaderCell>{tr("时间", "Time")}</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {records.map(record => (
                <Table.Row key={record.id}>
                  <Table.Cell>
                    <a
                      href="#"
                      onClick={async event => {
                        event.preventDefault();
                        try {
                          setResult(await selfEvalApi("get", { id: record.id }));
                        } catch (e) {
                          setError(errorText(e));
                        }
                      }}
                    >
                      #{record.id}
                    </a>
                  </Table.Cell>
                  <Table.Cell>{contestStatusText(record.status)}</Table.Cell>
                  <Table.Cell>{record.score ?? "—"}</Table.Cell>
                  <Table.Cell>
                    {new Date(record.createTime).toLocaleString(appState.locale.replace("_", "-"))}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
          {recordTotal > recordPageSize && (
            <Pagination
              firstItem={null}
              lastItem={null}
              activePage={recordPage}
              totalPages={Math.ceil(recordTotal / recordPageSize)}
              onPageChange={(_, value) => setRecordPage(Number(value.activePage))}
            />
          )}
        </>
      )}
    </>
  );
});
