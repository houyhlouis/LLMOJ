export interface BrowserFileReadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function readBrowserFile(
  file: Blob,
  format: "text" | "dataURL",
  options?: BrowserFileReadOptions
): Promise<string>;
export function readBrowserFile(
  file: Blob,
  format: "arrayBuffer",
  options?: BrowserFileReadOptions
): Promise<ArrayBuffer>;
export function readBrowserFile(
  file: Blob,
  format: "text" | "dataURL" | "arrayBuffer",
  { signal, timeoutMs = 60000 }: BrowserFileReadOptions = {}
): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("File reading was cancelled.", "AbortError"));
      return;
    }
    const reader = new FileReader();
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reader.onload = reader.onerror = reader.onabort = null;
      if (error) reject(error);
      else resolve(reader.result);
    };
    const cancel = () => {
      finish(new DOMException("File reading was cancelled.", "AbortError"));
      reader.abort();
    };
    reader.onload = () => finish();
    reader.onerror = () => finish(reader.error || new Error("File reading failed."));
    reader.onabort = () => finish(new DOMException("File reading was cancelled.", "AbortError"));
    signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      finish(new DOMException("File reading timed out.", "TimeoutError"));
      reader.abort();
    }, timeoutMs);
    try {
      if (format === "text") reader.readAsText(file);
      else if (format === "dataURL") reader.readAsDataURL(file);
      else reader.readAsArrayBuffer(file);
    } catch (error) {
      finish(error);
    }
  });
}
