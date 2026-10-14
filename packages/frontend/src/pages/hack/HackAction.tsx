import React, { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { Button, Form, Message, Modal } from "semantic-ui-react";
import { appState } from "@/appState";
import { Link } from "@/utils/hooks";
import { errorText, hackApi, reasonText, tr } from "./api";
import style from "./HackPages.module.less";

const MAX_INPUT_BYTES = 1024 * 1024;

export default observer(function HackAction({ submissionId }: { submissionId: number }) {
  const [open, setOpen] = useState(false),
    [eligibility, setEligibility] = useState<any>(),
    [inputData, setInputData] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [createdId, setCreatedId] = useState<number>();
  useEffect(() => {
    if (!open) return;
    setBusy(true);
    setError("");
    hackApi("eligibility", { submissionId })
      .then(setEligibility)
      .catch(e => setError(errorText(e)))
      .finally(() => setBusy(false));
  }, [open, submissionId]);
  async function readFile(file?: File) {
    if (!file) return;
    if (file.size > MAX_INPUT_BYTES) {
      setError(tr("输入文件最大为 1 MiB。", "The input file must be at most 1 MiB."));
      return;
    }
    try {
      setInputData(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()));
      setError("");
    } catch {
      setError(tr("请上传有效的 UTF-8 文本文件。", "Upload a valid UTF-8 text file."));
    }
  }
  if (!appState.currentUserHasPrivilege("CreateHack")) return null;
  return (
    <>
      <Button
        icon="bug"
        content="Hack"
        onClick={() => {
          setCreatedId(undefined);
          setEligibility(undefined);
          setOpen(true);
        }}
      />
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        closeOnDimmerClick={!busy}
        closeIcon={!busy}
        size="small"
      >
        <Modal.Header>
          {tr("Hack 提交", "Hack submission")} #{submissionId}
        </Modal.Header>
        <Modal.Content>
          {error && <Message negative content={error} />}
          {createdId ? (
            <Message positive>
              {tr("Hack 已提交。", "Hack submitted.")}{" "}
              <Link href={`/hacks/${createdId}`}>
                {tr("查看记录", "View record")} #{createdId}
              </Link>
            </Message>
          ) : (
            <>
              {eligibility && !eligibility.canHack && <Message warning content={reasonText(eligibility.reason)} />}
              <Form loading={busy}>
                <Form.Input
                  id="hack-input-file"
                  type="file"
                  accept="text/plain,.in,.txt"
                  label={tr("上传输入数据（UTF-8，最大 1 MiB）", "Upload input (UTF-8, at most 1 MiB)")}
                  onChange={event => readFile(event.currentTarget.files?.[0])}
                />
                <Form.TextArea
                  id="hack-input-data"
                  className={style.inputEditor}
                  rows={10}
                  label={tr("输入数据", "Input data")}
                  placeholder={tr(
                    "上传文件或粘贴一组符合题目要求的输入",
                    "Upload or paste input satisfying the problem constraints"
                  )}
                  value={inputData}
                  onChange={(_, value) => setInputData(String(value.value))}
                />
              </Form>
            </>
          )}
        </Modal.Content>
        <Modal.Actions>
          <Button disabled={busy} onClick={() => setOpen(false)}>
            {tr("关闭", "Close")}
          </Button>
          {!createdId && (
            <Button
              primary
              icon="bug"
              content={tr("提交 Hack", "Submit hack")}
              loading={busy}
              disabled={busy || !eligibility?.canHack}
              onClick={async () => {
                if (new TextEncoder().encode(inputData).length > MAX_INPUT_BYTES) {
                  setError(tr("输入数据最大为 1 MiB。", "Input data must be at most 1 MiB."));
                  return;
                }
                setBusy(true);
                setError("");
                try {
                  setCreatedId((await hackApi("create", { submissionId, inputData })).id);
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            />
          )}
        </Modal.Actions>
      </Modal>
    </>
  );
});
