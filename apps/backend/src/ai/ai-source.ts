/** Compare complete source links, including known alternate URLs for the same contest problem. */
function sourceIdentity(value: string): string | undefined {
  if (typeof value !== "string" || !value || value.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  if (!url.port && ["codeforces.com", "www.codeforces.com"].includes(host)) {
    const problem =
      url.pathname.match(/^\/problemset\/problem\/(\d+)\/([A-Za-z]\d*)\/?$/) ||
      url.pathname.match(/^\/contest\/(\d+)\/problem\/([A-Za-z]\d*)\/?$/);
    if (problem) return `codeforces:${problem[1]}:${problem[2].toUpperCase()}`;
  }
  if (!url.port && ["qoj.ac", "www.qoj.ac"].includes(host)) {
    const problem = url.pathname.match(/^\/(?:contest\/\d+\/)?problem\/(\d+)\/?$/);
    if (problem) return `qoj:${problem[1]}`;
  }
  if (
    !url.port &&
    ["atcoder.jp", "www.atcoder.jp"].includes(host) &&
    /^\/contests\/[^/]+\/tasks\/[^/]+\/?$/.test(url.pathname)
  ) {
    url.hostname = "atcoder.jp";
    url.hash = "";
    url.searchParams.delete("lang");
    url.pathname = url.pathname.replace(/\/$/, "");
  }
  // Unknown pages can use fragments or nonstandard ports to identify different content.
  return url.href;
}

/** Search adapters return result objects or MCP text blocks, never evidence in echoed request metadata. */
export function findVerifiedSourceUrl(candidate: string, references: string): string | undefined {
  const identity = sourceIdentity(candidate);
  if (!identity) return undefined;
  const urls = new Set<string>();
  const addUrl = (value: unknown) => {
    if (typeof value !== "string") return;
    const url = value.trim();
    if (/^https?:\/\/[^\s<>"`\\]+$/.test(url) && sourceIdentity(url)) urls.add(url);
  };
  const visitText = (value: string, depth: number) => {
    if (depth > 8) return;
    const text = value.trim();
    try {
      const decoded = JSON.parse(text);
      // eslint-disable-next-line @typescript-eslint/no-use-before-define -- The two traversal helpers recurse into each other after both are initialized.
      visit(decoded, depth + 1);
      // Do not also scan the serialized JSON: that would accept query echoes and shorten exact URL fields.
      return;
    } catch {
      // Do not recover links from truncated JSON, where their result/metadata context is unknown.
      if (text.startsWith("{") || /^\[\s*[[{"\]]/.test(text)) return;
    }
    if (/^https?:\/\/[^\s<>"`\\]+$/.test(text)) {
      addUrl(text);
      return;
    }
    // Here only prose/Markdown result content remains; remove punctuation closing a prose link.
    for (const match of text.matchAll(/https?:\/\/[^\s<>"`\\]+/g)) addUrl(match[0].replace(/[),.;\]}]+$/, ""));
  };
  const visit = (value: unknown, depth = 0) => {
    if (depth > 8) return;
    if (typeof value === "string") {
      visitText(value, depth + 1);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else if (value && typeof value === "object") {
      const item = value as Record<string, unknown>;
      // Tavily's adapted result array and nested MCP search results expose explicit result URLs.
      if (typeof item.url === "string") {
        addUrl(item.url);
        if (typeof item.content === "string") visitText(item.content, depth + 1);
      }
      if (item.type === "text" && typeof item.text === "string") visitText(item.text, depth + 1);
      for (const field of ["results", "result", "data", "structuredContent"])
        if (item[field] && typeof item[field] === "object") visit(item[field], depth + 1);
      if (Array.isArray(item.content)) visit(item.content, depth + 1);
      // Ignore query, answer, request, title and other metadata, even when they contain a URL.
    }
  };
  visitText(references, 0);
  return [...urls].find(url => sourceIdentity(url) === identity);
}
