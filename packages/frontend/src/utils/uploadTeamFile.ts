import { callApiWithFileUpload } from "./callApiWithFileUpload";

// Only team files use this reservation/chunk workflow. Other uploads retain
// their existing size checks and signed single-object requests.
export async function uploadTeamFile({
  teamId,
  file,
  request,
  signal,
  onProgress
}: {
  teamId: number;
  file: File;
  request: (action: string, body: unknown) => Promise<any>;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}): Promise<{ fileId: number }> {
  let session: { uuid: string; size: number; partSize: number; partCount: number };
  let completed = false;
  const checkCancelled = () => {
    if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
  };
  try {
    checkCancelled();
    const prepared = await request("prepareFileUpload", { teamId, size: file.size });
    session = prepared.uploadSession;
    checkCancelled();
    if (
      !session ||
      session.size !== file.size ||
      !Number.isSafeInteger(session.partSize) ||
      session.partSize <= 0 ||
      session.partCount !== (file.size > session.partSize ? Math.ceil(file.size / session.partSize) : 0)
    )
      throw new Error("Invalid upload session");
    const count = session.partCount || 1;
    for (let index = 0; index < count; index++) {
      checkCancelled();
      const offset = index * session.partSize;
      const part = session.partCount ? file.slice(offset, Math.min(file.size, offset + session.partSize)) : file;
      // eslint-disable-next-line no-await-in-loop -- Sequential chunks bound memory and allow precise cancellation.
      const result = await callApiWithFileUpload<any, any>({
        file: part,
        request: {},
        signal,
        prepareUploadApi: async () => ({
          response: session.partCount
            ? await request("prepareFileUploadPart", { teamId, uuid: session.uuid, part: index + 1 })
            : prepared
        }),
        api: async () => ({ response: { uploaded: true } }),
        onProgress: progress => {
          if (progress.status === "Uploading")
            onProgress?.(file.size ? (offset + part.size * progress.progress) / file.size : 1);
        }
      });
      if (result.uploadCancelled) throw new DOMException("Upload cancelled", "AbortError");
      if (result.uploadError || result.requestError || !result.response?.uploaded)
        throw new Error("File upload failed");
      onProgress?.(file.size ? Math.min(file.size, offset + part.size) / file.size : 1);
    }
    checkCancelled();
    const result = await request("uploadFile", {
      teamId,
      name: file.name,
      uploadInfo: { uuid: session.uuid, size: file.size }
    });
    if (!result?.fileId) throw new Error("File upload failed");
    completed = true;
    onProgress?.(1);
    return result;
  } finally {
    if (session && !completed) {
      try {
        await request("cancelFileUpload", { teamId, uuid: session.uuid });
      } catch {
        // The server also expires reservations when the session has ended.
      }
    }
  }
}
