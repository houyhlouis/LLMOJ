export function normalizeProblemSource(value: string): string {
  const source = (value || "").trim();
  try {
    const url = new URL(source);
    if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) return source;
    if (
      !url.port &&
      ["luogu.com.cn", "www.luogu.com.cn", "luogu.org", "www.luogu.org"].includes(url.hostname.toLowerCase())
    ) {
      const cf = url.pathname.match(/^\/problem\/CF(\d+)([A-Za-z]\d*)\/?$/i);
      if (cf) return `https://codeforces.com/problemset/problem/${cf[1]}/${cf[2].toUpperCase()}`;
    }
    if (!url.port && ["qoj.ac", "www.qoj.ac"].includes(url.hostname.toLowerCase())) {
      const match = url.pathname.match(/^\/(?:contest\/\d+\/)?problem\/(\d+)\/?$/);
      if (match) return `https://qoj.ac/problem/${match[1]}`;
    }
  } catch {
    /* A manually entered source may be descriptive text rather than a URL. */
  }
  return source;
}
export function problemSourceLabel(source: string, title = ""): string {
  let prefix = "";
  try {
    const u = new URL(normalizeProblemSource(source));
    const host = u.hostname.toLowerCase();
    const luoguMatch = u.pathname.match(/^\/problem\/([A-Za-z]+\d+)\/?$/);
    const qojMatch = u.pathname.match(/^\/problem\/(\d+)\/?$/);
    const cfMatch = u.pathname.match(
      /^\/(?:problemset\/problem\/(\d+)\/([A-Za-z]\d*)|contest\/(\d+)\/problem\/([A-Za-z]\d*))\/?$/
    );
    const atcoderMatch = u.pathname.match(/^\/contests\/[^/]+\/tasks\/([^/]+)\/?$/);
    if (["www.luogu.com.cn", "luogu.com.cn", "www.luogu.org", "luogu.org"].includes(host) && luoguMatch)
      prefix = `Luogu ${luoguMatch[1].toUpperCase()}`;
    else if (["qoj.ac", "www.qoj.ac"].includes(host) && qojMatch) prefix = `QOJ ${qojMatch[1]}`;
    else if (["codeforces.com", "www.codeforces.com"].includes(host) && cfMatch)
      prefix = `Codeforces ${cfMatch[1] || cfMatch[3]}${(cfMatch[2] || cfMatch[4]).toUpperCase()}`;
    else if (host === "atcoder.jp" && atcoderMatch) prefix = `AtCoder ${atcoderMatch[1].toUpperCase()}`;
    else prefix = u.hostname;
  } catch {
    return source;
  }
  return [prefix, title.trim()].filter(Boolean).join(" ");
}
