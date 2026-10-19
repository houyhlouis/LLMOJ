import { useEffect, useState } from "react";
import SocketIO, { Socket } from "socket.io-client";
import SocketIOParser from "socket.io-msgpack-parser";

// "reconnecting" after the connection drops; "offline" once several attempts in a row failed (socket.io keeps
// trying) or the server closed it on purpose (socket.io won't retry). Pages show these, so a stalled live view
// doesn't look up to date.
export type SocketConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "offline";

const FAILED_ATTEMPTS_BEFORE_OFFLINE = 5;

export function useSocket(
  namespace: string,
  query: Record<string, string>,
  onInit: (socket: Socket) => void,
  onConnect: (socket: Socket) => void,
  useOrNot: boolean
): SocketConnectionState {
  const [state, setState] = useState<SocketConnectionState>(useOrNot ? "connecting" : "idle");

  useEffect(() => {
    if (useOrNot) {
      const socket = SocketIO(window.apiEndpoint + namespace, {
        path: "/api/socket",
        transports: ["websocket"],
        query: query,
        ...{ parser: SocketIOParser }
      });
      let failedAttempts = 0;
      socket.on("error", (error: Error) => console.log("SocketIO error:", error));
      socket.on("disconnect", reason => {
        console.log("SocketIO disconnect:", reason);
        if (reason === "io client disconnect") return;
        setState(reason === "io server disconnect" ? "offline" : "reconnecting");
      });
      // Every failed attempt to (re)connect
      socket.on("connect_error", () => {
        failedAttempts++;
        setState(failedAttempts >= FAILED_ATTEMPTS_BEFORE_OFFLINE ? "offline" : "reconnecting");
      });
      socket.io.on("reconnect", attempt => console.log("SocketIO reconnect:", attempt));
      socket.on("connect", () => {
        failedAttempts = 0;
        setState("connected");
        onConnect(socket);
      });
      onInit(socket);
      return () => {
        socket.disconnect();
      };
    }
  }, []);

  return state;
}
