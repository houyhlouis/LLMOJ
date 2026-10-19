import React, { useEffect, useRef } from "react";
import { Header, Menu, Button, Checkbox } from "semantic-ui-react";
import { observer } from "mobx-react";

import style from "./SubmitViewFrame.module.less";

import { useLocalizer, Link } from "@/utils/hooks";
import StatusText from "@/components/StatusText";
import ScoreText from "@/components/ScoreText";
import { actsAsButton } from "@/utils/keyboard";

interface SubmitViewFrameProps {
  showSkipSamples: boolean;
  mainContent: React.ReactNode;
  sidebarContent: React.ReactNode;
  submitDisabled: boolean;
  onGetSubmitFile?: () => Promise<Blob>;

  inSubmitView: boolean;
  pendingSubmit: boolean;
  lastSubmission: ApiTypes.ProblemLastSubmissionDto;
  submissionContent: unknown;
  onCloseSubmitView: () => void;
  onUpdateSubmissionContent: (path: string, value: unknown) => void;
  onSubmit: (onGetSubmitFile?: () => Promise<Blob>) => void;
}

let SubmitViewFrame: React.FC<SubmitViewFrameProps> = props => {
  const _ = useLocalizer("problem");

  // Opening the submit view continues in its editor (with a keyboard; a touch screen would only show its keyboard),
  // or else at its first control.
  const refView = useRef<HTMLDivElement>();
  useEffect(() => {
    if (!props.inSubmitView || !refView.current) return;
    const view = refView.current;
    const editor =
      window.matchMedia?.("(pointer: fine)").matches && view.querySelector<HTMLElement>(".monaco-editor textarea");
    (
      editor ||
      view.querySelector<HTMLElement>('a[href], button:not([disabled]), input:not([type="hidden"]), [tabindex="0"]')
    )?.focus();
  }, [props.inSubmitView]);

  return (
    <div
      ref={refView}
      className={style.submitView}
      style={{ display: props.inSubmitView ? null : "none" }}
      role="region"
      aria-label={_(".submit.submit")}
    >
      <div className={style.leftContainer}>{props.mainContent}</div>
      <div className={style.rightContainer}>
        <Menu pointing secondary vertical className={style.actionMenu}>
          <Menu.Item
            {...actsAsButton}
            name={_(".submit.back_to_statement")}
            icon="arrow left"
            onClick={props.onCloseSubmitView}
          />
          <div />
        </Menu>
        {props.sidebarContent}
        {props.showSkipSamples && (
          <Checkbox
            className={style.skipSamples}
            label={_(".submit.skip_samples")}
            checked={(props.submissionContent as any).skipSamples}
            onChange={(e, { checked }) => props.onUpdateSubmissionContent("skipSamples", checked)}
          />
        )}
        <Button
          className={style.submitButton}
          primary
          fluid
          icon="paper plane"
          loading={props.pendingSubmit}
          disabled={props.submitDisabled}
          content={_(".submit.submit")}
          onClick={() => props.onSubmit(props.onGetSubmitFile)}
        />
        {props.lastSubmission && props.lastSubmission.lastSubmission && (
          <div className={style.lastSubmission}>
            <Header size="tiny" content={_(".submit.last_submission")} />
            <Link href={`/s/${props.lastSubmission.lastSubmission.id}`}>
              <StatusText status={props.lastSubmission.lastSubmission.status} />
            </Link>
            <Link className={style.scoreText} href={`/s/${props.lastSubmission.lastSubmission.id}`}>
              <ScoreText score={props.lastSubmission.lastSubmission.score || 0} />
            </Link>
          </div>
        )}
      </div>
    </div>
  );
};

SubmitViewFrame = observer(SubmitViewFrame);

interface EditorWrapperProps {
  disabled?: boolean;
  children?: React.ReactNode;
}

const EditorWrapper: React.FC<EditorWrapperProps> = props => {
  return <div className={style.editorWrapper + (props.disabled ? " " + style.disabled : "")}>{props.children}</div>;
};

export default Object.assign(SubmitViewFrame, {
  EditorWrapper
});
