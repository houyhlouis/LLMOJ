import React, { useEffect, useState } from "react";
import { Button, Header, Label, Segment, Table } from "semantic-ui-react";
import { observer } from "mobx-react";

import style from "./JudgeMachinePage.module.less";

import api from "@/api";
import toast from "@/utils/toast";
import formatDateTime from "@/utils/formatDateTime";
import { useAsyncCallbackPending, useLocalizer } from "@/utils/hooks";

interface JudgeQueuePanelProps {
  judgeClients: ApiTypes.JudgeClientInfoDto[];
}

const STATE_COLORS = { Leased: "blue", Queued: "grey", Failed: "red" } as const;

/** For site administrators: tasks waiting for or being judged, and recent tasks the queue gave up on. */
const JudgeQueuePanel: React.FC<JudgeQueuePanelProps> = props => {
  const _ = useLocalizer("judge_machine.queue");
  const [status, setStatus] = useState<ApiTypes.JudgeQueueStatusDto>(null);

  const [pending, refresh] = useAsyncCallbackPending(async () => {
    const { requestError, response } = await api.judgeClient.getJudgeQueueStatus();
    if (requestError) toast.error(requestError(_));
    else if (response.error) toast.error(_(`judge_machine.error.${response.error}`));
    else setStatus(response.status);
  });

  useEffect(() => {
    refresh();
  }, []);

  const judgeClientName = (id: number) =>
    props.judgeClients.find(client => client.id === id)?.name ?? (id ? `#${id}` : "");

  return (
    <>
      <div className={style.headerWrapper + " " + style.queueHeader}>
        <Header as="h2" icon="tasks" className={style.header + " withIcon"} content={_(".header")} />
        <Button
          icon="refresh"
          content={_("judge_machine.refresh")}
          labelPosition="left"
          loading={pending}
          onClick={refresh}
        />
      </div>
      {status && (
        <>
          <p className={style.queueSummary}>
            {[
              _(".waiting", { count: String(status.queued) }) +
                (status.oldestQueuedAt
                  ? " " + _(".oldest", { time: formatDateTime(status.oldestQueuedAt)[1] as string })
                  : ""),
              _(".leased", { count: String(status.leased) }),
              _(".failed", { count: String(status.failedRecently) })
            ].join("   ·   ")}
          </p>
          {status.jobs.length === 0 ? (
            <Segment placeholder textAlign="center">
              {_(".empty")}
            </Segment>
          ) : (
            <Table compact>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell className={style.nowrap}>{_(".state")}</Table.HeaderCell>
                  <Table.HeaderCell>{_(".type")}</Table.HeaderCell>
                  <Table.HeaderCell>{_(".task")}</Table.HeaderCell>
                  <Table.HeaderCell>{_(".judge_machine")}</Table.HeaderCell>
                  <Table.HeaderCell title={_(".sent_notes")}>{_(".sent")}</Table.HeaderCell>
                  <Table.HeaderCell title={_(".interrupted_notes")}>{_(".interrupted")}</Table.HeaderCell>
                  <Table.HeaderCell className={style.nowrap}>{_(".created")}</Table.HeaderCell>
                  <Table.HeaderCell>{_(".last_error")}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {status.jobs.map(job => (
                  <Table.Row key={job.taskId}>
                    <Table.Cell className={style.nowrap}>
                      <Label size="small" color={STATE_COLORS[job.state]} content={_(`.states.${job.state}`)} />
                    </Table.Cell>
                    <Table.Cell>{_(`.types.${job.type}`)}</Table.Cell>
                    <Table.Cell title={job.taskId}>
                      <code>{job.taskId.slice(0, 8)}</code>
                    </Table.Cell>
                    <Table.Cell>{judgeClientName(job.judgeClientId)}</Table.Cell>
                    <Table.Cell>{job.fence}</Table.Cell>
                    <Table.Cell>{job.unfinishedLeases + job.preparationFailures || ""}</Table.Cell>
                    <Table.Cell className={style.nowrap} title={formatDateTime(job.createdAt)[1]}>
                      {formatDateTime(job.createdAt)[0]}
                    </Table.Cell>
                    <Table.Cell className={style.lastError} title={job.lastError}>
                      {job.lastError}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          )}
          <p className={style.queueNotes}>{_(".notes")}</p>
        </>
      )}
    </>
  );
};

export default observer(JudgeQueuePanel);
