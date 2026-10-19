import React, { useEffect, useState } from "react";
import { Table, Header, Button, Segment, Label, Popup, Icon, Form, Message } from "semantic-ui-react";
import { observer } from "mobx-react";

import style from "./JudgeMachinePage.module.less";

import { useAsyncCallbackPending, useLocalizer, useNavigationChecked } from "@/utils/hooks";
import api from "@/api";
import toast from "@/utils/toast";
import { appState } from "@/appState";
import { defineRoute, RouteError } from "@/AppRouter";
import { onEnterPress } from "@/utils/onEnterPress";
import { EmojiRenderer } from "@/components/EmojiRenderer";

import JudgeQueuePanel from "./JudgeQueuePanel";
import { actsAsButton } from "@/utils/keyboard";

interface JudgeClientSystemInfo {
  os: string;
  kernel: string;
  arch: string;
  cpu: {
    model: string;
    flags: string;
    cache: Record<string, number>;
  };
  memory: {
    size: number;
    description: string;
  };
  languages: {};
  extraInfo: string;
}

async function fetchData(): Promise<JudgeMachinePageProps> {
  const { requestError, response } = await api.judgeClient.listJudgeClients();
  if (requestError) throw new RouteError(requestError);
  else return response;
}

interface JudgeMachinePageProps {
  hasManagePermission: boolean;
  judgeClients: ApiTypes.JudgeClientInfoDto[];
}

let JudgeMachinePage: React.FC<JudgeMachinePageProps> = props => {
  const _ = useLocalizer("judge_machine");
  const navigation = useNavigationChecked();

  useEffect(() => {
    appState.enterNewPage(_(".title"), null, false);
  }, [appState.locale]);

  function getCpu(judgeClient: ApiTypes.JudgeClientInfoDto) {
    if (judgeClient.systemInfo && judgeClient.systemInfo) {
      const systemInfo = judgeClient.systemInfo as JudgeClientSystemInfo;
      const hasFlags = !!systemInfo.cpu.flags;
      const hasCache =
        systemInfo.cpu.cache &&
        typeof systemInfo.cpu.cache === "object" &&
        Object.keys(systemInfo.cpu.cache).length !== 0;
      return (
        <Popup
          trigger={<span>{systemInfo.cpu.model}</span>}
          disabled={!hasFlags && !hasCache}
          content={
            <>
              {hasFlags && (
                <>
                  <Header content="Flags" />
                  <p className={style.cpuFlags}>
                    <code>{systemInfo.cpu.flags}</code>
                  </p>
                </>
              )}
              {hasCache && (
                <>
                  <Header content="Cache" />
                  <table className={style.cpuCache}>
                    <tbody>
                      {Object.entries(systemInfo.cpu.cache).map(([name, value]) => (
                        <tr key={name}>
                          <td align="left" className={style.cpuCacheName}>
                            <strong>{name}</strong>
                          </td>
                          <td>{Math.round(value / 1024) + " KiB"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          }
          hoverable
          position="bottom center"
        />
      );
    }
    return "-";
  }

  function getMemory(judgeClient: ApiTypes.JudgeClientInfoDto) {
    if (judgeClient.systemInfo && judgeClient.systemInfo) {
      const systemInfo = judgeClient.systemInfo as JudgeClientSystemInfo;
      return systemInfo.memory.description + " (" + Math.round(systemInfo.memory.size / 1024) + " MiB)";
    }
    return "-";
  }

  function getKernel(judgeClient: ApiTypes.JudgeClientInfoDto) {
    if (judgeClient.systemInfo && judgeClient.systemInfo) {
      const systemInfo = judgeClient.systemInfo as JudgeClientSystemInfo;
      return systemInfo.kernel;
    }
    return "-";
  }

  // A drained judge machine has finished its tasks and gets no new ones, so it can be stopped or updated
  function getStatus(judgeClient: ApiTypes.JudgeClientInfoDto) {
    if (!judgeClient.online)
      return { color: "red" as const, text: judgeClient.draining ? _(".offline_drained") : _(".offline") };
    if (!judgeClient.draining) return { color: "green" as const, text: _(".online") };
    if (judgeClient.runningTasks) return { color: "yellow" as const, text: _(".draining") };
    return { color: "grey" as const, text: _(".drained") };
  }

  function getCapacity(judgeClient: ApiTypes.JudgeClientInfoDto) {
    const capabilities = judgeClient.capabilities;
    if (!capabilities) {
      if (!judgeClient.online) return "-";
      return (
        <Popup
          trigger={<Label size="small" content={_(".capabilities.legacy")} />}
          content={_(".capabilities.legacy_notes")}
          position="bottom center"
        />
      );
    }
    const rows: [string, React.ReactNode][] = [
      [_(".capabilities.task_types"), capabilities.taskTypes.map(type => _(`.queue.types.${type}`)).join(", ")],
      [_(".capabilities.consumer_threads"), capabilities.consumerThreads],
      [_(".capabilities.execution_slots"), capabilities.executionSlots],
      [_(".capabilities.ai_execution_slots"), capabilities.aiExecutionSlots],
      [_(".capabilities.memory_budget"), capabilities.memoryBudget + " MiB"],
      [_(".capabilities.protocol_version"), capabilities.protocolVersion]
    ];
    const { runtime } = capabilities;
    if (runtime)
      rows.push(
        [
          _(".capabilities.judge_program"),
          <code title={runtime.judgeProgram}>{runtime.judgeProgram.slice(0, 12)}</code>
        ],
        [
          _(".capabilities.sandbox_image"),
          <code title={runtime.sandboxImage}>{runtime.sandboxImage.slice(0, 12)}</code>
        ],
        ["Node.js", runtime.node]
      );
    return (
      <Popup
        trigger={
          <span>
            {_(".capabilities.summary", {
              slots: String(capabilities.executionSlots),
              memory: String(capabilities.memoryBudget)
            })}
          </span>
        }
        content={
          <table className={style.capabilities}>
            <tbody>
              {rows.map(([name, value]) => (
                <tr key={name}>
                  <td className={style.capabilityName}>
                    <strong>{name}</strong>
                  </td>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        }
        hoverable
        position="bottom center"
      />
    );
  }

  // Keys aren't part of the list. Clicking the key icon fetches one (asking for the password if it wasn't entered
  // recently), shows it in a popup, and forgets it when the popup closes.
  const [shownKey, setShownKey] = useState<{ id: number; key: string }>(null);
  async function onShowKey(id: number) {
    const { requestError, response } = await api.judgeClient.getJudgeClientKey({ id });
    if (requestError) toast.error(requestError(_));
    else if (response.error) toast.error(_(`.error.${response.error}`));
    else setShownKey({ id, key: response.key });
  }

  const [resetPopupOpened, setResetPopupOpened] = useState<number>(null);
  async function onResetKey(id: number) {
    const { requestError, response } = await api.judgeClient.resetJudgeClientKey({
      id
    });
    if (requestError) toast.error(requestError(_));
    else if (response.error) toast.error(_(`.error.${response.error}`));
    else {
      toast.success(_(".reset_key_success"));
      navigation.refresh();
      setResetPopupOpened(null);
    }
  }

  const [drainPopupOpened, setDrainPopupOpened] = useState<number>(null);
  const [drainPending, onSetDraining] = useAsyncCallbackPending(async (id: number, draining: boolean) => {
    const { requestError, response } = await api.judgeClient.setJudgeClientDraining({ id, draining });
    if (requestError) toast.error(requestError(_));
    else if (response.error) toast.error(_(`.error.${response.error}`));
    else {
      toast.success(draining ? _(".drain_success") : _(".resume_success"));
      navigation.refresh();
      setDrainPopupOpened(null);
    }
  });

  const [deletePopupOpened, setDeletePopupOpened] = useState<number>(null);
  async function onDelete(id: number) {
    const { requestError, response } = await api.judgeClient.deleteJudgeClient({
      id
    });
    if (requestError) toast.error(requestError(_));
    else if (response.error) toast.error(_(`.error.${response.error}`));
    else {
      toast.success(_(".delete_success"));
      navigation.refresh();
      setDeletePopupOpened(null);
    }
  }

  const [addPopupOpened, setAddPopupOpened] = useState(false);
  const [addNewName, setAddNewName] = useState("");
  const addNewNameValid = addNewName.length >= 1 && addNewName.length <= 80;
  const [addPending, onAddJudgeClient] = useAsyncCallbackPending(async () => {
    if (addPending) return;

    const { requestError, response } = await api.judgeClient.addJudgeClient({
      name: addNewName,
      allowedHosts: []
    });
    if (requestError) toast.error(requestError(_));
    else if (response.error) toast.error(_(`.error.${response.error}`));
    else {
      toast.success(_(".add_success"));
      navigation.refresh();
    }

    setAddPopupOpened(false);
    setAddNewName("");
  });

  // Judge machines with different judge programs or sandbox images may judge the same submission differently
  const onlineRuntimes = props.judgeClients
    .filter(judgeClient => judgeClient.online && judgeClient.capabilities?.runtime)
    .map(judgeClient => judgeClient.capabilities.runtime);
  const runtimesDiffer =
    new Set(onlineRuntimes.map(runtime => runtime.judgeProgram)).size > 1 ||
    new Set(onlineRuntimes.map(runtime => runtime.sandboxImage)).size > 1;

  return (
    <>
      <div className={style.headerWrapper}>
        <Header as="h1" icon="server" className={style.header + " withIcon"} content={_(".header")} />
        <Button icon="refresh" content={_(".refresh")} labelPosition="left" onClick={() => navigation.refresh()} />
        {props.hasManagePermission && (
          <Popup
            open={addPopupOpened || addPending}
            onOpen={() => setAddPopupOpened(true)}
            onClose={() => setAddPopupOpened(false)}
            content={
              <Form>
                <Form.Input
                  style={{ width: 230 }}
                  placeholder={_(".add_new_name")}
                  value={addNewName}
                  onChange={(e, { value }) => setAddNewName(value)}
                  onKeyPress={onEnterPress(() => addNewNameValid && onAddJudgeClient())}
                />
                <Button loading={addPending} disabled={!addNewNameValid} onClick={onAddJudgeClient}>
                  {_(".confirm_add")}
                </Button>
              </Form>
            }
            trigger={
              <Button className={style.addButton} icon="plus" content={_(".add")} labelPosition="left" primary />
            }
            on="click"
            position="bottom right"
          />
        )}
      </div>
      {runtimesDiffer && (
        <Message
          warning
          icon="exclamation triangle"
          header={_(".runtime_mismatch")}
          content={_(".runtime_mismatch_notes")}
        />
      )}
      {!props.judgeClients.length ? (
        <Segment placeholder>
          <Header icon>
            <Icon name="server" />
            {_(".no_judge_machine")}
          </Header>
        </Segment>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell className={style.nowrap}>{_(".status")}</Table.HeaderCell>
              <Table.HeaderCell className={style.nowrap}>{_(".name")}</Table.HeaderCell>
              <Table.HeaderCell>{_(".cpu")}</Table.HeaderCell>
              <Table.HeaderCell>{_(".memory")}</Table.HeaderCell>
              <Table.HeaderCell className={style.nowrap}>{_(".kernel")}</Table.HeaderCell>
              <Table.HeaderCell className={style.nowrap}>{_(".capacity")}</Table.HeaderCell>
              <Table.HeaderCell className={style.nowrap} title={_(".running_tasks_notes")}>
                {_(".running_tasks")}
              </Table.HeaderCell>
              {props.hasManagePermission && (
                <Table.HeaderCell textAlign="center" className={style.columnOperations}>
                  {_(".operations")}
                </Table.HeaderCell>
              )}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {props.judgeClients.map(judgeClient => (
              <Table.Row key={judgeClient.id}>
                <Table.Cell className={style.nowrap}>
                  <div className={style.status}>
                    <Label className={style.onlineStatus} circular color={getStatus(judgeClient).color} empty />
                    {getStatus(judgeClient).text}
                  </div>
                </Table.Cell>
                <EmojiRenderer>
                  <Table.Cell className={style.nowrap}>{judgeClient.name}</Table.Cell>
                </EmojiRenderer>
                <Table.Cell>{getCpu(judgeClient)}</Table.Cell>
                <Table.Cell>{getMemory(judgeClient)}</Table.Cell>
                <Table.Cell className={style.nowrap}>{getKernel(judgeClient)}</Table.Cell>
                <Table.Cell className={style.nowrap}>{getCapacity(judgeClient)}</Table.Cell>
                <Table.Cell>{judgeClient.runningTasks}</Table.Cell>
                {props.hasManagePermission && (
                  <Table.Cell textAlign="center" className={style.columnOperations}>
                    <Popup
                      open={shownKey?.id === judgeClient.id}
                      onOpen={() => onShowKey(judgeClient.id)}
                      onClose={() => setShownKey(null)}
                      trigger={<Icon {...actsAsButton} aria-label={_(".key")} name="key" title={_(".key")} />}
                      content={<code>{shownKey?.key}</code>}
                      on="click"
                      position="left center"
                    />
                    <Popup
                      open={resetPopupOpened === judgeClient.id}
                      onOpen={() => setResetPopupOpened(judgeClient.id)}
                      onClose={() => setResetPopupOpened(null)}
                      trigger={
                        <Icon {...actsAsButton} aria-label={_(".reset_key")} name="refresh" title={_(".reset_key")} />
                      }
                      content={
                        <>
                          <p className={style.confirmNotes}>{_(".reset_key_notes")}</p>
                          <Button
                            negative
                            content={_(".confirm_reset_key")}
                            onClick={() => onResetKey(judgeClient.id)}
                          />
                        </>
                      }
                      on="click"
                      position="left center"
                    />
                    <Popup
                      open={drainPopupOpened === judgeClient.id}
                      onOpen={() => setDrainPopupOpened(judgeClient.id)}
                      onClose={() => setDrainPopupOpened(null)}
                      trigger={
                        judgeClient.draining ? (
                          <Icon name="play circle outline" title={_(".resume")} />
                        ) : (
                          <Icon name="pause circle outline" title={_(".drain")} />
                        )
                      }
                      content={
                        <>
                          <p className={style.confirmNotes}>
                            {judgeClient.draining ? _(".resume_notes") : _(".drain_notes")}
                          </p>
                          <Button
                            primary={judgeClient.draining}
                            loading={drainPending}
                            content={judgeClient.draining ? _(".confirm_resume") : _(".confirm_drain")}
                            onClick={() => onSetDraining(judgeClient.id, !judgeClient.draining)}
                          />
                        </>
                      }
                      on="click"
                      position="left center"
                    />
                    <Popup
                      open={deletePopupOpened === judgeClient.id}
                      onOpen={() => setDeletePopupOpened(judgeClient.id)}
                      onClose={() => setDeletePopupOpened(null)}
                      trigger={<Icon {...actsAsButton} aria-label={_(".delete")} name="delete" title={_(".delete")} />}
                      content={
                        <Button negative content={_(".confirm_delete")} onClick={() => onDelete(judgeClient.id)} />
                      }
                      on="click"
                      position="left center"
                    />
                  </Table.Cell>
                )}
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
      {props.hasManagePermission && <JudgeQueuePanel judgeClients={props.judgeClients} />}
    </>
  );
};

JudgeMachinePage = observer(JudgeMachinePage);

export default defineRoute(async request => <JudgeMachinePage {...await fetchData()} />);
