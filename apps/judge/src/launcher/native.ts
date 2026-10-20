/* eslint-disable prefer-destructuring */
import bindings from "bindings";

// The launcher's system calls (native/posix/launcher.cc), in the judge's posix addon
const posix = bindings("posix");

export interface ChannelHandle {
  send(data: Buffer, descriptors?: number[]): void;
  close(): void;
}

/** One end of a SOCK_SEQPACKET socket. `onMessage` gets each message, and (null, []) once the peer is gone. */
export const Channel: new (
  fd: number,
  onMessage: (data: Buffer | null, descriptors: number[]) => void
) => ChannelHandle = posix.Channel;

export interface AccountEntry {
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

export interface WalkOptions {
  // Only inodes owned by one of these change
  owners: number[];
  // The new owner (both, or neither)
  uid?: number;
  gid?: number;
  // Whether the modes replace the permission bits; otherwise they are added
  exact: boolean;
  directoryMode: number;
  fileMode: number;
}

export const seqpacketPair: () => [number, number] = posix.seqpacketPair;
export const listenUnix: (path: string) => number = posix.listenUnix;
export const noNewPrivileges: () => void = posix.noNewPrivileges;
export const userEntry: (name: string) => AccountEntry | null = posix.userEntry;
/** An O_PATH descriptor of `relative` under `root`, through directories only and no symbolic link. */
export const openDirectory: (root: string, relative: string) => number = posix.openDirectory;
/**
 * Changes owners and modes in the tree at a descriptor from `openDirectory`: directories and regular files only,
 * never through a link or onto another file system. Resolves with the number of changed inodes.
 */
export const walkOwnership: (fd: number, options: WalkOptions) => Promise<number> = posix.walkOwnership;

export function pipe(): { read: number; write: number } {
  const result = posix.pipe();
  posix.fcntl_set_cloexec(result.read, true);
  posix.fcntl_set_cloexec(result.write, true);
  return result;
}

export function setCloseOnExec(fd: number, closeOnExec: boolean) {
  posix.fcntl_set_cloexec(fd, closeOnExec);
}

export function closeDescriptor(fd: number) {
  posix.close(fd);
}
