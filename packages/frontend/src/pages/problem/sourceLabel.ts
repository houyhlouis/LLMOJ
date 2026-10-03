/** A readable fallback for manually entered/legacy source URLs without verified titles. */
export function sourceLabel(source: string, title: string): string {
  try {
    const url = new URL(source);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let identity: string;
    let match: RegExpMatchArray;
    if (
      ["luogu.com.cn", "luogu.com"].includes(host) &&
      (match = url.pathname.match(/^\/problem\/([A-Za-z]+\d+[A-Za-z0-9]*)\/?$/))
    )
      identity = `Luogu ${match[1]}`;
    else if (host === "qoj.ac" && (match = url.pathname.match(/\/problem\/(\d+)\/?$/))) identity = `QOJ ${match[1]}`;
    else if (
      host === "codeforces.com" &&
      (match = url.pathname.match(/^\/(?:problemset\/problem|contest)\/(\d+)\/(?:problem\/)?([A-Za-z]\d*)\/?$/))
    )
      identity = `Codeforces ${match[1]}${match[2].toUpperCase()}`;
    else if (host === "atcoder.jp" && (match = url.pathname.match(/\/tasks\/([A-Za-z0-9_]+)\/?$/)))
      identity = `AtCoder ${match[1]}`;
    else if (host === "usaco.org" && url.searchParams.get("cpid")) identity = `USACO ${url.searchParams.get("cpid")}`;
    return identity ? `${identity}${title.trim() ? ` ${title.trim()}` : ""}` : source;
  } catch {
    return source;
  }
}
