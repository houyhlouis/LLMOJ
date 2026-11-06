import { appState } from "@/appState";
import { createZipStream } from "@/utils/zip";
import { saveStream } from "@/utils/saveStream";
import { saveBlob } from "@/utils/downloadFile";

import { callContest } from "./api";

/**
 * A contest's problems as one ZIP: statements.pdf (every statement, in contest order) and a folder per problem, named
 * as the problem, with its samples (sample1.in, sample1.ans, …) and the attachments the viewer may download. The
 * server decides what goes in and makes the PDF; the page writes the ZIP, fetching attachments from their signed
 * links (as "download all files" does), so large attachments aren't held in memory where the browser can stream.
 */

export interface ArchiveFile {
  name: string;
  text?: string;
  url?: string;
  size?: number;
}

export interface ArchiveManifest {
  filename: string;
  /** base64 */
  pdf: string;
  pages: number;
  warnings: { kind: "image" | "formula"; source: string; message: string }[];
  folders: { name: string; label: string; files: ArchiveFile[] }[];
  attachmentsWithheld: boolean;
  attachments: number;
}

export type ArchiveEntry =
  | { path: string; directory: true }
  | { path: string; bytes: Uint8Array<ArrayBuffer> }
  | { path: string; text: string }
  | { path: string; url: string };

function base64Bytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** What the ZIP holds, in order: the PDF, then each problem's folder and files */
export function archiveEntries(manifest: ArchiveManifest): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [{ path: "statements.pdf", bytes: base64Bytes(manifest.pdf) }];
  for (const folder of manifest.folders) {
    entries.push({ path: folder.name, directory: true });
    for (const file of folder.files) {
      const path = `${folder.name}/${file.name}`;
      if (file.url) entries.push({ path, url: file.url });
      else entries.push({ path, text: file.text ?? "" });
    }
  }
  return entries;
}

export interface ArchiveProgress {
  stage: "preparing" | "downloading";
  done?: number;
  total?: number;
}

/** Downloads the contest's archive; resolves when the ZIP has been written */
export async function downloadContestArchive(contestId: number, onProgress: (progress: ArchiveProgress) => void) {
  onProgress({ stage: "preparing" });
  let timeZone = "UTC";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    // UTC
  }
  const manifest: ArchiveManifest = await callContest("archive", {
    id: contestId,
    data: { locale: appState.locale, timeZone }
  });
  const entries = archiveEntries(manifest);
  const total = entries.filter(entry => "url" in entry).length;
  let done = 0;
  onProgress({ stage: "downloading", done, total });
  let index = 0;
  const zip = createZipStream({
    async pull(controller) {
      if (index === entries.length) return controller.close();
      const entry = entries[index++];
      if ("directory" in entry) controller.enqueue({ name: entry.path, directory: true });
      else if ("url" in entry) {
        const response = await fetch(entry.url);
        if (!response.ok) throw new Error(`${entry.path}: ${response.status} ${response.statusText}`);
        controller.enqueue({ name: entry.path, stream: () => response.body });
        onProgress({ stage: "downloading", done: ++done, total });
      } else {
        const blob = new Blob(["bytes" in entry ? entry.bytes : entry.text]);
        controller.enqueue({ name: entry.path, stream: () => blob.stream() });
      }
    }
  });
  if (total === 0) {
    // Everything is already here: one Blob, no service worker needed
    saveBlob(await new Response(zip).blob(), manifest.filename);
  } else await saveStream(zip, manifest.filename);
  return manifest;
}
