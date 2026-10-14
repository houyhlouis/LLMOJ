import React, { useState } from "react";
import { observer } from "mobx-react";
import { Button, Modal } from "semantic-ui-react";
import { appState } from "@/appState";
import { tr } from "@/pages/hack/api";
import SelfEvalPanel, { SelfEvalContent } from "./SelfEvalPanel";
export default observer(function SelfEvalButton({
  problemId,
  contestId,
  initialContent,
  trigger
}: {
  problemId: number;
  contestId?: number;
  initialContent?: Partial<SelfEvalContent>;
  trigger?: React.ReactElement;
}) {
  const [open, setOpen] = useState(false);
  if (!contestId || !appState.currentUser || !appState.currentUserHasPrivilege("CreateSelfEval")) return null;
  return (
    <>
      {trigger ? (
        React.cloneElement(trigger, { onClick: () => setOpen(true) })
      ) : (
        <Button type="button" icon="lab" content={tr("自测", "Self Eval")} onClick={() => setOpen(true)} />
      )}
      <Modal open={open} onClose={() => setOpen(false)} closeIcon size="large">
        <Modal.Header>{tr("自测", "Self Eval")}</Modal.Header>
        <Modal.Content>
          {open && <SelfEvalPanel problemId={problemId} contestId={contestId} initialContent={initialContent} />}
        </Modal.Content>
      </Modal>
    </>
  );
});
