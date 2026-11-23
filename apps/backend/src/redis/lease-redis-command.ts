import type Redis from "ioredis";

import { currentLockLeases } from "./lock-lease";

// Redis may process an already-dispatched command after a pause or reconnect. Check every enclosing
// lease on the server in the same script as the write. A reader's score is its individual expiry in ms.
const WRITE_IF_HELD = `
  local n = tonumber(ARGV[1])
  local time = redis.call("TIME")
  local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
  for i = 1, n do
    local token = ARGV[2 * i]
    if ARGV[2 * i + 1] == "reader" then
      local expiry = redis.call("ZSCORE", KEYS[i], token)
      if not expiry or tonumber(expiry) <= now then return i end
    elseif redis.call("GET", KEYS[i]) ~= token then
      return i
    end
  end
  local command = ARGV[2 * n + 2]
  local args = {}
  for i = n + 1, #KEYS do
    table.insert(args, KEYS[i])
    if command ~= "del" then table.insert(args, ARGV[n + 2 + i]) end
  end
  redis.call(command, unpack(args))
  return 0
`;

/** SET/MSET key-value pairs, DEL keys or PUBLISH channel-message, under the current operation's leases. */
export async function writeWithLockLeases(
  client: Redis,
  command: "set" | "mset" | "del" | "publish",
  ...args: string[]
): Promise<void> {
  const leases = currentLockLeases();
  if (!leases.length) {
    await (client[command] as (...values: string[]) => Promise<unknown>)(...args);
    return;
  }
  const keys = command === "del" ? args : args.filter((_, i) => i % 2 === 0);
  const values = command === "del" ? [] : args.filter((_, i) => i % 2 === 1);
  const failed = Number(
    await client.eval(
      WRITE_IF_HELD,
      leases.length + keys.length,
      ...leases.map(lease => lease.owner.key),
      ...keys,
      leases.length,
      ...leases.flatMap(({ owner }) => [owner.token, owner.reader ? "reader" : "exclusive"]),
      command,
      ...values
    )
  );
  if (failed) throw leases[failed - 1].lose(new Error("Redis refused a write by an expired lock owner"));
}
