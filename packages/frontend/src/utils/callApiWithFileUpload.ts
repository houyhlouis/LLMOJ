import Axios from "axios";

import { ApiResponse } from "@/api";

export interface ApiResponseWithUploadResult<T extends { error?: string }> {
  uploadCancelled?: boolean;
  uploadError?: any;
  requestError?: ApiResponse<T>["requestError"];
  response?: Omit<T, "signedUploadRequest">;
}

export interface FileUploadApiProgress {
  status: "Requesting" | "Uploading" | "Retrying";
  progress: number;
}

interface CallApiWithFileUploadOptions<
  Request extends { uploadInfo?: ApiTypes.FileUploadInfoDto },
  Response extends { error?: string; signedUploadRequest?: ApiTypes.SignedFileUploadRequestDto }
> {
  api: (request: Request) => Promise<ApiResponse<Response>>;
  prepareUploadApi?: (request: Omit<Request, "uploadInfo">, file: Blob) => Promise<ApiResponse<Response>>;
  request: Omit<Request, "uploadInfo">;
  file: Blob;
  onProgress?: (progress: FileUploadApiProgress) => void;
  onCancelAvailable?: (cancel: () => void) => void;
  signal?: AbortSignal;
  // Optional to preserve existing large-file upload behavior.
  uploadTimeoutMs?: number;
  uploadAttempts?: number;
}

// Workaround: xdomain's FormData doesn't set [Symbol.toStringTag] to "FormData"
//             so axios doesn't treat it as FormData
//             see https://github.com/axios/axios/blob/c9aca7525703ab600eacd9e95fd7f6ecc9942616/lib/utils.js#L56
if (FormData.prototype[Symbol.toStringTag] !== "FormData") FormData.prototype[Symbol.toStringTag] = "FormData";

export async function callApiWithFileUpload<
  Request extends { uploadInfo?: ApiTypes.FileUploadInfoDto },
  Response extends { error?: string; signedUploadRequest?: ApiTypes.SignedFileUploadRequestDto }
>(options: CallApiWithFileUploadOptions<Request, Response>): Promise<ApiResponseWithUploadResult<Response>> {
  const cancelTokenSource = Axios.CancelToken.source();
  let isCancelled = false;
  let finished = false;
  let cancelRetryDelay: (() => void) | undefined;
  const cancel = () => {
    if (isCancelled || finished) return;
    isCancelled = true;
    cancelTokenSource.cancel();
    cancelRetryDelay?.();
  };
  const progress = (value: FileUploadApiProgress) => {
    if (!isCancelled && !finished) options.onProgress?.(value);
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (options.signal?.aborted) cancel();
    options.onCancelAvailable?.(cancel);
    if (isCancelled) return { uploadCancelled: true };
    progress({ status: "Requesting", progress: 0 });
    if (isCancelled) return { uploadCancelled: true };

    const result =
      options.file && options.prepareUploadApi
        ? await options.prepareUploadApi(options.request, options.file)
        : await options.api({
            ...options.request,
            uploadInfo: options.file ? { size: options.file.size, uuid: null } : null
          } as Request);
    if (isCancelled || result.requestCancelled) return { uploadCancelled: true };
    if (result.requestError) return result;
    if (!result.response?.signedUploadRequest) return result;

    const signed = result.response.signedUploadRequest;
    const attempts = Number.isFinite(options.uploadAttempts) ? Math.max(1, Math.floor(options.uploadAttempts)) : 5;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (isCancelled) return { uploadCancelled: true };
      let uploadActive = true;
      const config = {
        cancelToken: cancelTokenSource.token,
        timeout: options.uploadTimeoutMs ?? 0,
        onUploadProgress: (event: ProgressEvent<EventTarget>) => {
          // Axios can report a final progress event after an upload has failed.
          setTimeout(() => {
            if (uploadActive && event.total > 0)
              progress({ status: "Uploading", progress: event.loaded / event.total });
          }, 0);
        }
      };
      try {
        let uploaded;
        if (signed.method === "PUT") {
          uploaded = await Axios.put(signed.url, options.file, config);
        } else {
          const formData = new FormData();
          Object.entries(signed.extraFormData || {}).forEach(([key, value]) => formData.append(key, value as string));
          formData.append(signed.fileFieldName, options.file);
          uploaded = await Axios.post(signed.url, formData, config);
        }
        if (isCancelled) return { uploadCancelled: true };
        // Axios 0.x can resolve XHR status 0 during navigation. Only a confirmed
        // HTTP success may trigger the completion API (or start an AI job).
        if (!uploaded || !(uploaded.status >= 200 && uploaded.status < 300))
          throw new Error("The file upload did not receive a successful HTTP response.");
        break;
      } catch (error) {
        if (isCancelled || Axios.isCancel(error)) return { uploadCancelled: true };
        if (attempt === attempts - 1) return { uploadError: error };
        uploadActive = false;
        progress({ status: "Retrying", progress: 0 });
        if (isCancelled) return { uploadCancelled: true };
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            cancelRetryDelay = undefined;
            resolve();
          }, 5000 * Math.random());
          cancelRetryDelay = () => {
            clearTimeout(timer);
            cancelRetryDelay = undefined;
            resolve();
          };
        });
      } finally {
        uploadActive = false;
      }
    }
    if (isCancelled) return { uploadCancelled: true };
    progress({ status: "Requesting", progress: 0 });
    if (isCancelled) return { uploadCancelled: true };
    const completionResult = await options.api({
      ...options.request,
      uploadInfo: { size: options.file.size, uuid: signed.uuid }
    } as Request);
    return isCancelled || completionResult.requestCancelled ? { uploadCancelled: true } : completionResult;
  } catch (error) {
    if (isCancelled || Axios.isCancel(error)) return { uploadCancelled: true };
    throw error;
  } finally {
    finished = true;
    options.signal?.removeEventListener("abort", cancel);
  }
}
