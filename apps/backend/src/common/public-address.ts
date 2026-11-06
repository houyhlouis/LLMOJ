import { BlockList, isIP } from "net";

/*
 * Whether an address is on the public Internet: outbound requests the server makes for its users (AI providers,
 * images in downloaded statements) may not reach this host or its private networks.
 */

// Addresses outside the public Internet (RFC 6890): this host, private and shared networks, link-local
// (including cloud metadata services), documentation/benchmark ranges, multicast and reserved space.
// IPv4 rules also match IPv4-mapped IPv6 addresses.
const nonPublicAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3]
] as const)
  nonPublicAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16]
] as const)
  nonPublicAddresses.addSubnet(network, prefix, "ipv6");
// Public IPv6 addresses are global unicast, IPv4-mapped or NAT64 (which never translates to private IPv4).
const publicIpv6Addresses = new BlockList();
publicIpv6Addresses.addSubnet("2000::", 3, "ipv6");
publicIpv6Addresses.addSubnet("::ffff:0:0", 96, "ipv6");
publicIpv6Addresses.addSubnet("64:ff9b::", 96, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !nonPublicAddresses.check(address, "ipv4");
  if (family === 6) return publicIpv6Addresses.check(address, "ipv6") && !nonPublicAddresses.check(address, "ipv6");
  return false;
}
