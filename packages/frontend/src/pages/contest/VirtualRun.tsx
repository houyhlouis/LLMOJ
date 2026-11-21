import React, { useEffect, useState } from "react";
import { Button, Header, Message, Segment } from "semantic-ui-react";
import { callContest, formatDate, tr } from "./api";
import style from "./ContestPages.module.less";

/**
 * Virtual participation: after a contest has ended, someone who made no submission in it can take it once, as if it
 * were running, for its official duration. The server applies the contest's rules to their run; these show the run's
 * clock and the way to start one.
 */
export interface VirtualRun {
  startTime: string;
  endTime: string;
}

export interface VirtualParticipation {
  canStart: boolean;
  reason: null | "NOT_ENDED" | "PARTICIPATED" | "ALREADY_USED" | "MANAGER" | "NO_PERMISSION";
  run: VirtualRun | null;
}

/** Whether the viewer is in their virtual run of this contest (from its detail) */
export function virtualRunActive(detail: any, now = Date.now()) {
  const run: VirtualRun | null | undefined = detail?.virtualParticipation?.run;
  return !!run && +new Date(run.startTime) <= now && now < +new Date(run.endTime);
}

/** "1:02:03", or "42:05" under an hour */
export function formatRemaining(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(seconds / 3600),
    m = Math.floor((seconds % 3600) / 60),
    s = seconds % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** A contest's length in words: "2 hours 30 minutes", "2 小时 30 分钟" */
export function formatDuration(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(minutes / 60),
    m = minutes % 60;
  const zh = [h && `${h} 小时`, m && `${m} 分钟`].filter(Boolean).join(" ") || "0 分钟";
  const en =
    [h && `${h} ${h === 1 ? "hour" : "hours"}`, m && `${m} ${m === 1 ? "minute" : "minutes"}`]
      .filter(Boolean)
      .join(" ") || "0 minutes";
  return tr(zh, en);
}

/**
 * The time left in a run, updated every second while it lasts (null without a run), and whether this page saw the run
 * running: a run that ended before the page opened isn't news.
 */
export function useVirtualRunClock(run: VirtualRun | null | undefined, now = () => Date.now()) {
  const end = run ? +new Date(run.endTime) : NaN;
  const [left, setLeft] = useState(() => (run ? end - now() : null));
  const [seenRunning, setSeenRunning] = useState(() => !!run && end - now() > 0);
  useEffect(() => {
    if (!run) {
      setLeft(null);
      return undefined;
    }
    const update = () => setLeft(end - now());
    update();
    if (end - now() <= 0) return undefined;
    setSeenRunning(true);
    const timer = setInterval(() => {
      update();
      if (end - now() <= 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [run?.startTime, run?.endTime]);
  return { left, seenRunning };
}

/** Shown on every page of the contest while the viewer's virtual run lasts */
export function VirtualRunBanner(props: { run: VirtualRun | null | undefined }) {
  const { left, seenRunning } = useVirtualRunClock(props.run);
  if (!props.run || left == null) return null;
  if (left <= 0)
    return !seenRunning ? null : (
      <Message className={style.virtualBanner} size="small">
        {tr(
          "你的虚拟参赛已结束。刷新页面即可查看比赛的最终结果。",
          "Your virtual run has ended. Reload the page to see the contest's final results."
        )}
      </Message>
    );
  return (
    <Message info className={style.virtualBanner} size="small" role="status">
      {tr(
        `虚拟参赛中：比赛按其赛制如同正在进行。结束于 ${formatDate(props.run.endTime)}，剩余 ${formatRemaining(left)}。`,
        `Virtual run: the contest runs for you as if it were live, under its rule. It ends at ${formatDate(
          props.run.endTime
        )}, in ${formatRemaining(left)}.`
      )}
    </Message>
  );
}

/**
 * On an ended contest's overview: the way to start a virtual run, or what became of the viewer's run. Starting asks
 * first, since the clock can't be stopped, then shows the contest as running.
 */
export function VirtualParticipationPanel(props: {
  contestId: number;
  startTime: string;
  endTime: string;
  participation: VirtualParticipation | null | undefined;
  onStarted: (detail: any) => void;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const participation = props.participation;
  if (!participation) return null;
  const duration = formatDuration(+new Date(props.endTime) - +new Date(props.startTime));
  async function start() {
    if (
      !window.confirm(
        tr(
          `虚拟参赛将立即开始，持续 ${duration}，中途不能暂停。现在开始吗？`,
          `Your virtual run starts now and lasts ${duration}; it can't be paused. Start it now?`
        )
      )
    )
      return;
    setPending(true);
    setError("");
    try {
      await callContest("startVirtual", { id: props.contestId });
      props.onStarted(await callContest("detail", { id: props.contestId }));
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  }
  const run = participation.run;
  if (run && +new Date(run.endTime) <= Date.now())
    return (
      <p className={style.description}>
        {tr(
          `你曾在 ${formatDate(run.startTime)} 至 ${formatDate(run.endTime)} 虚拟参加这场比赛。`,
          `You took this contest as a virtual run from ${formatDate(run.startTime)} to ${formatDate(run.endTime)}.`
        )}
      </p>
    );
  if (!participation.canStart) return null;
  return (
    <Segment className={style.virtualPanel}>
      <Header as="h3">{tr("虚拟参赛", "Virtual participation")}</Header>
      <p>
        {tr(
          `比赛已经结束，但你可以像比赛正在进行一样参加一次：用时 ${duration}，按本场比赛的赛制给出反馈，排行榜显示比赛在同一时刻的状态。虚拟参赛不计入正式结果，每场比赛只能参加一次。`,
          `The contest has ended, but you can take it once as if it were live: ${duration}, with the feedback its rule gives, and the standings as they stood at the same point of the contest. A virtual run doesn't count towards the official results, and you get one per contest.`
        )}
      </p>
      {error && <Message negative>{error}</Message>}
      <Button primary loading={pending} disabled={pending} onClick={start}>
        {tr("开始虚拟参赛", "Start virtual participation")}
      </Button>
    </Segment>
  );
}
