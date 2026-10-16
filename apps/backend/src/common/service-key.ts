import { randomBytes } from "crypto";
import { constants, promises as fs } from "fs";
import path from "path";

/**
 * Load a 32-byte key from the backend's private state directory, creating it on first use. A missing key must
 * never silently replace one that protects stored data (`mustExist`).
 */
export async function loadServiceKey(
  directory: string,
  filename: string,
  label: string,
  mustExist: boolean
): Promise<Buffer> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // eslint-disable-next-line no-bitwise -- Combine filesystem flags without weakening NOFOLLOW protections.
  const directoryHandle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const directoryInfo = await directoryHandle.stat();
    if (!directoryInfo.isDirectory() || directoryInfo.uid !== process.geteuid())
      throw new Error(`${label} directory must be owned by the backend service user`);
    await directoryHandle.chmod(0o700);

    // Anchor to the checked directory inode, even if a privileged deployer renames its parent during startup.
    const keyPath = path.join(`/proc/self/fd/${directoryHandle.fd}`, filename);
    let handle;
    try {
      // eslint-disable-next-line no-bitwise -- Combine filesystem flags without weakening NOFOLLOW protections.
      handle = await fs.open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Cannot safely open ${label}`);
      if (mustExist)
        throw new Error(`${label} is missing; restore the original ${filename} before starting the backend`);
      try {
        handle = await fs.open(
          keyPath,
          // eslint-disable-next-line no-bitwise -- Combine filesystem flags without weakening NOFOLLOW protections.
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          0o600
        );
        const key = randomBytes(32);
        try {
          await handle.writeFile(key);
          await handle.sync();
        } finally {
          key.fill(0);
        }
        await directoryHandle.sync();
      } catch (createError) {
        if (handle) await handle.close();
        if (createError.code !== "EEXIST") throw new Error(`Cannot safely create ${label}`);
        // eslint-disable-next-line no-bitwise -- Combine filesystem flags without weakening NOFOLLOW protections.
        handle = await fs.open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      }
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.geteuid() || info.size !== 32)
        throw new Error(`${label} must be a service-owned, single-link regular 32-byte file`);
      await handle.chmod(0o600);
      const key = Buffer.alloc(32);
      const { bytesRead } = await handle.read(key, 0, key.length, 0);
      if (bytesRead !== 32) {
        key.fill(0);
        throw new Error(`Invalid ${label}`);
      }
      return key;
    } finally {
      await handle.close();
    }
  } finally {
    await directoryHandle.close();
  }
}
