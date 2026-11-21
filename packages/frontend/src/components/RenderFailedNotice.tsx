import React from "react";

import style from "./RenderFailedNotice.module.less";

import { useLocalizer } from "@/utils/hooks";

/**
 * Shown above content whose formatting couldn't be rendered (e.g. the highlighter or Markdown renderer failed to
 * load): the plain text is shown instead, and this offers to try again.
 */
export const RenderFailedNotice: React.FC<{ onRetry: () => void }> = props => {
  const _ = useLocalizer("components.code_box");
  return (
    <p className={style.notice} role="status">
      {_(".render_failed")}{" "}
      <button type="button" className={style.retry} onClick={props.onRetry}>
        {_(".render_retry")}
      </button>
    </p>
  );
};

/** Text shown as it is when its Markdown couldn't be rendered. React escapes it: nothing in it is markup. */
export const PlainTextFallback: React.FC<{ text: string; className?: string; onRetry: () => void }> = props => (
  <div className={props.className}>
    <RenderFailedNotice onRetry={props.onRetry} />
    <div className={style.plainText}>{props.text}</div>
  </div>
);
