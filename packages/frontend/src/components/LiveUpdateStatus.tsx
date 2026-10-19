import React, { useEffect, useRef } from "react";
import { Button, Icon, Message } from "semantic-ui-react";

import { useLocalizer } from "@/utils/hooks";
import type { SocketConnectionState } from "@/utils/hooks";
import { announce } from "@/utils/announce";

interface LiveUpdateStatusProps {
  state: SocketConnectionState;
  // Whether something on the page is still changing (a submission being judged); otherwise nothing is missed
  live: boolean;
  onReload: () => void;
}

// Says when a page's live updates stop, so a stalled view isn't taken for an up-to-date one, and when they resume.
const LiveUpdateStatus: React.FC<LiveUpdateStatusProps> = props => {
  const _ = useLocalizer("common.live_updates");
  const interrupted = props.live && (props.state === "reconnecting" || props.state === "offline");

  const refWasInterrupted = useRef(false);
  useEffect(() => {
    if (interrupted) refWasInterrupted.current = true;
    else if (refWasInterrupted.current && props.state === "connected") {
      refWasInterrupted.current = false;
      announce(_(".resumed"));
    }
  }, [interrupted, props.state]);

  if (!interrupted) return null;
  const offline = props.state === "offline";
  return (
    <Message warning size="small" role="status">
      <Icon name={offline ? "unlink" : "circle notched"} loading={!offline} />
      {_(offline ? ".offline" : ".reconnecting")}
      {offline && (
        <>
          {" "}
          <Button size="mini" compact content={_(".reload")} onClick={props.onReload} />
        </>
      )}
    </Message>
  );
};

export default LiveUpdateStatus;
