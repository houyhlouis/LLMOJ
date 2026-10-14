import React, { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { Button, Message, Popup } from "semantic-ui-react";
import { appState } from "@/appState";
import { Link } from "@/utils/hooks";
import { errorText, hackApi, tr } from "./api";

export default observer(function SubmissionReferenceButton({
  submissionId,
  status
}: {
  submissionId: number;
  status?: string;
}) {
  const [canManage, setCanManage] = useState(false),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<any>();
  useEffect(() => {
    setCanManage(false);
    if (!appState.currentUser || status !== "Accepted") return;
    let current = true;
    hackApi("eligibility", { submissionId })
      .then(value => current && setCanManage(value.canManageConfig))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [submissionId, status, appState.currentUser?.id]);
  if (!canManage) return null;
  return (
    <>
      <Popup
        on="click"
        open={open}
        onOpen={() => setOpen(true)}
        onClose={() => !busy && setOpen(false)}
        trigger={<Button icon="check circle" loading={busy} content={tr("设为此题 STD", "Use as problem STD")} />}
        content={
          <Button
            primary
            loading={busy}
            disabled={busy}
            content={tr("确认设为 STD", "Confirm STD")}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                setResult(await hackApi("useSubmissionReference", { submissionId }));
                setOpen(false);
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          />
        }
      />
      {error && <Message negative content={error} />}
      {result && (
        <Message positive>
          {tr("已设为此题 STD。", "Saved as this problem's STD.")}{" "}
          {result.validatorRequired && tr("请补充输入校验器。", "Add an input validator.")}{" "}
          <Link href={`/p/id/${result.problemId}/hack-reference`}>{tr("管理 STD", "Manage STD")}</Link>
        </Message>
      )}
    </>
  );
});
