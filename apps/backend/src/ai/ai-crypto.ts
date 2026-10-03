import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { constants, promises as fs } from "fs";
import path from "path";

import { AiConfiguration } from "./ai.types";

/** Load the existing key in place; a missing key must never silently replace one protecting stored configuration. */
export async function loadAiEncryptionKey(directory: string, hasStoredConfiguration: boolean): Promise<Buffer> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // eslint-disable-next-line no-bitwise -- Combine filesystem flags without weakening NOFOLLOW protections.
  const directoryHandle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const directoryInfo = await directoryHandle.stat();
    if (!directoryInfo.isDirectory() || directoryInfo.uid !== process.geteuid())
      throw new Error("AI key directory must be owned by the backend service user");
    await directoryHandle.chmod(0o700);

    // Anchor to the checked directory inode, even if a privileged deployer renames its parent during startup.
    const filename = path.join(`/proc/self/fd/${directoryHandle.fd}`, "master.key");
    let handle;
    try {
      // eslint-disable-next-line no-bitwise -- Combine filesystem flags without weakening NOFOLLOW protections.
      handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("Cannot safely open AI encryption key");
      if (hasStoredConfiguration)
        throw new Error("AI encryption key is missing; restore the original master.key before starting the backend");
      try {
        handle = await fs.open(
          filename,
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
        if (createError.code !== "EEXIST") throw new Error("Cannot safely create AI encryption key");
        // eslint-disable-next-line no-bitwise -- Combine filesystem flags without weakening NOFOLLOW protections.
        handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      }
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.geteuid() || info.size !== 32)
        throw new Error("AI encryption key must be a service-owned, single-link regular 32-byte file");
      await handle.chmod(0o600);
      const key = Buffer.alloc(32);
      const { bytesRead } = await handle.read(key, 0, key.length, 0);
      if (bytesRead !== 32) {
        key.fill(0);
        throw new Error("Invalid AI encryption key");
      }
      return key;
    } finally {
      await handle.close();
    }
  } finally {
    await directoryHandle.close();
  }
}

/** Keep the original iv.tag.ciphertext format so saved LLM and search credentials require no migration. */
export function encryptAiConfiguration(key: Buffer, value: AiConfiguration): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString("base64")).join(".");
}

export function decryptAiConfiguration(key: Buffer, value: string): AiConfiguration {
  try {
    const parts = value.split(".");
    if (parts.length !== 3) throw new Error();
    const [iv, tag, ciphertext] = parts.map(part => {
      const decoded = Buffer.from(part, "base64");
      if (decoded.toString("base64") !== part) throw new Error();
      return decoded;
    });
    if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    try {
      return JSON.parse(plaintext.toString("utf8"));
    } finally {
      plaintext.fill(0);
    }
  } catch {
    // Do not expose parser excerpts, crypto internals, ciphertext, or plaintext in exceptions or logs.
    throw new Error("Invalid AI encrypted configuration");
  }
}
