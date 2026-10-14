import React, { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { Button, Header, Icon, Message, Popup, Segment } from "semantic-ui-react";
import { appState } from "@/appState";
import { defineRoute } from "@/AppRouter";
import { Link } from "@/utils/hooks";
import formatFileSize from "@/utils/formatFileSize";
import { dateText, errorText, hackApi, HackRecord, problemUrl, statusText, submissionUrl, tr } from "./api";
import HackTestcase from "./HackTestcase";
import style from "./HackPages.module.less";

const HackPage = observer(function HackPage({ initial, embedded }: { initial: HackRecord; embedded?: boolean }) {
  const [record, setRecord] = useState(initial),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmOpen, setConfirmOpen] = useState(false);
  const active = useRef(true),
    refreshGeneration = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!embedded) appState.enterNewPage(`${tr("Hack 记录", "Hack")} #${record.id}`, "hacks");
  }, [appState.locale, record.id, embedded]);
  async function refresh() {
    const generation = ++refreshGeneration.current;
    try {
      const result = await hackApi("get", { id: record.id });
      if (active.current && generation === refreshGeneration.current) {
        setRecord(result);
        setError("");
      }
    } catch (e) {
      if (active.current && generation === refreshGeneration.current) setError(errorText(e));
    }
  }
  useEffect(() => {
    if (record.status !== "Pending" && record.status !== "Running") return;
    let live = true,
      refreshing = false;
    const interval = setInterval(async () => {
      if (!live || refreshing) return;
      refreshing = true;
      try {
        await refresh();
      } finally {
        refreshing = false;
      }
    }, 3000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [record.id, record.status]);
  return (
    <>
      {!embedded && (
        <div className={style.toolbar}>
          <Header as="h1" className="withIcon">
            <Icon name="bug" />
            Hack #{record.id}
          </Header>
          <Button
            as={Link}
            href={record.contestId ? `/contest/${record.contestId}/hacks` : "/hacks"}
            className={style.myHacks}
          >
            {tr("全部 Hack", "All hacks")}
          </Button>
        </div>
      )}
      {error && <Message negative content={error} />}
      <Segment>
        <div className={style.detailGrid}>
          <div>
            <strong>{tr("状态", "Status")}: </strong>
            <span className={style[`status${record.status}`]}>{statusText(record.status)}</span>
          </div>
          <div>
            <strong>{tr("目标提交", "Target submission")}: </strong>
            <Link href={submissionUrl(record)}>#{record.submissionId}</Link>
          </div>
          <div>
            <strong>{tr("题目", "Problem")}: </strong>
            <Link href={problemUrl(record)}>
              P{record.problemId}
              {record.problemTitle ? ` ${record.problemTitle}` : ""}
            </Link>
          </div>
          <div>
            <strong>{tr("提交者", "Submitter")}: </strong>
            <Link href={`/u/${record.submitter.username}`}>{record.submitter.username}</Link>
          </div>
          <div>
            <strong>Hacker: </strong>
            <Link href={`/u/${record.hacker.username}`}>{record.hacker.username}</Link>
          </div>
          <div>
            <strong>{tr("Hack 时间", "Hack time")}: </strong>
            {dateText(record.createTime)}
          </div>
          <div>
            <strong>{tr("运行时间", "Runtime")}: </strong>
            {record.timeUsed == null ? "—" : `${Math.round(record.timeUsed)} ms`}
          </div>
          <div>
            <strong>{tr("运行内存", "Memory")}: </strong>
            {record.memoryUsed == null ? "—" : formatFileSize(record.memoryUsed * 1024, 1)}
          </div>
        </div>
      </Segment>
      {record.status === "Success" && (
        <Message
          positive
          content={tr(
            "有效反例已记录，目标提交已按照相应题库或比赛规则处理。",
            "A valid counterexample has been recorded. The target submission has been updated according to the problem or contest rules."
          )}
        />
      )}
      <HackTestcase record={record} />
      {record.canManage && record.status !== "Success" && record.status !== "Pending" && record.status !== "Running" && (
        <Popup
          on="click"
          open={confirmOpen}
          onOpen={() => setConfirmOpen(true)}
          onClose={() => setConfirmOpen(false)}
          trigger={<Button loading={busy} icon="refresh" content={tr("重新评测 Hack", "Rejudge hack")} />}
          content={
            <Button
              negative
              loading={busy}
              disabled={busy}
              content={tr("确认重新评测", "Confirm rejudge")}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await hackApi("rejudge", { id: record.id });
                  if (active.current) await refresh();
                } catch (e) {
                  if (active.current) setError(errorText(e));
                } finally {
                  if (active.current) {
                    setBusy(false);
                    setConfirmOpen(false);
                  }
                }
              }}
            />
          }
        />
      )}
    </>
  );
});
export async function loadHackPage(hackId: number, embedded = false) {
  return <HackPage key={hackId} initial={await hackApi("get", { id: hackId })} embedded={embedded} />;
}

export default defineRoute(async request => loadHackPage(Number(request.params.hackId)));
