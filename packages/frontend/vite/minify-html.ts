import { minify, type Options } from "html-minifier-terser";

import type { Plugin } from "vite";

/** Minifies the built index.html, including its inline scripts and styles. */
export default function minifyHtml(options: Options): Plugin {
  return {
    name: "llmoj:minify-html",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: async html => await minify(html, options)
    }
  };
}
