import streamsaver from "streamsaver";

import pipeStream from "@/utils/pipeStream";
import { saveBlob } from "@/utils/downloadFile";

let ready: Promise<void> = null;

// Firefox has no WritableStream. StreamSaver stays same-origin; HTTP intranet clients get a Blob (below), because
// service workers are unavailable in an insecure context.
function prepare() {
  return (ready ??= (async () => {
    (streamsaver as any).WritableStream = (await import("web-streams-polyfill")).WritableStream;
    (streamsaver as any).mitm = new URL(`${window.apiEndpoint}api/cors/streamsaver/mitm.html`, location.href).href;
  })());
}

/**
 * Saves a stream made in the page (a ZIP being written) as a download, without holding all of it in memory where
 * StreamSaver works. Leaving the page asks first, and stops the download.
 */
export async function saveStream(stream: ReadableStream, filename: string) {
  if (!window.isSecureContext) {
    saveBlob(await new Response(stream).blob(), filename);
    return;
  }
  await prepare();
  const fileStream = streamsaver.createWriteStream(filename);
  const abortCallbackReceiver: { abort?: () => void } = {};

  function stopDownload() {
    abortCallbackReceiver.abort?.();
  }

  // If we are on an insecure context, StreamSaver will use a MITM page to download the file
  // a beforeunload event is triggered by the library (not a user), so ignore it
  let isBeforeUnloadTriggeredByLibrary = !window.isSecureContext;
  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (isBeforeUnloadTriggeredByLibrary) {
      isBeforeUnloadTriggeredByLibrary = false;
      return;
    }
    e.returnValue = "";
  }

  window.addEventListener("unload", stopDownload);
  window.addEventListener("beforeunload", onBeforeUnload);
  try {
    await pipeStream(stream, fileStream, abortCallbackReceiver);
  } finally {
    window.removeEventListener("unload", stopDownload);
    window.removeEventListener("beforeunload", onBeforeUnload);
  }
}
