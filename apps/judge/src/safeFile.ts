/* eslint-disable no-bitwise */
import fs from "fs";
import path from "path";

/*
 * Opening files that sandboxed programs could have replaced. A program owns its writable directories while it runs,
 * so it can leave a symbolic link where the judge expects its output; following it would let a submission read or
 * overwrite the judge's other files (test data of every problem). These never follow a link.
 */

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants;

/**
 * Opens `relative` under the directory `root`, through directories only: no component may be a symbolic link.
 * `root` itself is one of the judge's own directories.
 */
export function openBeneathSync(root: string, relative: string, flags: number, mode = 0o660): number {
  const parts = relative.split("/").filter(part => part !== "");
  if (parts.length === 0 || parts.some(part => part === "." || part === ".."))
    throw new Error(`Invalid path under ${root}: ${relative}`);
  let directory = fs.openSync(root, O_RDONLY | O_DIRECTORY);
  try {
    for (const part of parts.slice(0, -1)) {
      const next = fs.openSync(`/proc/self/fd/${directory}/${part}`, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      fs.closeSync(directory);
      directory = next;
    }
    return fs.openSync(`/proc/self/fd/${directory}/${parts[parts.length - 1]}`, flags | O_NOFOLLOW, mode);
  } finally {
    fs.closeSync(directory);
  }
}

/** Opens a file for reading, unless it's a symbolic link (ELOOP) or not a regular file (EINVAL). */
export async function openRegularFile(filePath: string): Promise<fs.promises.FileHandle> {
  const file = await fs.promises.open(filePath, O_RDONLY | O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile())
      throw Object.assign(new Error(`${path.basename(filePath)} is not a regular file`), { code: "EINVAL" });
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Whether `filePath` is a regular file itself (not a symbolic link to one). */
export async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(filePath)).isFile();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}
