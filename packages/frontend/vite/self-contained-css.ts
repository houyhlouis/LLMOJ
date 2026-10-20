import type { Plugin } from "vite";

// A URL of another site (not a data: URL, whose base64 may contain "//")
const REMOTE = /^\s*(?:https?:)?\/\//i;
const REMOTE_IMPORT = /@import\s+(?:url\()?\s*["']?(?:https?:)?\/\/[^;]*;/g;

/**
 * The built stylesheets load nothing from other sites: an `@import` of a remote stylesheet (such as Fomantic UI's Google
 * Fonts, which the bundled Lato replaces) is removed, and a remaining reference to another site fails the build.
 */
export default function selfContainedCss(): Plugin {
  return {
    name: "llmoj:self-contained-css",
    enforce: "pre",
    transform(code, id) {
      if (!/\.(?:css|less)(?:$|\?)/.test(id) || !REMOTE_IMPORT.test(code)) return null;
      REMOTE_IMPORT.lastIndex = 0;
      return { code: code.replace(REMOTE_IMPORT, ""), map: null };
    },
    generateBundle(_, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset" || !file.fileName.endsWith(".css")) continue;
        const css = typeof file.source === "string" ? file.source : Buffer.from(file.source).toString("utf-8");
        const remote = [...css.matchAll(/url\(\s*["']?([^"')]+)/g)]
          .map(match => match[1])
          .find(url => REMOTE.test(url));
        if (remote || /@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//.test(css))
          this.error(
            `${file.fileName} refers to another site (${remote ?? "@import"}); the build must be self-contained`
          );
      }
    }
  };
}
